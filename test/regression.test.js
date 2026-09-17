/**
 * One test per defect found in review. Each fails against the code as it was.
 *
 * The labelling case is the reason this file exists: the original suite had 63
 * tests and none of them drove the interactive loop, so a guard that could
 * never be true went unnoticed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { label } from "../eval/label.js";
import { run, itemFingerprint } from "../eval/run.js";
import { loadLabels, paths, readJsonl, readRunMeta, writeJsonl } from "../eval/dataset.js";
import { compare, evaluate } from "../eval/metrics.js";
import { parseProbability } from "../eval/adapters/openai.js";

async function scratch(items) {
  const root = await mkdtemp(join(tmpdir(), "regress-"));
  await writeJsonl(paths.items(root), items);
  return root;
}

/** A prompt that replays scripted keystrokes, then reports end-of-input. */
function scripted(keys) {
  const queue = [...keys];
  const asked = [];
  return {
    asked,
    prompt: async (text) => {
      asked.push(text);
      return queue.length ? queue.shift() : null;
    },
  };
}

const quiet = () => {};

test("labelling actually prompts and records the answers", async () => {
  // Was broken: `"ynsubq".includes("")` is true, so the input loop never ran
  // and every item was written as label: null without a prompt.
  const root = await scratch([
    { id: "a", state: "first" },
    { id: "b", state: "second" },
    { id: "c", state: "third" },
  ]);
  const { prompt, asked } = scripted(["y", "n", "y"]);

  const result = await label(root, { rater: "r1", question: "Urgent?", prompt, write: quiet });

  assert.ok(asked.length >= 3, `expected at least 3 prompts, got ${asked.length}`);
  assert.equal(result.labelled, 3);

  const labels = await loadLabels(root, "r1");
  assert.deepEqual([labels.get("a"), labels.get("b"), labels.get("c")], [1, 0, 1]);
  await rm(root, { recursive: true, force: true });
});

test("labelling records skip and unsure as no label, and quits on q", async () => {
  const root = await scratch([{ id: "a", state: "x" }, { id: "b", state: "y" }, { id: "c", state: "z" }]);
  const { prompt } = scripted(["s", "u", "q"]);

  const result = await label(root, { rater: "r1", question: "Q", prompt, write: quiet });

  assert.equal(result.labelled, 0);
  assert.equal(result.skipped, 2);
  assert.equal(result.quit, true);
  assert.equal((await loadLabels(root, "r1")).size, 0, "skips must not become labels");
  await rm(root, { recursive: true, force: true });
});

test("labelling reprompts on an unrecognised key rather than accepting it", async () => {
  const root = await scratch([{ id: "a", state: "x" }]);
  const { prompt, asked } = scripted(["z", "", "maybe", "y"]);

  const result = await label(root, { rater: "r1", question: "Q", prompt, write: quiet });

  assert.equal(asked.length, 4, "each bad key should cost one more prompt");
  assert.equal(result.labelled, 1);
  assert.equal((await loadLabels(root, "r1")).get("a"), 1);
  await rm(root, { recursive: true, force: true });
});

test("labelling stops when the input stream ends instead of looping forever", async () => {
  const root = await scratch([{ id: "a", state: "x" }]);
  const { prompt } = scripted([]); // immediately null

  const result = await label(root, { rater: "r1", question: "Q", prompt, write: quiet });

  assert.equal(result.quit, true);
  assert.equal(result.labelled, 0);
  await rm(root, { recursive: true, force: true });
});

test("labelling honours --limit", async () => {
  const root = await scratch([{ id: "a", state: "x" }, { id: "b", state: "y" }, { id: "c", state: "z" }]);
  const { prompt } = scripted(["y", "y", "y"]);

  const result = await label(root, { rater: "r1", question: "Q", limit: 2, prompt, write: quiet });

  assert.equal(result.labelled, 2);
  await rm(root, { recursive: true, force: true });
});

test("editing an item's content invalidates its cached prediction", async () => {
  // Was broken: the fingerprint covered the adapter and question but not the
  // item, so an edited item silently kept its old answer.
  const root = await scratch([{ id: "a", state: "ORIGINAL" }]);
  const seen = [];
  const adapter = {
    name: "stub",
    fingerprint: { system: "stub" },
    predict: async (item) => {
      seen.push(item.state);
      return { probability: item.state === "ORIGINAL" ? 0.9 : 0.1 };
    },
  };

  await run(root, adapter, { run: "r", question: "Q" });
  await writeJsonl(paths.items(root), [{ id: "a", state: "CHANGED" }]);
  await run(root, adapter, { run: "r", question: "Q" });

  assert.deepEqual(seen, ["ORIGINAL", "CHANGED"], "the changed item must be re-predicted");
  const rows = await readJsonl(paths.predictions(root, "r"));
  assert.equal(rows[0].probability, 0.1);
  await rm(root, { recursive: true, force: true });
});

test("an unchanged item is still served from cache", async () => {
  const root = await scratch([{ id: "a", state: "SAME" }]);
  let calls = 0;
  const adapter = { name: "stub", fingerprint: { system: "stub" }, predict: async () => (calls++, { probability: 0.5 }) };

  await run(root, adapter, { run: "r", question: "Q" });
  await run(root, adapter, { run: "r", question: "Q" });

  assert.equal(calls, 1);
  await rm(root, { recursive: true, force: true });
});

test("item fingerprints separate content, question and adapter", () => {
  const adapter = { name: "a", fingerprint: { system: "a" } };
  const base = itemFingerprint(adapter, "Q", { id: "x", state: "S" });

  assert.notEqual(base, itemFingerprint(adapter, "Q", { id: "x", state: "DIFFERENT" }));
  assert.notEqual(base, itemFingerprint(adapter, "DIFFERENT", { id: "x", state: "S" }));
  assert.notEqual(base, itemFingerprint({ name: "b", fingerprint: { system: "b" } }, "Q", { id: "x", state: "S" }));
  assert.equal(base, itemFingerprint(adapter, "Q", { id: "different-id", state: "S" }), "the id alone must not change it");
});

test("a run records the question and dataset it was produced against", async () => {
  const root = await scratch([{ id: "a", state: "x" }]);
  const adapter = { name: "stub", method: "native", fingerprint: {}, predict: async () => ({ probability: 0.5 }) };

  await run(root, adapter, { run: "r", question: "The question" });

  const meta = await readRunMeta(root, "r");
  assert.equal(meta.question, "The question");
  assert.equal(meta.method, "native");
  assert.ok(meta.datasetFingerprint, "a dataset fingerprint is needed to detect a changed set");
  await rm(root, { recursive: true, force: true });
});

test("progress survives an interrupted run", async () => {
  const root = await scratch(Array.from({ length: 25 }, (_, i) => ({ id: `i${i}`, state: `s${i}` })));
  let calls = 0;
  const adapter = {
    name: "stub",
    fingerprint: {},
    predict: async () => {
      if (++calls > 20) throw new Error("rate limited");
      return { probability: 0.5 };
    },
  };

  const summary = await run(root, adapter, { run: "r", question: "Q", concurrency: 1 });

  assert.equal(summary.predicted, 20);
  const rows = await readJsonl(paths.predictions(root, "r"));
  assert.equal(rows.filter((r) => typeof r.probability === "number").length, 20, "successful rows must be on disk");
  await rm(root, { recursive: true, force: true });
});

test("compare refuses a verdict below the sample floor", () => {
  // Was broken: with one row the bootstrap resamples the same value every
  // time, the interval collapses, and it read as decisive.
  const single = compare([0.9], [0.6], [1]);
  assert.equal(single.conclusive, false);
  assert.equal(single.significant, false);
  assert.equal(single.underpowered, true);
  assert.equal(single.degenerate, true);
  assert.ok(single.warnings.some((w) => /floor/.test(w)));

  assert.equal(compare([0.9, 0.8], [0.6, 0.5], [1, 1]).conclusive, false);
  assert.equal(compare(Array(29).fill(0.9), Array(29).fill(0.1), Array(29).fill(1)).conclusive, false);
});

test("compare still concludes once there are enough items", () => {
  const n = 80;
  const labels = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 1 : 0));
  const strong = labels.map((y) => (y ? 0.95 : 0.05));
  const weak = labels.map((y, i) => (i % 3 === 0 ? (y ? 0.1 : 0.9) : y ? 0.9 : 0.1));

  const result = compare(weak, strong, labels, { resamples: 400 });

  assert.equal(result.underpowered, false);
  assert.equal(result.conclusive, true);
  assert.deepEqual(result.warnings, []);
});

test("the tuned threshold is marked in-sample and paired with a held-out figure", () => {
  let s = 3;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff), s / 0x7fffffff);
  const labels = [];
  const predictions = [];
  for (let i = 0; i < 100; i++) {
    const y = rnd() < 0.4 ? 1 : 0;
    labels.push(y);
    predictions.push(y ? 0.3 + rnd() * 0.6 : rnd() * 0.7); // deliberately overlapping
  }

  const result = evaluate(predictions, labels, { resamples: 200 });

  assert.equal(result.best.inSample, true);
  assert.ok(Number.isFinite(result.heldOut.f1));
  assert.equal(result.heldOut.folds, 5);
  assert.ok(result.heldOut.f1 <= result.best.f1 + 1e-9, "held-out F1 cannot beat the in-sample optimum");
});

test("evaluate flags an underpowered sample", () => {
  const small = evaluate([0.9, 0.2, 0.8], [1, 0, 1], { resamples: 100 });
  assert.equal(small.underpowered, true);
});

test("the parser no longer coerces malformed replies", () => {
  // Every one of these returned a plausible-looking wrong number before.
  assert.throws(() => parseProbability("-0.8"), /expected a bare probability/, "a negative must not lose its sign");
  assert.throws(() => parseProbability("1.5"), /expected a value in \[0,1\]/, "1.5 must not be rescaled to 0.015");
  assert.equal(parseProbability("1%"), 0.01, "1% is one percent, not one");
  assert.throws(() => parseProbability("85"), /expected a value in \[0,1\]/, "a bare 85 is ambiguous");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { align, loadConsensus, loadItems, paths, readJsonl, writeJsonl } from "../eval/dataset.js";
import { run } from "../eval/run.js";
import { createAdapter } from "../eval/adapters/index.js";
import { parseProbability } from "../eval/adapters/openai.js";

async function scratch(items) {
  const root = await mkdtemp(join(tmpdir(), "eval-"));
  await writeJsonl(paths.items(root), items);
  return root;
}

const sample = [
  { id: "a", state: "first" },
  { id: "b", state: "second" },
  { id: "c", state: "third" },
];

test("loadItems rejects duplicates, blanks and missing ids", async () => {
  const dup = await scratch([{ id: "a", state: "x" }, { id: "a", state: "y" }]);
  await assert.rejects(() => loadItems(dup), /duplicate item id/);

  const blank = await scratch([{ id: "a", state: "" }]);
  await assert.rejects(() => loadItems(blank), /has no state/);

  const noId = await scratch([{ state: "x" }]);
  await assert.rejects(() => loadItems(noId), /has no id/);

  await Promise.all([dup, blank, noId].map((d) => rm(d, { recursive: true, force: true })));
});

test("a later label for the same item supersedes the earlier one", async () => {
  const root = await scratch(sample);
  await writeJsonl(paths.labels(root, "rater-1"), [
    { id: "a", label: 0 },
    { id: "a", label: 1 },
  ]);

  const { labels } = await loadConsensus(root);
  assert.equal(labels.get("a"), 1);
  await rm(root, { recursive: true, force: true });
});

test("consensus keeps agreement and excludes disputes", async () => {
  const root = await scratch(sample);
  await writeJsonl(paths.labels(root, "rater-1"), [{ id: "a", label: 1 }, { id: "b", label: 0 }, { id: "c", label: 1 }]);
  await writeJsonl(paths.labels(root, "rater-2"), [{ id: "a", label: 1 }, { id: "b", label: 1 }]);

  const { labels, disputed, raters } = await loadConsensus(root);

  assert.deepEqual(raters.sort(), ["rater-1", "rater-2"]);
  assert.equal(labels.get("a"), 1);
  assert.equal(labels.get("c"), 1, "an item only one rater saw still counts");
  assert.deepEqual(disputed, ["b"]);
  await rm(root, { recursive: true, force: true });
});

test("skipped labels are ignored", async () => {
  const root = await scratch(sample);
  await writeJsonl(paths.labels(root, "rater-1"), [{ id: "a", label: null }, { id: "b", label: 1 }]);

  const { labels } = await loadConsensus(root);
  assert.equal(labels.has("a"), false);
  assert.equal(labels.get("b"), 1);
  await rm(root, { recursive: true, force: true });
});

test("align keeps only items every system and the labels cover", () => {
  const labels = new Map([["a", 1], ["b", 0], ["c", 1]]);
  const first = new Map([["a", 0.9], ["b", 0.2], ["c", 0.7]]);
  const second = new Map([["a", 0.8], ["c", 0.6]]); // missing b

  const result = align(sample, labels, [first, second]);

  assert.deepEqual(result.ids, ["a", "c"]);
  assert.deepEqual(result.labels, [1, 1]);
  assert.deepEqual(result.predictions, [[0.9, 0.7], [0.8, 0.6]]);
});

test("align preserves dataset order so runs line up", () => {
  const labels = new Map([["c", 1], ["a", 0]]);
  const predictions = new Map([["c", 0.3], ["a", 0.4]]);
  assert.deepEqual(align(sample, labels, [predictions]).ids, ["a", "c"]);
});

test("run records one probability per item", async () => {
  const root = await scratch(sample);
  const adapter = {
    name: "stub",
    fingerprint: { system: "stub" },
    predict: async (item) => ({ probability: item.id === "a" ? 0.9 : 0.1 }),
  };

  const summary = await run(root, adapter, { run: "stub", question: "Is it urgent?" });

  assert.equal(summary.predicted, 3);
  assert.equal(summary.errors.length, 0);
  const rows = await readJsonl(paths.predictions(root, "stub"));
  assert.deepEqual(rows.map((r) => r.id), ["a", "b", "c"]);
  assert.equal(rows[0].probability, 0.9);
  await rm(root, { recursive: true, force: true });
});

test("a rerun reuses cached rows and a changed question invalidates them", async () => {
  const root = await scratch(sample);
  let calls = 0;
  const adapter = {
    name: "stub",
    fingerprint: { system: "stub" },
    predict: async () => (calls++, { probability: 0.5 }),
  };

  await run(root, adapter, { run: "stub", question: "Q1" });
  assert.equal(calls, 3);

  const second = await run(root, adapter, { run: "stub", question: "Q1" });
  assert.equal(calls, 3, "nothing should be re-requested");
  assert.equal(second.fromCache, 3);

  await run(root, adapter, { run: "stub", question: "Q2 — different question" });
  assert.equal(calls, 6, "a different question must invalidate the cache");

  await rm(root, { recursive: true, force: true });
});

test("run isolates a failing item instead of aborting the batch", async () => {
  const root = await scratch(sample);
  const adapter = {
    name: "stub",
    fingerprint: { system: "stub" },
    predict: async (item) => {
      if (item.id === "b") throw new Error("upstream exploded");
      return { probability: 0.5 };
    },
  };

  const summary = await run(root, adapter, { run: "stub", question: "Q" });

  assert.equal(summary.predicted, 2);
  assert.deepEqual(summary.errors, [{ id: "b", error: "upstream exploded" }]);
  await rm(root, { recursive: true, force: true });
});

test("run rejects an out-of-range probability", async () => {
  const root = await scratch([{ id: "a", state: "x" }]);
  const adapter = { name: "stub", fingerprint: {}, predict: async () => ({ probability: 1.4 }) };

  const summary = await run(root, adapter, { run: "stub", question: "Q" });
  assert.match(summary.errors[0].error, /out of range/);
  await rm(root, { recursive: true, force: true });
});

test("run demands a question", async () => {
  const root = await scratch(sample);
  await assert.rejects(
    () => run(root, { name: "s", fingerprint: {}, predict: async () => ({}) }, { run: "s", question: "  " }),
    /question is required/,
  );
  await rm(root, { recursive: true, force: true });
});

test("adapter specs parse into options", () => {
  const adapter = createAdapter("openai:model=gpt-4o-mini,mode=verbalized,apiKey=test");
  assert.equal(adapter.name, "openai:gpt-4o-mini:verbalized");
  assert.throws(() => createAdapter("telepathy"), /unknown system/);
});

test("verbalized replies parse strictly", () => {
  assert.equal(parseProbability("0.85"), 0.85);
  assert.equal(parseProbability("  0.9  "), 0.9);
  assert.equal(parseProbability("0"), 0);
  assert.equal(parseProbability("1"), 1);
  assert.equal(parseProbability("85%"), 0.85);
  assert.equal(parseProbability("100%"), 1);
  assert.equal(parseProbability("0.42."), 0.42, "a trailing full stop is tolerated");

  // Anything ambiguous is rejected rather than coerced — see regression tests.
  assert.throws(() => parseProbability("maybe?"), /expected a bare probability/);
  assert.throws(() => parseProbability("140%"), /out of range/);
  assert.throws(() => parseProbability("Probability: 0.42"), /expected a bare probability/);
});

test("README example rater names are placeholders", async () => {
  // Docs hygiene: the label flow needs two raters, and it is easy to reach for
  // two colleagues' names when writing the example. Keep them generic.
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const raters = [...readme.matchAll(/--rater\s+(\S+)/g)].map((match) => match[1]);

  assert.ok(raters.length > 0, "the README should document --rater");
  for (const rater of raters) {
    assert.match(rater, /^rater-\d+$/, `"${rater}" should be a placeholder such as rater-1`);
  }
});

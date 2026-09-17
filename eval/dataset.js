/**
 * Dataset layout and JSONL plumbing.
 *
 *   <dataset>/items.jsonl              { id, state, meta? }
 *   <dataset>/labels/<rater>.jsonl     { id, label, note?, at }
 *   <dataset>/predictions/<run>.jsonl  { id, probability, raw?, error? }
 *
 * Labels live per rater rather than on the item so two people can label the
 * same set independently; agreement between them bounds how small a
 * difference the eval can honestly resolve.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const paths = {
  items: (root) => join(root, "items.jsonl"),
  labels: (root, rater) => join(root, "labels", `${rater}.jsonl`),
  labelDir: (root) => join(root, "labels"),
  predictions: (root, run) => join(root, "predictions", `${run}.jsonl`),
  predictionDir: (root) => join(root, "predictions"),
  reports: (root) => join(root, "reports"),
};

export async function readJsonl(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return text
    .split("\n")
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => line && !line.startsWith("//"))
    .map(({ line, index }) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${path}:${index + 1} is not valid JSON — ${error.message}`);
      }
    });
}

export async function writeJsonl(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

/** Appends without rewriting what is already there. */
export async function appendJsonl(path, rows) {
  if (!rows.length) return;
  const existing = await readJsonl(path);
  await writeJsonl(path, [...existing, ...rows]);
}

/** Every item, validated. Throws on the mistakes that silently skew a run. */
export async function loadItems(root) {
  const items = await readJsonl(paths.items(root));
  if (!items.length) throw new Error(`no items found at ${paths.items(root)}`);

  const seen = new Set();
  for (const [index, item] of items.entries()) {
    if (!item.id) throw new Error(`item ${index + 1} has no id`);
    if (seen.has(item.id)) throw new Error(`duplicate item id "${item.id}" — ids must be unique`);
    seen.add(item.id);
    if (item.state === undefined || item.state === null || item.state === "") {
      throw new Error(`item "${item.id}" has no state`);
    }
  }
  return items;
}

/** Rater names with a label file present. */
export async function listRaters(root) {
  try {
    const files = await readdir(paths.labelDir(root));
    return files.filter((name) => name.endsWith(".jsonl")).map((name) => name.replace(/\.jsonl$/, ""));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

/** One rater's labels as a Map, last entry winning so a relabel corrects. */
export async function loadLabels(root, rater) {
  const rows = await readJsonl(paths.labels(root, rater));
  const byId = new Map();
  for (const row of rows) {
    if (row.label !== 0 && row.label !== 1) continue; // skipped items carry null
    byId.set(row.id, row.label);
  }
  return byId;
}

/**
 * Consensus labels across raters. An item both raters labelled but disagreed
 * on is excluded rather than averaged — a coin-flip label is worse than none.
 * @returns {{labels: Map<string, 0|1>, disputed: string[], raters: string[]}}
 */
export async function loadConsensus(root, only) {
  const raters = only?.length ? only : await listRaters(root);
  const perRater = await Promise.all(raters.map((rater) => loadLabels(root, rater)));

  const labels = new Map();
  const disputed = [];
  const ids = new Set(perRater.flatMap((map) => [...map.keys()]));

  for (const id of ids) {
    const votes = perRater.map((map) => map.get(id)).filter((v) => v !== undefined);
    if (votes.every((v) => v === votes[0])) labels.set(id, votes[0]);
    else disputed.push(id);
  }
  return { labels, disputed, raters };
}

/** Predictions as a Map from item id to probability. */
export async function loadPredictions(root, run) {
  const rows = await readJsonl(paths.predictions(root, run));
  const byId = new Map();
  for (const row of rows) {
    if (typeof row.probability === "number") byId.set(row.id, row.probability);
  }
  return byId;
}

/** Runs present for a dataset. */
export async function listRuns(root) {
  try {
    const files = await readdir(paths.predictionDir(root));
    return files.filter((name) => name.endsWith(".jsonl")).map((name) => name.replace(/\.jsonl$/, ""));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Aligns labels and one or more prediction sets onto the same items, in a
 * fixed order. Anything missing from any set is dropped, so every system is
 * scored on exactly the same rows.
 */
export function align(items, labels, predictionSets) {
  const ids = [];
  const aligned = predictionSets.map(() => []);
  const y = [];

  for (const item of items) {
    if (!labels.has(item.id)) continue;
    if (predictionSets.some((set) => !set.has(item.id))) continue;
    ids.push(item.id);
    y.push(labels.get(item.id));
    predictionSets.forEach((set, i) => aligned[i].push(set.get(item.id)));
  }
  return { ids, labels: y, predictions: aligned };
}

/** Stable hash of the inputs that determine a prediction, for cache reuse. */
export function fingerprint(parts) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

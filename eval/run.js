/**
 * Runs an adapter over a dataset and records one probability per item.
 *
 * Each row carries a fingerprint of everything that could change the answer —
 * the adapter, the question, and the item's own content. Editing an item while
 * keeping its id therefore invalidates only that row. An earlier version
 * fingerprinted the run but not the item, so an edited item silently kept the
 * prediction made for its previous content.
 *
 * Rows are flushed as they complete, so an interrupted run keeps its progress.
 */

import { fingerprint, loadItems, paths, readJsonl, writeJsonl, writeRunMeta } from "./dataset.js";

const FLUSH_EVERY = 10;

/** Everything that determines a single prediction. */
export function itemFingerprint(adapter, question, item) {
  return fingerprint({ adapter: adapter.fingerprint ?? adapter.name, question, state: item.state });
}

/**
 * @param {string} root Dataset directory.
 * @param {object} adapter From createAdapter().
 * @param {object} options
 * @param {string} options.run Name this prediction set is filed under.
 * @param {string} options.question The question, identical for every system.
 * @param {number} [options.concurrency]
 * @param {boolean} [options.force] Ignore cached rows and redo everything.
 * @param {number} [options.limit]
 * @param {(progress: object) => void} [options.onProgress]
 */
export async function run(root, adapter, { run: runName, question, concurrency = 4, force = false, limit, onProgress }) {
  if (!question?.trim()) throw new Error("a question is required, and must be identical across systems");

  const items = (await loadItems(root)).slice(0, limit ?? Infinity);
  const path = paths.predictions(root, runName);

  const existing = new Map();
  if (!force) {
    for (const row of await readJsonl(path)) {
      if (typeof row.probability === "number" && row.fingerprint) existing.set(row.id, row);
    }
  }

  // Keep a cached row only if it was produced for this exact item content.
  const results = new Map();
  const todo = [];
  for (const item of items) {
    const stamp = itemFingerprint(adapter, question, item);
    const cached = existing.get(item.id);
    if (cached && cached.fingerprint === stamp) results.set(item.id, cached);
    else todo.push({ item, stamp });
  }

  const errors = [];
  let done = 0;
  let writing = Promise.resolve();

  const ordered = () => items.map((item) => results.get(item.id)).filter(Boolean);
  const flush = () => {
    writing = writing.then(() => writeJsonl(path, ordered()));
    return writing;
  };

  const queue = todo[Symbol.iterator]();
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, todo.length)) }, async () => {
    for (const { item, stamp } of queue) {
      try {
        const { probability, raw } = await adapter.predict(item, { question });
        if (typeof probability !== "number" || !(probability >= 0 && probability <= 1)) {
          throw new Error(`probability out of range: ${probability}`);
        }
        results.set(item.id, { id: item.id, probability, raw, fingerprint: stamp });
      } catch (error) {
        errors.push({ id: item.id, error: error.message });
        results.set(item.id, { id: item.id, probability: null, error: error.message, fingerprint: stamp });
      }
      done++;
      if (done % FLUSH_EVERY === 0) await flush();
      onProgress?.({ done, total: todo.length, id: item.id });
    }
  });

  try {
    await Promise.all(workers);
  } finally {
    await flush();
  }

  const summary = {
    run: runName,
    path,
    adapter: adapter.name,
    method: adapter.method ?? "unspecified",
    question,
    datasetFingerprint: fingerprint(items.map((item) => [item.id, item.state])),
    total: items.length,
    fromCache: results.size - (todo.length - errors.length),
    predicted: todo.length - errors.length,
    failed: errors.length,
    errors,
    at: new Date().toISOString(),
  };
  await writeRunMeta(root, runName, { ...summary, errors: errors.slice(0, 50) });
  return summary;
}

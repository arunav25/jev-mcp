/**
 * Runs an adapter over a dataset and records one probability per item.
 *
 * Results are keyed by item id and a fingerprint of everything that could
 * change the answer (system, model, question text). Re-running resumes rather
 * than repeating, so a rate limit halfway through an 800-item set costs
 * nothing but the time already spent.
 */

import { fingerprint, loadItems, paths, readJsonl, writeJsonl } from "./dataset.js";

/**
 * @param {string} root Dataset directory.
 * @param {object} adapter From createAdapter().
 * @param {object} options
 * @param {string} options.run Name this prediction set is filed under.
 * @param {string} options.question The noul instructions, identical for every system.
 * @param {number} [options.concurrency]
 * @param {boolean} [options.force] Ignore cached rows and redo everything.
 * @param {number} [options.limit]
 * @param {(progress: object) => void} [options.onProgress]
 */
export async function run(root, adapter, { run: runName, question, concurrency = 4, force = false, limit, onProgress }) {
  if (!question?.trim()) throw new Error("a question is required, and must be identical across systems");

  const items = (await loadItems(root)).slice(0, limit ?? Infinity);
  const stamp = fingerprint({ ...adapter.fingerprint, question });
  const path = paths.predictions(root, runName);

  const existing = new Map();
  if (!force) {
    for (const row of await readJsonl(path)) {
      if (row.fingerprint === stamp && typeof row.probability === "number") existing.set(row.id, row);
    }
  }

  const todo = items.filter((item) => !existing.has(item.id));
  const results = new Map(existing);
  const errors = [];
  let done = 0;

  const queue = todo[Symbol.iterator]();
  const workers = Array.from({ length: Math.min(concurrency, todo.length) }, async () => {
    for (const item of queue) {
      try {
        const { probability, raw } = await adapter.predict(item, { question });
        if (!(probability >= 0 && probability <= 1)) {
          throw new Error(`probability out of range: ${probability}`);
        }
        results.set(item.id, { id: item.id, probability, raw, fingerprint: stamp });
      } catch (error) {
        errors.push({ id: item.id, error: error.message });
        results.set(item.id, { id: item.id, probability: null, error: error.message, fingerprint: stamp });
      }
      onProgress?.({ done: ++done, total: todo.length, id: item.id });
    }
  });

  await Promise.all(workers);

  // Preserve dataset order so two runs line up on inspection.
  const ordered = items.map((item) => results.get(item.id)).filter(Boolean);
  await writeJsonl(path, ordered);

  return {
    run: runName,
    path,
    adapter: adapter.name,
    total: items.length,
    fromCache: existing.size,
    predicted: todo.length - errors.length,
    errors,
  };
}

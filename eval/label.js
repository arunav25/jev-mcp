/**
 * Interactive labelling.
 *
 * The labeller never sees any system's prediction — ground truth collected
 * after seeing a model's answer is not ground truth. Progress is written
 * after every keystroke, so quitting half way loses nothing.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { appendJsonl, loadLabels, loadItems, paths } from "./dataset.js";
import { rng } from "./stats.js";

const KEYS = `
  y  yes, the condition holds        n  no, it does not
  s  skip this item                  u  unsure — records no label
  b  show the item again             q  save and quit
`;

/**
 * @param {string} root Dataset directory.
 * @param {object} options
 * @param {string} options.rater Name the labels are filed under.
 * @param {string} options.question Shown above every item.
 * @param {number} [options.limit] Stop after this many new labels.
 * @param {boolean} [options.shuffle] Randomise order to blunt ordering effects.
 * @param {number} [options.seed]
 */
export async function label(root, { rater, question, limit = Infinity, shuffle = false, seed = 42 }) {
  if (!rater) throw new Error("a rater name is required: labels are filed per person so agreement can be measured");

  const items = await loadItems(root);
  const done = await loadLabels(root, rater);
  let queue = items.filter((item) => !done.has(item.id));

  if (shuffle) {
    const next = rng(seed);
    queue = queue
      .map((item) => ({ item, key: next() }))
      .sort((a, b) => a.key - b.key)
      .map(({ item }) => item);
  }

  if (!queue.length) {
    console.log(`Nothing left to label — ${rater} has covered all ${items.length} items.`);
    return { labelled: 0, remaining: 0 };
  }

  console.log(`\n${question}\n`);
  console.log(`${queue.length} unlabelled of ${items.length}. Keys:${KEYS}`);

  const rl = createInterface({ input: stdin, output: stdout });
  const pending = [];
  let labelled = 0;

  try {
    for (const item of queue) {
      if (labelled >= limit) break;

      let answer = "";
      while (!"ynsubq".includes(answer)) {
        console.log(`\n${"─".repeat(72)}`);
        console.log(render(item.state));
        console.log(`${"─".repeat(72)}`);
        answer = (await rl.question(`[${labelled + 1}/${Math.min(limit, queue.length)}] ${item.id} — y/n/s/u/b/q: `))
          .trim()
          .toLowerCase()
          .charAt(0);
        if (answer === "b") answer = "";
      }

      if (answer === "q") break;
      const value = answer === "y" ? 1 : answer === "n" ? 0 : null;
      pending.push({ id: item.id, label: value, at: new Date().toISOString() });
      if (value !== null) labelled++;

      // Flush often; a crash should never cost more than one decision.
      await appendJsonl(paths.labels(root, rater), pending.splice(0));
    }
  } finally {
    rl.close();
    if (pending.length) await appendJsonl(paths.labels(root, rater), pending);
  }

  const remaining = queue.length - labelled;
  console.log(`\nSaved ${labelled} label(s) for ${rater}. ${remaining} item(s) still unlabelled.`);
  return { labelled, remaining };
}

/** Renders an item's state readably whether it is prose or structured. */
function render(state) {
  if (typeof state === "string") return state;
  return Object.entries(state)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("\n");
}

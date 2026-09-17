/**
 * Interactive labelling.
 *
 * The labeller never sees any system's prediction — ground truth collected
 * after seeing a model's answer is not ground truth. Progress is written
 * after every decision, so quitting half way loses nothing.
 *
 * The prompt is injected rather than hard-wired to readline, so the decision
 * loop can be driven by a test. An earlier version guarded the loop with
 * `"ynsubq".includes(answer)` seeded from an empty string; because
 * `String.includes("")` is always true, the loop never ran and every item was
 * silently filed as unlabelled. Nothing in the suite exercised this path.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { appendJsonl, loadLabels, loadItems, paths } from "./dataset.js";
import { rng } from "./stats.js";

/** Accepted keystrokes. Membership is tested against this, never a substring. */
export const ANSWERS = Object.freeze({
  y: { label: 1, describe: "yes" },
  n: { label: 0, describe: "no" },
  s: { label: null, describe: "skip" },
  u: { label: null, describe: "unsure" },
  b: { label: undefined, describe: "show again" },
  q: { label: undefined, describe: "quit" },
});

const KEYS = `
  y  yes, the condition holds        n  no, it does not
  s  skip this item                  u  unsure — records no label
  b  show the item again             q  save and quit
`;

/** Default prompt: one line on the terminal. */
function terminalPrompt(rl) {
  return async (text) => {
    const raw = await rl.question(text);
    return raw === undefined || raw === null ? null : raw;
  };
}

/**
 * @param {string} root Dataset directory.
 * @param {object} options
 * @param {string} options.rater Name the labels are filed under.
 * @param {string} options.question Shown above every item.
 * @param {number} [options.limit] Stop after this many new labels.
 * @param {boolean} [options.shuffle] Randomise order to blunt ordering effects.
 * @param {number} [options.seed]
 * @param {(text: string) => Promise<string|null>} [options.prompt] Injected for tests.
 *   Returning null means the input stream ended — treated as quit.
 * @param {(line: string) => void} [options.write] Injected for tests.
 */
export async function label(root, {
  rater, question, limit = Infinity, shuffle = false, seed = 42, prompt, write = console.log,
}) {
  if (!rater) throw new Error("a rater name is required: labels are filed per person so agreement can be measured");
  if (!question?.trim()) throw new Error("a question is required");

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
    write(`Nothing left to label — ${rater} has covered all ${items.length} items.`);
    return { labelled: 0, skipped: 0, remaining: 0, quit: false };
  }

  const rl = prompt ? null : createInterface({ input: stdin, output: stdout });
  const ask = prompt ?? terminalPrompt(rl);

  write(`\n${question}\n`);
  write(`${queue.length} unlabelled of ${items.length}. Keys:${KEYS}`);

  const target = Math.min(limit, queue.length);
  let labelled = 0;
  let skipped = 0;
  let quit = false;

  try {
    for (const item of queue) {
      if (labelled >= limit) break;

      const choice = await askUntilValid(ask, write, item, labelled, target);
      if (choice === "q") {
        quit = true;
        break;
      }

      const { label: value } = ANSWERS[choice];
      if (value === null) skipped++;
      else labelled++;

      // Flushed per decision: a crash costs at most the item in hand.
      await appendJsonl(paths.labels(root, rater), [
        { id: item.id, label: value, rater, at: new Date().toISOString() },
      ]);
    }
  } finally {
    rl?.close();
  }

  const remaining = queue.length - labelled - skipped;
  write(`\nSaved ${labelled} label(s)${skipped ? ` and ${skipped} skip(s)` : ""} for ${rater}. ${remaining} item(s) still unlabelled.`);
  return { labelled, skipped, remaining, quit };
}

/** Shows the item and reprompts until a recognised key arrives. */
async function askUntilValid(ask, write, item, labelled, target) {
  for (;;) {
    write(`\n${"─".repeat(72)}`);
    write(render(item.state));
    write("─".repeat(72));

    const raw = await ask(`[${labelled + 1}/${target}] ${item.id} — y/n/s/u/b/q: `);
    // A closed stream (Ctrl-D, piped input exhausted) means stop, not loop.
    if (raw === null || raw === undefined) return "q";

    const key = String(raw).trim().toLowerCase().charAt(0);
    if (key && key !== "b" && Object.hasOwn(ANSWERS, key)) return key;
    if (key !== "b") write(`  "${String(raw).trim()}" is not one of y/n/s/u/b/q.`);
  }
}

/** Renders an item's state readably whether it is prose or structured. */
function render(state) {
  if (typeof state === "string") return state;
  return Object.entries(state)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("\n");
}

#!/usr/bin/env node
/**
 * Evaluation harness CLI.
 *
 * The question text lives in the dataset's config.json rather than being
 * passed per command, because a comparison is only fair if every system was
 * asked exactly the same thing.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";

import { align, listRaters, listRuns, loadConsensus, loadItems, loadLabels, loadPredictions, paths, writeJsonl } from "../eval/dataset.js";
import { cohensKappa, compare, evaluate } from "../eval/metrics.js";
import { pairedSampleSize } from "../eval/stats.js";
import { renderComparison, renderPower, renderScore } from "../eval/report.js";
import { createAdapter } from "../eval/adapters/index.js";
import { label } from "../eval/label.js";
import { run } from "../eval/run.js";

const configPath = (root) => join(root, "config.json");

async function readConfig(root) {
  try {
    return JSON.parse(await readFile(configPath(root), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`no config.json in ${root} — run \`eval init ${root}\` first`);
    throw error;
  }
}

async function saveReport(root, name, body) {
  await mkdir(paths.reports(root), { recursive: true });
  const path = join(paths.reports(root), name);
  await writeFile(path, body, "utf8");
  return path;
}

const program = new Command();
program.name("eval").description("Measure whether one judgment system actually beats another").showHelpAfterError();

program
  .command("init <dataset>")
  .description("scaffold a dataset directory with a config and example items")
  .requiredOption("-q, --question <text>", "the noul question, used verbatim by every system")
  .action(async (root, options) => {
    await mkdir(root, { recursive: true });
    await writeFile(
      configPath(root),
      JSON.stringify({ question: options.question, criteria: null, threshold: 0.5 }, null, 2) + "\n",
    );
    await writeJsonl(paths.items(root), [
      { id: "example-001", state: { subject: "Payouts failing", body: "Help! My payouts have been failing for 3 days." } },
      { id: "example-002", state: { subject: "Pricing question", body: "What's the difference between the Pro and Team plans?" } },
    ]);
    console.log(`Created ${root}/`);
    console.log(`  config.json   question: ${options.question}`);
    console.log(`  items.jsonl   2 example items — replace with your own`);
    console.log(`\nNext: add items, then \`eval label ${root} --rater <you>\``);
  });

program
  .command("label <dataset>")
  .description("label items by hand, without seeing any system's answer")
  .requiredOption("-r, --rater <name>", "whose labels these are")
  .option("-l, --limit <n>", "stop after this many", Number)
  .option("--shuffle", "randomise order")
  .action(async (root, options) => {
    const config = await readConfig(root);
    await label(root, {
      rater: options.rater,
      question: config.question,
      limit: options.limit ?? Infinity,
      shuffle: Boolean(options.shuffle),
    });
  });

program
  .command("run <dataset>")
  .description("collect predictions from one system")
  .requiredOption("-s, --system <spec>", 'e.g. "jev", "openai:model=gpt-4o-mini,mode=logprobs", "anthropic"')
  .option("-n, --run <name>", "file the predictions under this name (defaults to the system name)")
  .option("-c, --concurrency <n>", "parallel requests", Number, 4)
  .option("-l, --limit <n>", "only the first n items", Number)
  .option("-f, --force", "ignore cached predictions")
  .action(async (root, options) => {
    const config = await readConfig(root);
    const adapter = createAdapter(options.system);
    const runName = options.run || adapter.name.replace(/[^a-z0-9._-]+/gi, "-");

    console.error(`${adapter.describe()}`);
    const summary = await run(root, adapter, {
      run: runName,
      question: config.question,
      concurrency: options.concurrency,
      limit: options.limit,
      force: Boolean(options.force),
      onProgress: ({ done, total }) => {
        if (done % 10 === 0 || done === total) process.stderr.write(`\r  ${done}/${total}`);
      },
    });
    process.stderr.write("\r");

    console.log(`${summary.predicted} predicted, ${summary.fromCache} reused from cache, ${summary.errors.length} failed`);
    if (summary.errors.length) {
      for (const { id, error } of summary.errors.slice(0, 5)) console.log(`  ✗ ${id}: ${error}`);
      if (summary.errors.length > 5) console.log(`  … ${summary.errors.length - 5} more`);
    }
    console.log(`Saved to ${summary.path}`);
  });

program
  .command("score <dataset>")
  .description("score one run against the labels")
  .requiredOption("-n, --run <name>", "which prediction set")
  .option("--rater <name>", "use one rater's labels instead of the consensus", (v, all) => [...all, v], [])
  .action(async (root, options) => {
    const items = await loadItems(root);
    const { labels, disputed, raters } = await loadConsensus(root, options.rater);
    if (!labels.size) throw new Error("no labels yet — run `eval label` first");

    const predictions = await loadPredictions(root, options.run);
    const aligned = align(items, labels, [predictions]);
    if (!aligned.ids.length) throw new Error("no items have both a label and a prediction");

    const result = evaluate(aligned.predictions[0], aligned.labels);
    const body = renderScore(options.run, result);
    console.log(`\n${body}`);
    console.log(
      `Labels from ${raters.join(", ") || "none"}${disputed.length ? `; ${disputed.length} disputed item(s) excluded` : ""}.`,
    );
    console.log(`Report: ${await saveReport(root, `score-${options.run}.md`, body)}`);
  });

program
  .command("compare <dataset>")
  .description("compare two runs on the items both covered")
  .requiredOption("-a, --a <run>", "first run")
  .requiredOption("-b, --b <run>", "second run")
  .action(async (root, options) => {
    const items = await loadItems(root);
    const config = await readConfig(root);
    const { labels, disputed } = await loadConsensus(root);
    if (!labels.size) throw new Error("no labels yet — run `eval label` first");

    const aligned = align(items, labels, [
      await loadPredictions(root, options.a),
      await loadPredictions(root, options.b),
    ]);
    if (!aligned.ids.length) throw new Error("no items are covered by the labels and both runs");

    const result = compare(aligned.predictions[0], aligned.predictions[1], aligned.labels, {
      threshold: config.threshold ?? 0.5,
    });

    const scoreA = evaluate(aligned.predictions[0], aligned.labels);
    const scoreB = evaluate(aligned.predictions[1], aligned.labels);
    const body = [
      renderComparison(options.a, options.b, result),
      renderScore(options.a, scoreA),
      renderScore(options.b, scoreB),
    ].join("\n");

    console.log(`\n${body}`);
    if (disputed.length) console.log(`${disputed.length} disputed item(s) excluded.`);
    console.log(`Report: ${await saveReport(root, `compare-${options.a}-vs-${options.b}.md`, body)}`);

    if (!result.conclusive) {
      const observed = Math.abs(result.accuracyDelta.point) || 0.02;
      const discordance = Math.max(result.mcnemar.discordant / result.n, observed + 0.05);
      const need = pairedSampleSize({ from: 0.85, to: 0.85 + observed, discordance });
      console.log(
        `\nTo resolve a gap this size you would need roughly ${need.items.toLocaleString()} labelled items ` +
          `(you have ${result.n}).`,
      );
    }
  });

program
  .command("agreement <dataset>")
  .description("inter-rater agreement — the ceiling on what any eval here can resolve")
  .action(async (root) => {
    const raters = await listRaters(root);
    if (raters.length < 2) throw new Error(`need at least two raters, found ${raters.length || "none"}`);

    const maps = await Promise.all(raters.map((rater) => loadLabels(root, rater)));
    console.log("");
    for (let i = 0; i < raters.length; i++) {
      for (let j = i + 1; j < raters.length; j++) {
        const shared = [...maps[i].keys()].filter((id) => maps[j].has(id));
        if (!shared.length) {
          console.log(`${raters[i]} vs ${raters[j]}: no overlapping items`);
          continue;
        }
        const kappa = cohensKappa(shared.map((id) => maps[i].get(id)), shared.map((id) => maps[j].get(id)));
        const raw = shared.filter((id) => maps[i].get(id) === maps[j].get(id)).length / shared.length;
        console.log(
          `${raters[i]} vs ${raters[j]}: κ = ${kappa.toFixed(3)}, raw agreement ${(raw * 100).toFixed(1)}% over ${shared.length} shared items — ${verdictFor(kappa)}`,
        );
      }
    }
    console.log("\nIf your raters disagree more than the systems do, the labels are the bottleneck, not the models.");
  });

program
  .command("power")
  .description("how many labelled items an effect of a given size needs")
  .requiredOption("--from <p>", "accuracy of the weaker system, 0-1", Number)
  .requiredOption("--to <p>", "accuracy of the stronger system, 0-1", Number)
  .option("--discordance <p>", "share of items the two disagree on", Number, 0.2)
  .option("--power <p>", "target power", Number, 0.8)
  .action((options) => {
    const scenario = { from: options.from, to: options.to, discordance: options.discordance };
    console.log(`\n${renderPower(scenario, pairedSampleSize({ ...scenario, power: options.power }))}`);
  });

program
  .command("status <dataset>")
  .description("what exists so far")
  .action(async (root) => {
    const items = await loadItems(root);
    const raters = await listRaters(root);
    const { labels, disputed } = await loadConsensus(root);
    const runs = await listRuns(root);

    console.log(`\n${root}`);
    console.log(`  items      ${items.length}`);
    console.log(`  raters     ${raters.join(", ") || "none"}`);
    console.log(`  labelled   ${labels.size} agreed${disputed.length ? `, ${disputed.length} disputed` : ""}`);
    console.log(`  runs       ${runs.join(", ") || "none"}`);
    for (const name of runs) {
      const predictions = await loadPredictions(root, name);
      const scorable = align(items, labels, [predictions]).ids.length;
      console.log(`    ${name}: ${predictions.size} predictions, ${scorable} scorable`);
    }
  });

function verdictFor(kappa) {
  if (kappa >= 0.8) return "strong";
  if (kappa >= 0.6) return "moderate; borderline for fine distinctions";
  if (kappa >= 0.4) return "weak — tighten the question before trusting any result";
  return "poor; the question is ambiguous, not the models";
}

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(`eval: ${error?.message ?? error}`);
  process.exit(1);
}

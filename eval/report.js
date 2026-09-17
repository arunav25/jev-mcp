/**
 * Markdown rendering for scores and comparisons.
 *
 * Every report states how each number was measured and how many items it
 * covers. A score with no coverage line invites the reader to assume the
 * whole dataset was used, when failed predictions and disputed labels have
 * quietly been dropped.
 */

const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "—");
const num = (x, digits = 4) => (Number.isFinite(x) ? x.toFixed(digits) : "—");
const interval = (ci, digits = 4) => `${num(ci.point, digits)} [${num(ci.lower, digits)}, ${num(ci.upper, digits)}]`;

const METHODS = {
  native: "the model returns a probability directly",
  logprobs: "probability derived from the Yes/No token distribution",
  verbalized: "the model was asked to state a number",
  unspecified: "measurement method not recorded",
};

/** How a run's numbers were obtained, and what share of the dataset they cover. */
export function renderProvenance(context = {}) {
  const lines = [];
  if (context.method) {
    lines.push(`**Measurement** — ${context.method}: ${METHODS[context.method] ?? "custom"}.`);
  }
  const c = context.coverage;
  if (c) {
    const parts = [];
    if (c.unlabelled) parts.push(`${c.unlabelled} unlabelled`);
    if (c.disputed) parts.push(`${c.disputed} label dispute(s)`);
    if (c.failed) parts.push(`${c.failed} failed prediction(s)`);
    lines.push(
      `**Coverage** — ${c.scored} of ${c.total} items scored` +
        (parts.length ? ` (excluded: ${parts.join(", ")}).` : "."),
    );
  }
  return lines.length ? lines.join("\n") + "\n" : "";
}

/** One system's scorecard. */
export function renderScore(name, result, context = {}) {
  const lines = [`## ${name}`, ""];

  const provenance = renderProvenance(context);
  if (provenance) lines.push(provenance);

  lines.push(`${result.n} labelled items · base rate ${pct(result.baseRate)}`, "");

  if (result.underpowered) {
    lines.push(
      `> **Underpowered.** ${result.n} items is below the ${result.minItems}-item floor; the intervals below are` +
        " indicative at best. Treat nothing here as a finding.",
      "",
    );
  }

  lines.push(
    "| Metric | Value (95% CI) | Reading |",
    "| --- | --- | --- |",
    `| Brier | ${interval(result.brier)} | lower is better; 0.25 = coin flip |`,
    `| Log loss | ${interval(result.logLoss)} | punishes confident mistakes |`,
    `| AUC | ${interval(result.auc, 3)} | ranking only, ignores calibration |`,
    `| Accuracy @0.5 | ${interval(result.accuracy, 3)} | the number people ask for |`,
    `| ECE | ${num(result.calibration.ece)} | mean gap between claim and outcome |`,
    `| Max bin gap | ${num(result.calibration.mce)} | worst single bin |`,
    "",
    `**At threshold 0.5** — precision ${pct(result.at50.precision)}, recall ${pct(result.at50.recall)}, F1 ${num(result.at50.f1, 3)} (TP ${result.at50.tp}, FP ${result.at50.fp}, FN ${result.at50.fn}, TN ${result.at50.tn})`,
    "",
  );

  if (Number.isFinite(result.heldOut?.f1)) {
    lines.push(
      `**Tuned threshold** — ${num(result.best.threshold, 2)} gives F1 ${num(result.best.f1, 3)} *in-sample*, ` +
        `which is optimistic because the cut was chosen on these same rows. ` +
        `Cross-validated over ${result.heldOut.folds} folds it is F1 ${num(result.heldOut.f1, 3)} — quote that one.`,
      "",
    );
  } else {
    lines.push(
      `**Tuned threshold** — ${num(result.best.threshold, 2)}, F1 ${num(result.best.f1, 3)} *in-sample only*; ` +
        "too few items to cross-validate, so this number is optimistic and should not be quoted.",
      "",
    );
  }

  lines.push("### Calibration", "", "| Predicted range | n | Mean claim | Observed | Gap |", "| --- | --- | --- | --- | --- |");
  for (const bin of result.calibration.bins) {
    lines.push(
      `| ${bin.lower.toFixed(1)}–${bin.upper.toFixed(1)} | ${bin.count} | ${num(bin.meanPrediction, 3)} | ${num(bin.observedRate, 3)} | ${bin.gap > 0 ? "+" : ""}${num(bin.gap, 3)} |`,
    );
  }
  lines.push("", "A positive gap means the system claimed more confidence than the outcomes justified.", "");
  return lines.join("\n");
}

/** Head-to-head. Leads with whether anything can be concluded at all. */
export function renderComparison(nameA, nameB, result, context = {}) {
  const { brierDelta, accuracyDelta, mcnemar: test } = result;
  const winner = brierDelta.point < 0 ? nameA : nameB;

  const verdict = result.conclusive
    ? `**${winner} is ahead on Brier score**, and the 95% interval excludes zero.`
    : result.underpowered || result.degenerate
      ? `**No verdict.** The sample is too small to support one, whatever the numbers below look like.`
      : `**No difference can be established at this sample size.** The interval on the Brier difference spans zero.`;

  const lines = [`## ${nameA} vs ${nameB}`, "", `${result.n} items scored by both.`, ""];

  const methods = context.methods ?? {};
  if (methods[nameA] || methods[nameB]) {
    lines.push(
      "**Measurement differs between these systems** — " +
        `${nameA}: ${METHODS[methods[nameA]] ?? "unrecorded"}; ${nameB}: ${METHODS[methods[nameB]] ?? "unrecorded"}. ` +
        "A calibration gap between a native probability and a verbalized one is partly an artefact of the interface.",
      "",
    );
  }

  const provenance = renderProvenance({ coverage: context.coverage });
  if (provenance) lines.push(provenance);

  lines.push(verdict, "");

  if (result.warnings?.length) {
    lines.push(...result.warnings.map((w) => `> ⚠ ${w}`), "");
  }

  lines.push(
    "| Quantity | Value (95% CI) |",
    "| --- | --- |",
    `| Brier difference (${nameA} − ${nameB}) | ${interval(brierDelta)} |`,
    `| Accuracy difference (${nameA} − ${nameB}) | ${interval(accuracyDelta, 3)} |`,
    "",
    `**McNemar** — ${test.b} item(s) only ${nameA} called correctly, ${test.c} only ${nameB} did; ` +
      `${test.discordant} discordant of ${result.n}. p = ${test.pValue.toFixed(4)} (${test.method}).`,
    "",
    result.significant
      ? "The difference in decisions at threshold 0.5 is statistically significant at α = 0.05."
      : "The difference in decisions at threshold 0.5 is **not** significant at α = 0.05. " +
        "Treat any gap you see as noise until more items are labelled.",
    "",
    "Negative Brier difference favours the first system. Accuracy difference is positive when the first system is ahead.",
    "",
  );
  return lines.join("\n");
}

/** Sample-size guidance. */
export function renderPower(scenario, result) {
  return [
    `Detecting **${(scenario.from * 100).toFixed(0)}% → ${(scenario.to * 100).toFixed(0)}%** ` +
      `(${((scenario.to - scenario.from) * 100).toFixed(1)} points), assuming the two systems disagree on ` +
      `${(scenario.discordance * 100).toFixed(0)}% of items:`,
    "",
    `  **${result.items.toLocaleString()} labelled items** (≈${result.discordantPairs.toLocaleString()} discordant pairs)`,
    "",
    `  at 80% power, α = 0.05, paired McNemar.`,
    "",
  ].join("\n");
}

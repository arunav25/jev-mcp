/** Markdown rendering for scores and comparisons. */

const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "—");
const num = (x, digits = 4) => (Number.isFinite(x) ? x.toFixed(digits) : "—");
const interval = (ci, digits = 4) => `${num(ci.point, digits)} [${num(ci.lower, digits)}, ${num(ci.upper, digits)}]`;

/** One system's scorecard. */
export function renderScore(name, result) {
  const lines = [
    `## ${name}`,
    "",
    `${result.n} labelled items · base rate ${pct(result.baseRate)}`,
    "",
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
    `**Best threshold by F1** — ${num(result.best.threshold, 2)} giving F1 ${num(result.best.f1, 3)}, precision ${pct(result.best.precision)}, recall ${pct(result.best.recall)}`,
    "",
    "### Calibration",
    "",
    "| Predicted range | n | Mean claim | Observed | Gap |",
    "| --- | --- | --- | --- | --- |",
  ];

  for (const bin of result.calibration.bins) {
    lines.push(
      `| ${bin.lower.toFixed(1)}–${bin.upper.toFixed(1)} | ${bin.count} | ${num(bin.meanPrediction, 3)} | ${num(bin.observedRate, 3)} | ${bin.gap > 0 ? "+" : ""}${num(bin.gap, 3)} |`,
    );
  }

  lines.push("", "A positive gap means the system claimed more confidence than the outcomes justified.", "");
  return lines.join("\n");
}

/** Head-to-head. Leads with whether anything can be concluded at all. */
export function renderComparison(nameA, nameB, result) {
  const { brierDelta, accuracyDelta, mcnemar: test } = result;
  const winner = brierDelta.point < 0 ? nameA : nameB;

  const verdict = result.conclusive
    ? `**${winner} is ahead on Brier score**, and the 95% interval excludes zero.`
    : `**No difference can be established at this sample size.** The interval on the Brier difference spans zero.`;

  return [
    `## ${nameA} vs ${nameB}`,
    "",
    `${result.n} items scored by both.`,
    "",
    verdict,
    "",
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
  ].join("\n");
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

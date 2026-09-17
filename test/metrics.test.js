import { test } from "node:test";
import assert from "node:assert/strict";

import {
  atThreshold, auc, bestThreshold, brier, calibration, cohensKappa, compare, evaluate, logLoss,
} from "../eval/metrics.js";
import { binomialUpperTail, bootstrapCI, mcnemar, normalCdf, normalQuantile, pairedSampleSize } from "../eval/stats.js";

const close = (actual, expected, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `expected ${expected}, got ${actual}`);

test("brier matches a hand computation", () => {
  // ((0.8-1)^2 + (0.3-0)^2) / 2 = (0.04 + 0.09) / 2
  close(brier([0.8, 0.3], [1, 0]), 0.065);
  close(brier([1, 0], [1, 0]), 0);       // perfect
  close(brier([0.5, 0.5], [1, 0]), 0.25); // coin flip
  close(brier([0, 1], [1, 0]), 1);       // confidently wrong
});

test("log loss matches a hand computation", () => {
  close(logLoss([0.8, 0.3], [1, 0]), -(Math.log(0.8) + Math.log(0.7)) / 2);
  close(logLoss([0.5, 0.5], [1, 0]), Math.LN2);
});

test("log loss stays finite on a confidently wrong prediction", () => {
  assert.ok(Number.isFinite(logLoss([0, 1], [1, 0])));
});

test("auc matches the textbook example and handles ties", () => {
  close(auc([0.1, 0.4, 0.35, 0.8], [0, 0, 1, 1]), 0.75);
  close(auc([0.9, 0.8, 0.2, 0.1], [1, 1, 0, 0]), 1);   // perfect ranking
  close(auc([0.1, 0.2, 0.8, 0.9], [1, 1, 0, 0]), 0);   // exactly inverted
  close(auc([0.5, 0.5], [1, 0]), 0.5);                  // a total tie is a coin flip
  close(auc([0.5, 0.5, 0.9], [0, 1, 1]), 0.75);         // partial tie, averaged ranks
});

test("auc is undefined without both classes", () => {
  assert.ok(Number.isNaN(auc([0.3, 0.7], [1, 1])));
});

test("calibration reports the gap between claimed and observed", () => {
  const { ece, mce, bins } = calibration([0.9, 0.9, 0.1, 0.1], [1, 1, 0, 0]);
  close(ece, 0.1);
  close(mce, 0.1);
  assert.equal(bins.length, 2);

  const perfect = calibration([0.95, 0.05], [1, 0]);
  close(perfect.ece, 0.05);
});

test("threshold metrics count the confusion matrix correctly", () => {
  const result = atThreshold([0.9, 0.6, 0.4, 0.1], [1, 0, 1, 0], 0.5);
  assert.deepEqual([result.tp, result.fp, result.fn, result.tn], [1, 1, 1, 1]);
  close(result.accuracy, 0.5);
  close(result.precision, 0.5);
  close(result.recall, 0.5);
  close(result.f1, 0.5);
});

test("bestThreshold finds a cut the default 0.5 misses", () => {
  // Every probability is low, but they separate cleanly at 0.25.
  const predictions = [0.3, 0.28, 0.1, 0.05];
  const labels = [1, 1, 0, 0];
  assert.ok(atThreshold(predictions, labels, 0.5).f1 < 1);
  close(bestThreshold(predictions, labels, "f1").f1, 1);
});

test("normal helpers match published values", () => {
  close(normalQuantile(0.975), 1.959964, 1e-5);
  close(normalQuantile(0.8), 0.8416212, 1e-5);
  close(normalQuantile(0.5), 0, 1e-9);
  close(normalCdf(1.959964), 0.975, 1e-6);
  close(normalCdf(0), 0.5, 1e-9);
});

test("binomial tail matches an exact computation", () => {
  // P(X >= 10) for n=12, p=0.5 is (66 + 12 + 1) / 4096.
  close(binomialUpperTail(10, 12), 79 / 4096, 1e-12);
  close(binomialUpperTail(0, 12), 1);
  close(binomialUpperTail(13, 12), 0);
});

test("mcnemar uses the exact test on small discordance", () => {
  const result = mcnemar(10, 2);
  assert.equal(result.method, "exact binomial");
  close(result.pValue, (2 * 79) / 4096, 1e-12);
  assert.ok(result.pValue < 0.05);

  assert.equal(mcnemar(0, 0).pValue, 1);
  assert.ok(mcnemar(6, 5).pValue > 0.5, "near-equal discordance is not significant");
});

test("mcnemar switches to chi-square once discordance is large", () => {
  assert.equal(mcnemar(30, 20).method, "chi-square (continuity corrected)");
});

test("bootstrap is reproducible and brackets the point estimate", () => {
  const values = Array.from({ length: 200 }, (_, i) => i / 200);
  const statistic = (idx) => idx.reduce((s, i) => s + values[i], 0) / idx.length;

  const first = bootstrapCI(values.length, statistic, { seed: 7, resamples: 500 });
  const second = bootstrapCI(values.length, statistic, { seed: 7, resamples: 500 });

  assert.deepEqual(first, second);
  assert.ok(first.lower < first.point && first.point < first.upper);
});

test("cohen's kappa is 0 at chance and 1 at perfect agreement", () => {
  close(cohensKappa([1, 1, 0, 0], [1, 0, 1, 0]), 0);
  close(cohensKappa([1, 0, 1, 0], [1, 0, 1, 0]), 1);
  assert.ok(cohensKappa([1, 1, 1, 0], [1, 1, 0, 0]) > 0);
});

test("evaluate assembles every metric with intervals", () => {
  const predictions = [0.9, 0.85, 0.2, 0.1, 0.75, 0.3];
  const labels = [1, 1, 0, 0, 1, 0];

  const result = evaluate(predictions, labels, { resamples: 300 });

  assert.equal(result.n, 6);
  close(result.baseRate, 0.5);
  close(result.auc.point, 1);
  assert.ok(result.brier.lower <= result.brier.point && result.brier.point <= result.brier.upper);
  assert.equal(result.at50.accuracy, 1);
});

test("evaluate rejects mismatched lengths", () => {
  assert.throws(() => evaluate([0.5], [1, 0]), /length mismatch/);
});

test("compare finds no difference between identical systems", () => {
  const predictions = [0.9, 0.2, 0.8, 0.3];
  const labels = [1, 0, 1, 0];

  const result = compare(predictions, predictions, labels, { resamples: 300 });

  close(result.brierDelta.point, 0);
  assert.equal(result.mcnemar.discordant, 0);
  assert.equal(result.significant, false);
});

test("compare detects a large, consistent difference", () => {
  const n = 60;
  const labels = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 1 : 0));
  const strong = labels.map((y) => (y === 1 ? 0.95 : 0.05));       // always right
  const weak = labels.map((y, i) => (i % 3 === 0 ? 1 - (y ? 0.9 : 0.1) : y ? 0.9 : 0.1));

  const result = compare(weak, strong, labels, { resamples: 400 });

  assert.ok(result.brierDelta.point > 0, "weak system should carry the worse Brier score");
  assert.ok(result.mcnemar.pValue < 0.05, `expected significance, got p=${result.mcnemar.pValue}`);
  assert.equal(result.conclusive, true);
});

test("compare reports a 2-point gap on 10 items as inconclusive", () => {
  // The thread's scenario: one disagreement in ten. Nothing can be concluded.
  const labels = [1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
  const a = labels.map((y) => (y ? 0.9 : 0.1));
  const b = a.slice();
  b[0] = 0.4; // one item flipped

  const result = compare(a, b, labels, { resamples: 500 });

  assert.equal(result.mcnemar.discordant, 1);
  assert.ok(result.mcnemar.pValue > 0.05, "a single discordant pair cannot reach significance");
  assert.equal(result.significant, false);
});

test("sample size grows as the effect shrinks", () => {
  const big = pairedSampleSize({ from: 0.8, to: 0.9, discordance: 0.2 });
  const small = pairedSampleSize({ from: 0.9, to: 0.92, discordance: 0.15 });

  assert.ok(small.items > big.items, "a 2-point gap must need more items than a 10-point gap");
  assert.ok(big.items > 0 && Number.isFinite(small.items));
  assert.ok(small.oddsRatio > 1);
});

test("sample size rejects a discordance smaller than the gap", () => {
  assert.throws(
    () => pairedSampleSize({ from: 0.9, to: 0.95, discordance: 0.02 }),
    /must exceed the accuracy gap/,
  );
});

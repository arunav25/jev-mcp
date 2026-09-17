/**
 * Scoring for binary probabilistic predictions.
 *
 * Accuracy alone is the wrong headline for a system that returns a
 * probability: it throws away everything except which side of 0.5 the number
 * fell on. Brier score and calibration are what tell you whether a 0.9 means
 * anything. Accuracy is still reported, because it is what people ask for.
 */

import { bootstrapCI, mcnemar, mean } from "./stats.js";

const EPSILON = 1e-15;
const clamp01 = (p) => Math.min(1 - EPSILON, Math.max(EPSILON, p));

/** Mean squared error of the probability. Lower is better; 0.25 is a coin flip. */
export function brier(predictions, labels) {
  return mean(predictions.map((p, i) => (p - labels[i]) ** 2));
}

/** Negative log likelihood. Punishes confident mistakes far harder than Brier. */
export function logLoss(predictions, labels) {
  return -mean(
    predictions.map((p, i) => {
      const q = clamp01(p);
      return labels[i] === 1 ? Math.log(q) : Math.log(1 - q);
    }),
  );
}

/**
 * Area under the ROC curve, by the rank (Mann-Whitney U) identity, with
 * average ranks for ties. Threshold-free: it measures ordering only.
 */
export function auc(predictions, labels) {
  const positives = labels.filter((y) => y === 1).length;
  const negatives = labels.length - positives;
  if (positives === 0 || negatives === 0) return NaN;

  const order = predictions.map((p, i) => ({ p, y: labels[i] })).sort((a, b) => a.p - b.p);
  const ranks = new Array(order.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].p === order[i].p) j++;
    const shared = (i + j) / 2 + 1; // average of 1-based ranks in the tie group
    for (let k = i; k <= j; k++) ranks[k] = shared;
    i = j + 1;
  }

  const rankSum = order.reduce((sum, item, i) => (item.y === 1 ? sum + ranks[i] : sum), 0);
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

/**
 * Equal-width reliability bins: what the system claimed versus what happened.
 * @returns {{bins: object[], ece: number, mce: number}}
 */
export function calibration(predictions, labels, binCount = 10) {
  const bins = Array.from({ length: binCount }, (_, i) => ({
    lower: i / binCount,
    upper: (i + 1) / binCount,
    count: 0,
    meanPrediction: 0,
    observedRate: 0,
  }));

  for (let i = 0; i < predictions.length; i++) {
    const index = Math.min(binCount - 1, Math.floor(predictions[i] * binCount));
    const bin = bins[index];
    bin.count++;
    bin.meanPrediction += predictions[i];
    bin.observedRate += labels[i];
  }

  let ece = 0;
  let mce = 0;
  for (const bin of bins) {
    if (!bin.count) continue;
    bin.meanPrediction /= bin.count;
    bin.observedRate /= bin.count;
    bin.gap = bin.meanPrediction - bin.observedRate;
    ece += (bin.count / predictions.length) * Math.abs(bin.gap);
    mce = Math.max(mce, Math.abs(bin.gap));
  }
  return { bins: bins.filter((b) => b.count > 0), ece, mce };
}

/** Confusion counts and the usual rates at a decision threshold. */
export function atThreshold(predictions, labels, threshold = 0.5) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (let i = 0; i < predictions.length; i++) {
    const predicted = predictions[i] >= threshold ? 1 : 0;
    if (predicted === 1 && labels[i] === 1) tp++;
    else if (predicted === 1) fp++;
    else if (labels[i] === 1) fn++;
    else tn++;
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  return {
    threshold,
    tp, fp, tn, fn,
    accuracy: (tp + tn) / predictions.length,
    precision,
    recall,
    specificity: tn + fp === 0 ? 0 : tn / (tn + fp),
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
  };
}

/** The threshold maximising a chosen objective, scanned over observed values. */
export function bestThreshold(predictions, labels, objective = "f1") {
  const candidates = [...new Set(predictions)].sort((a, b) => a - b);
  let best = atThreshold(predictions, labels, 0.5);
  for (const threshold of candidates) {
    const result = atThreshold(predictions, labels, threshold);
    const score = objective === "youden" ? result.recall + result.specificity - 1 : result[objective];
    const incumbent = objective === "youden" ? best.recall + best.specificity - 1 : best[objective];
    if (score > incumbent) best = result;
  }
  return best;
}

/**
 * Every metric for one system, each with a bootstrap interval.
 * @param {number[]} predictions Probabilities in [0,1].
 * @param {0|1[]} labels
 */
export function evaluate(predictions, labels, { seed = 42, resamples = 2000, bins = 10 } = {}) {
  if (predictions.length !== labels.length) {
    throw new Error(`length mismatch: ${predictions.length} predictions, ${labels.length} labels`);
  }
  const n = predictions.length;
  const pick = (indices, xs) => indices.map((i) => xs[i]);
  const ci = (fn) => bootstrapCI(n, (idx) => fn(pick(idx, predictions), pick(idx, labels)), { seed, resamples });

  return {
    n,
    baseRate: mean(labels),
    brier: ci(brier),
    logLoss: ci(logLoss),
    auc: ci(auc),
    accuracy: ci((p, y) => atThreshold(p, y, 0.5).accuracy),
    calibration: calibration(predictions, labels, bins),
    at50: atThreshold(predictions, labels, 0.5),
    best: bestThreshold(predictions, labels, "f1"),
  };
}

/**
 * Paired comparison of two systems over the same items — the only honest way
 * to compare, since both saw identical inputs and the per-item noise cancels.
 *
 * @param {number[]} a Probabilities from the first system.
 * @param {number[]} b Probabilities from the second.
 * @param {0|1[]} labels
 */
export function compare(a, b, labels, { seed = 42, resamples = 2000, threshold = 0.5 } = {}) {
  const n = labels.length;
  if (a.length !== n || b.length !== n) throw new Error("all three arrays must be the same length");

  const pick = (indices, xs) => indices.map((i) => xs[i]);
  const brierDelta = bootstrapCI(
    n,
    (idx) => brier(pick(idx, a), pick(idx, labels)) - brier(pick(idx, b), pick(idx, labels)),
    { seed, resamples },
  );
  const accuracyDelta = bootstrapCI(
    n,
    (idx) =>
      atThreshold(pick(idx, a), pick(idx, labels), threshold).accuracy -
      atThreshold(pick(idx, b), pick(idx, labels), threshold).accuracy,
    { seed, resamples },
  );

  // Discordant pairs: items exactly one of the two systems called correctly.
  let aOnly = 0;
  let bOnly = 0;
  for (let i = 0; i < n; i++) {
    const aRight = (a[i] >= threshold ? 1 : 0) === labels[i];
    const bRight = (b[i] >= threshold ? 1 : 0) === labels[i];
    if (aRight && !bRight) aOnly++;
    else if (bRight && !aRight) bOnly++;
  }

  const test = mcnemar(aOnly, bOnly);
  return {
    n,
    brierDelta,      // negative favours the first system
    accuracyDelta,   // positive favours the first system
    mcnemar: test,
    significant: test.pValue < 0.05,
    // An interval straddling zero is the result, not a failed run.
    conclusive: brierDelta.lower > 0 || brierDelta.upper < 0,
  };
}

/** Cohen's kappa between two raters' binary labels — how trustworthy the ground truth is. */
export function cohensKappa(first, second) {
  const n = first.length;
  if (n === 0 || n !== second.length) throw new Error("raters must label the same items");

  let agree = 0, firstPositive = 0, secondPositive = 0;
  for (let i = 0; i < n; i++) {
    if (first[i] === second[i]) agree++;
    firstPositive += first[i];
    secondPositive += second[i];
  }
  const observed = agree / n;
  const pPos = (firstPositive / n) * (secondPositive / n);
  const pNeg = (1 - firstPositive / n) * (1 - secondPositive / n);
  const expected = pPos + pNeg;
  return expected === 1 ? 1 : (observed - expected) / (1 - expected);
}

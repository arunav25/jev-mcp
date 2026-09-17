/**
 * Scoring for binary probabilistic predictions.
 *
 * Accuracy alone is the wrong headline for a system that returns a
 * probability: it throws away everything except which side of 0.5 the number
 * fell on. Brier score and calibration are what tell you whether a 0.9 means
 * anything. Accuracy is still reported, because it is what people ask for.
 */

import { bootstrapCI, mcnemar, mean, rng as rngFor } from "./stats.js";

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
 * Threshold tuned on k-1 folds and scored on the held-out fold, averaged.
 *
 * `bestThreshold` above picks and scores the cut on the same data, so its F1
 * is optimistic by construction. This is the number to quote.
 */
export function heldOutThreshold(predictions, labels, { folds = 5, seed = 42, objective = "f1" } = {}) {
  const n = predictions.length;
  if (n < folds * 2) return { folds: 0, f1: NaN, thresholds: [], note: "too few items to cross-validate" };

  const next = rngFor(seed);
  const order = Array.from({ length: n }, (_, i) => i)
    .map((i) => ({ i, key: next() }))
    .sort((a, b) => a.key - b.key)
    .map(({ i }) => i);

  const scores = [];
  const thresholds = [];
  for (let fold = 0; fold < folds; fold++) {
    const test = order.filter((_, position) => position % folds === fold);
    const train = order.filter((_, position) => position % folds !== fold);
    if (!test.length || !train.length) continue;

    const tuned = bestThreshold(train.map((i) => predictions[i]), train.map((i) => labels[i]), objective);
    const held = atThreshold(test.map((i) => predictions[i]), test.map((i) => labels[i]), tuned.threshold);
    thresholds.push(tuned.threshold);
    scores.push(held[objective]);
  }

  return {
    folds: scores.length,
    f1: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : NaN,
    thresholds,
  };
}

/** Sample floor below which a bootstrap interval carries no information. */
export const MIN_ITEMS_FOR_VERDICT = 30;

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
    // Tuned and scored on the same rows: optimistic, reported for reference only.
    best: { ...bestThreshold(predictions, labels, "f1"), inSample: true },
    heldOut: heldOutThreshold(predictions, labels, { seed }),
    underpowered: n < MIN_ITEMS_FOR_VERDICT,
    minItems: MIN_ITEMS_FOR_VERDICT,
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
export function compare(a, b, labels, { seed = 42, resamples = 2000, threshold = 0.5, minItems = MIN_ITEMS_FOR_VERDICT } = {}) {
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

  // A bootstrap over a handful of rows resamples the same values every time,
  // so the interval collapses onto the point estimate and looks decisive.
  // That is an artefact of the sample size, not evidence.
  const degenerate = brierDelta.lower === brierDelta.upper;
  const underpowered = n < minItems;
  const excludesZero = brierDelta.lower > 0 || brierDelta.upper < 0;

  const warnings = [];
  if (underpowered) warnings.push(`only ${n} item(s) scored; ${minItems} is the floor for any verdict`);
  if (degenerate) warnings.push("the bootstrap interval collapsed onto the point estimate — too few distinct rows");
  if (test.discordant === 0) warnings.push("the two systems made identical decisions on every item");

  return {
    n,
    brierDelta,      // negative favours the first system
    accuracyDelta,   // positive favours the first system
    mcnemar: test,
    significant: !underpowered && !degenerate && test.pValue < 0.05,
    // An interval straddling zero is the result, not a failed run.
    conclusive: excludesZero && !underpowered && !degenerate,
    underpowered,
    degenerate,
    minItems,
    warnings,
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

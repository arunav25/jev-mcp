/**
 * Latency, token and cost summaries.
 *
 * These need no labels, which makes them the only part of a comparison you can
 * run on day one. They are also the differences a realistic sample can
 * actually resolve: a 2-point accuracy gap needs thousands of labelled items,
 * while a system that is twice as slow or five times dearer is obvious across
 * fifty unlabelled ones.
 *
 * Latency is reported by percentile, never as a mean. Response times are
 * right-skewed — one 30-second retry drags a mean somewhere no request went.
 */

import { bootstrapCI } from "./stats.js";

/**
 * Nearest-rank percentile over an already-sorted array.
 * @param {number[]} sorted Ascending.
 * @param {number} q In [0,1].
 */
export function percentile(sorted, q) {
  if (!sorted.length) return NaN;
  const rank = Math.ceil(q * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

/**
 * Normalises the several token-count spellings the providers use.
 * Returns null when a response carried none, so "unreported" stays
 * distinguishable from "zero".
 */
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens;
  const output = usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens;
  if (input === undefined && output === undefined) return null;
  return { inputTokens: Number(input ?? 0), outputTokens: Number(output ?? 0) };
}

/** Cost of one call's tokens, or null when no rate was supplied. */
export function costOf(usage, rate) {
  if (!rate || !usage) return null;
  const input = (usage.inputTokens ?? 0) / 1e6 * (rate.inputPer1M ?? 0);
  const output = (usage.outputTokens ?? 0) / 1e6 * (rate.outputPer1M ?? 0);
  return input + output;
}

/**
 * Summarises one run's prediction rows.
 *
 * @param {object[]} rows Prediction rows, as written by the runner.
 * @param {object} [options]
 * @param {{inputPer1M?: number, outputPer1M?: number, currency?: string}} [options.rate]
 *   Price per million tokens. Omitted means no cost is reported — rates change
 *   and are per-account, so nothing is assumed on your behalf.
 */
export function summarize(rows, { rate } = {}) {
  const timed = rows.filter((row) => Number.isFinite(row.latencyMs));
  const failures = rows.filter((row) => row.error).length;
  const latencies = timed.map((row) => row.latencyMs).sort((a, b) => a - b);

  const withUsage = rows.filter((row) => row.usage);
  const inputTokens = withUsage.reduce((sum, row) => sum + (row.usage.inputTokens ?? 0), 0);
  const outputTokens = withUsage.reduce((sum, row) => sum + (row.usage.outputTokens ?? 0), 0);

  const costs = rate ? withUsage.map((row) => costOf(row.usage, rate)).filter((c) => c !== null) : [];

  return {
    calls: rows.length,
    timed: timed.length,
    failures,
    latency: latencies.length
      ? {
          p50: percentile(latencies, 0.5),
          p90: percentile(latencies, 0.9),
          p95: percentile(latencies, 0.95),
          p99: percentile(latencies, 0.99),
          min: latencies[0],
          max: latencies[latencies.length - 1],
        }
      : null,
    tokens: withUsage.length
      ? {
          reported: withUsage.length,
          inputTokens,
          outputTokens,
          meanInput: inputTokens / withUsage.length,
          meanOutput: outputTokens / withUsage.length,
        }
      : null,
    cost: costs.length
      ? {
          currency: rate.currency ?? "USD",
          total: costs.reduce((a, b) => a + b, 0),
          perCall: costs.reduce((a, b) => a + b, 0) / costs.length,
          per1kCalls: (costs.reduce((a, b) => a + b, 0) / costs.length) * 1000,
          priced: costs.length,
        }
      : null,
  };
}

/**
 * Paired latency comparison over the items both runs covered.
 *
 * Paired because the same item can be intrinsically slower for both systems —
 * a long ticket is a long prompt either way — and pairing cancels that.
 * Reported as a median difference: the tail is where retries live, and a mean
 * would let one of them decide the answer.
 *
 * @param {object[]} rowsA
 * @param {object[]} rowsB
 */
export function compareLatency(rowsA, rowsB, { seed = 42, resamples = 2000 } = {}) {
  const byIdB = new Map(rowsB.map((row) => [row.id, row]));
  const pairs = [];
  for (const row of rowsA) {
    const other = byIdB.get(row.id);
    if (Number.isFinite(row.latencyMs) && Number.isFinite(other?.latencyMs)) {
      pairs.push([row.latencyMs, other.latencyMs]);
    }
  }
  if (!pairs.length) return { n: 0, medianDelta: null, ratio: null };

  const median = (values) => percentile([...values].sort((a, b) => a - b), 0.5);
  const deltas = pairs.map(([a, b]) => a - b);

  const ci = bootstrapCI(deltas.length, (idx) => median(idx.map((i) => deltas[i])), { seed, resamples });
  const medianA = median(pairs.map(([a]) => a));
  const medianB = median(pairs.map(([, b]) => b));

  return {
    n: pairs.length,
    medianA,
    medianB,
    medianDelta: ci,                                   // negative: the first is faster
    ratio: medianB === 0 ? null : medianA / medianB,   // <1: the first is faster
    conclusive: ci.lower > 0 || ci.upper < 0,
  };
}

/** Cost ratio between two summaries, when both are priced. */
export function compareCost(a, b) {
  if (!a.cost || !b.cost) return null;
  if (a.cost.currency !== b.cost.currency) return null;
  return {
    currency: a.cost.currency,
    perCallA: a.cost.perCall,
    perCallB: b.cost.perCall,
    ratio: b.cost.perCall === 0 ? null : a.cost.perCall / b.cost.perCall,
  };
}

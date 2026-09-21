import { test } from "node:test";
import assert from "node:assert/strict";

import { compareCost, compareLatency, costOf, normalizeUsage, percentile, summarize } from "../eval/performance.js";

const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `expected ${b}, got ${a}`);

test("nearest-rank percentiles land on real observations", () => {
  const sorted = [1, 2, 3, 4, 5];
  assert.equal(percentile(sorted, 0.5), 3);
  assert.equal(percentile(sorted, 0.95), 5);
  assert.equal(percentile(sorted, 1), 5);
  assert.equal(percentile(sorted, 0), 1);
  assert.equal(percentile([7], 0.5), 7);
  assert.ok(Number.isNaN(percentile([], 0.5)));
});

test("a percentile is never dragged by the tail the way a mean is", () => {
  // Nine fast calls and one 30s retry: the mean is misleading, p50 is not.
  const latencies = [...Array(9).fill(100), 30_000].sort((a, b) => a - b);
  assert.equal(percentile(latencies, 0.5), 100);
  const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  assert.ok(mean > 3000, `mean sits at ${mean}, where no request went`);
});

test("usage is normalised across provider spellings", () => {
  assert.deepEqual(normalizeUsage({ input_tokens: 10, output_tokens: 2 }), { inputTokens: 10, outputTokens: 2 });
  assert.deepEqual(normalizeUsage({ prompt_tokens: 7, completion_tokens: 1 }), { inputTokens: 7, outputTokens: 1 });
  assert.deepEqual(normalizeUsage({ inputTokens: 3 }), { inputTokens: 3, outputTokens: 0 });
  assert.equal(normalizeUsage({}), null, "unreported must stay distinct from zero");
  assert.equal(normalizeUsage(null), null);
});

test("cost is computed per million tokens", () => {
  const rate = { inputPer1M: 2, outputPer1M: 10 };
  close(costOf({ inputTokens: 1_000_000, outputTokens: 0 }, rate), 2);
  close(costOf({ inputTokens: 0, outputTokens: 500_000 }, rate), 5);
  close(costOf({ inputTokens: 250, outputTokens: 50 }, rate), 250 / 1e6 * 2 + 50 / 1e6 * 10);
});

test("no rate means no cost, never a guessed one", () => {
  assert.equal(costOf({ inputTokens: 100, outputTokens: 10 }, null), null);
  const summary = summarize([{ id: "a", latencyMs: 10, usage: { inputTokens: 100, outputTokens: 5 } }]);
  assert.equal(summary.cost, null);
  assert.ok(summary.tokens, "tokens are still reported without rates");
});

test("summarize reports latency, tokens and cost together", () => {
  const rows = [10, 20, 30, 40, 50].map((latencyMs, i) => ({
    id: `i${i}`,
    latencyMs,
    usage: { inputTokens: 100, outputTokens: 10 },
  }));

  const summary = summarize(rows, { rate: { inputPer1M: 1, outputPer1M: 1, currency: "EUR" } });

  assert.equal(summary.calls, 5);
  assert.equal(summary.timed, 5);
  assert.equal(summary.latency.p50, 30);
  assert.equal(summary.latency.max, 50);
  assert.equal(summary.tokens.inputTokens, 500);
  close(summary.tokens.meanOutput, 10);
  assert.equal(summary.cost.currency, "EUR");
  close(summary.cost.perCall, 110 / 1e6);
  close(summary.cost.per1kCalls, (110 / 1e6) * 1000);
});

test("failed calls are counted and their timing still kept", () => {
  const summary = summarize([
    { id: "a", latencyMs: 10, usage: { inputTokens: 1, outputTokens: 1 } },
    { id: "b", latencyMs: 9000, error: "rate limited" },
  ]);
  assert.equal(summary.failures, 1);
  assert.equal(summary.timed, 2, "a failure still consumed wall-clock time");
});

test("a run with no timing reports none rather than zeros", () => {
  const summary = summarize([{ id: "a", probability: 0.5 }]);
  assert.equal(summary.latency, null);
  assert.equal(summary.tokens, null);
});

test("paired latency comparison finds a consistent difference", () => {
  const fast = Array.from({ length: 40 }, (_, i) => ({ id: `i${i}`, latencyMs: 40 + (i % 5) }));
  const slow = Array.from({ length: 40 }, (_, i) => ({ id: `i${i}`, latencyMs: 320 + (i % 5) }));

  const result = compareLatency(fast, slow, { resamples: 400 });

  assert.equal(result.n, 40);
  assert.ok(result.medianDelta.point < 0, "negative favours the first");
  assert.equal(result.conclusive, true);
  assert.ok(result.ratio < 0.2, `expected a large speedup, got ratio ${result.ratio}`);
});

test("paired latency pairs only items both runs timed", () => {
  const a = [{ id: "x", latencyMs: 10 }, { id: "y", latencyMs: 20 }, { id: "z", latencyMs: 30 }];
  const b = [{ id: "x", latencyMs: 15 }, { id: "z", latencyMs: 35 }]; // no y

  assert.equal(compareLatency(a, b, { resamples: 100 }).n, 2);
  assert.equal(compareLatency(a, [], { resamples: 100 }).n, 0);
  assert.equal(compareLatency(a, [{ id: "x", error: "boom" }], { resamples: 100 }).n, 0);
});

test("identical latencies are not called a difference", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: `i${i}`, latencyMs: 100 }));
  const result = compareLatency(rows, rows, { resamples: 200 });
  close(result.medianDelta.point, 0);
  assert.equal(result.conclusive, false);
});

test("cost comparison needs both sides priced and in one currency", () => {
  const priced = (perCall, currency) => ({ cost: { perCall, currency, total: perCall, per1kCalls: perCall * 1000, priced: 1 } });

  const result = compareCost(priced(0.001, "USD"), priced(0.004, "USD"));
  close(result.ratio, 0.25);
  assert.equal(compareCost(priced(0.001, "USD"), { cost: null }), null);
  assert.equal(compareCost(priced(0.001, "USD"), priced(0.004, "INR")), null, "currencies must match");
});

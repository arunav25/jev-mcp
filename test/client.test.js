import { test } from "node:test";
import assert from "node:assert/strict";

import { ApiError, TypeSafeClient } from "../src/client.js";

/** Builds a fetch stub that walks through a list of canned responses. */
function stubFetch(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: { get: (name) => next.headers?.[name.toLowerCase()] ?? null },
      text: async () => next.body ?? "",
    };
  };
  return { fetch, calls };
}

const noSleep = async () => {};

test("returns the parsed body on success", async () => {
  const { fetch, calls } = stubFetch([{ status: 200, body: '{"answers":{"a":{"type":"noul","noul":0.91}}}' }]);
  const client = new TypeSafeClient({ apiKey: "k", fetch, sleep: noSleep });

  const result = await client.evaluate({ state: "hi", questions: {} });

  assert.equal(result.answers.a.noul, 0.91);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.authorization, "Bearer k");
  assert.equal(calls[0].url, "https://api.typesafe.ai/v1/systemone");
});

test("retries a 429 and succeeds", async () => {
  const { fetch, calls } = stubFetch([
    { status: 429, body: "slow down" },
    { status: 200, body: '{"ok":true}' },
  ]);
  const client = new TypeSafeClient({ apiKey: "k", fetch, sleep: noSleep });

  assert.deepEqual(await client.evaluate({}), { ok: true });
  assert.equal(calls.length, 2);
});

test("retries a 529 up to maxAttempts, then throws", async () => {
  const { fetch, calls } = stubFetch([{ status: 529, body: "overloaded" }]);
  const client = new TypeSafeClient({ apiKey: "k", fetch, sleep: noSleep, maxAttempts: 3 });

  await assert.rejects(() => client.evaluate({}), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 529);
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(calls.length, 3);
});

test("does not retry a 401", async () => {
  const { fetch, calls } = stubFetch([{ status: 401, body: "bad key" }]);
  const client = new TypeSafeClient({ apiKey: "k", fetch, sleep: noSleep });

  await assert.rejects(() => client.evaluate({}), /HTTP 401/);
  assert.equal(calls.length, 1);
});

test("waits at least as long as Retry-After", async () => {
  const delays = [];
  const { fetch } = stubFetch([
    { status: 429, body: "", headers: { "retry-after": "5" } },
    { status: 200, body: "{}" },
  ]);
  const client = new TypeSafeClient({
    apiKey: "k",
    fetch,
    baseDelayMs: 10,
    sleep: async (ms) => void delays.push(ms),
  });

  await client.evaluate({});
  assert.equal(delays.length, 1);
  assert.ok(delays[0] >= 5000, `expected >= 5000ms, got ${delays[0]}`);
});

test("treats a transport failure as retryable", async () => {
  const { fetch, calls } = stubFetch([new Error("ECONNRESET")]);
  const client = new TypeSafeClient({ apiKey: "k", fetch, sleep: noSleep, maxAttempts: 2 });

  await assert.rejects(() => client.evaluate({}), /network error/);
  assert.equal(calls.length, 2);
});

test("rejects a 2xx that is not JSON", async () => {
  const { fetch } = stubFetch([{ status: 200, body: "<html>gateway</html>" }]);
  const client = new TypeSafeClient({ apiKey: "k", fetch, sleep: noSleep, maxAttempts: 1 });

  await assert.rejects(() => client.evaluate({}), /gateway/);
});

test("requires an API key", () => {
  assert.throws(() => new TypeSafeClient({ apiKey: "" }), /requires an apiKey/);
});

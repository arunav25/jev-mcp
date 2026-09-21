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

  assert.equal(result.json.answers.a.noul, 0.91);
  assert.equal(result.raw, '{"answers":{"a":{"type":"noul","noul":0.91}}}', "the API's own bytes are kept");
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

  assert.deepEqual((await client.evaluate({})).json, { ok: true });
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

// ── Oversized responses ────────────────────────────────────────────────────
// A body that cannot be read whole is not one to make a decision from, and
// asking again just produces the same oversized body. It used to be wrapped as
// a transport error, which made it retryable: one overlong reply cost four
// round trips and then reported a network failure.

import { ResponseTooLargeError } from "../src/client.js";

/** A response whose body arrives as a stream, like a real fetch. */
function streamingResponse({ status = 200, text = "", chunkSize = 64 * 1024, headers = {} } = {}) {
  const bytes = Buffer.from(text, "utf8");
  let offset = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    body: {
      getReader: () => ({
        read: async () => {
          if (offset >= bytes.length) return { done: true, value: undefined };
          const slice = bytes.subarray(offset, offset + chunkSize);
          offset += slice.length;
          return { done: false, value: new Uint8Array(slice) };
        },
        releaseLock: () => {},
      }),
    },
    text: async () => text,
  };
}

test("reads a streamed body correctly, multi-byte characters included", async () => {
  const payload = JSON.stringify({ answers: { a: "café – 日本語" } });
  const client = new TypeSafeClient({
    apiKey: "k",
    sleep: noSleep,
    fetch: async () => streamingResponse({ text: payload, chunkSize: 7 }),
  });

  const result = await client.evaluate({});
  assert.equal(result.raw, payload, "chunk boundaries must not corrupt the text");
  assert.equal(result.json.answers.a, "café – 日本語");
});

test("an oversized body is rejected once, never retried", async () => {
  let calls = 0;
  const huge = "x".repeat(9 * 1024 * 1024);
  const client = new TypeSafeClient({
    apiKey: "k",
    sleep: noSleep,
    maxAttempts: 4,
    fetch: async () => {
      calls++;
      return streamingResponse({ text: huge, chunkSize: 1024 * 1024 });
    },
  });

  await assert.rejects(() => client.evaluate({}), (error) => {
    assert.ok(error instanceof ResponseTooLargeError, `got ${error.name}`);
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(calls, 1, "an unreadable body must not be requested again");
});

test("an oversized body is rejected rather than returned truncated", async () => {
  const huge = `{"answers":{"a":"${"x".repeat(9 * 1024 * 1024)}"}}`;
  const client = new TypeSafeClient({
    apiKey: "k",
    sleep: noSleep,
    maxAttempts: 1,
    // No stream: exercises the buffering fallback.
    fetch: async () => ({
      ok: true, status: 200, headers: { get: () => null }, text: async () => huge,
    }),
  });

  await assert.rejects(() => client.evaluate({}), ResponseTooLargeError);
});

test("a declared content-length past the cap short-circuits before reading", async () => {
  let read = false;
  const client = new TypeSafeClient({
    apiKey: "k",
    sleep: noSleep,
    maxAttempts: 3,
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: (n) => (n.toLowerCase() === "content-length" ? String(64 * 1024 * 1024) : null) },
      text: async () => ((read = true), "{}"),
    }),
  });

  await assert.rejects(() => client.evaluate({}), ResponseTooLargeError);
  assert.equal(read, false, "the body should never be pulled");
});

test("byte length, not character count, decides the cap", async () => {
  // 5M three-byte characters is 15MB of UTF-8 but only 5M JS characters.
  const client = new TypeSafeClient({
    apiKey: "k",
    sleep: noSleep,
    maxAttempts: 1,
    fetch: async () => ({
      ok: true, status: 200, headers: { get: () => null }, text: async () => "日".repeat(5 * 1024 * 1024),
    }),
  });

  await assert.rejects(() => client.evaluate({}), ResponseTooLargeError);
});

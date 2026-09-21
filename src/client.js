/**
 * HTTP client for the TypeSafe evaluation endpoint.
 *
 * Two failure modes matter to a caller: the request was wrong (4xx, no point
 * retrying) and the service was momentarily unavailable (429/529/network,
 * worth another attempt). ApiError carries enough to tell them apart.
 */

import { baseUrl as defaultBaseUrl, EVALUATE_PATH } from "./config.js";

/** Statuses worth another attempt. */
const TRANSIENT = new Set([429, 502, 503, 504, 529]);

/** Ceiling on a response body, so a runaway reply cannot exhaust memory. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * A body that overran the cap.
 *
 * Kept separate from ApiError because it must never be retried: the reply was
 * not readable in full, so it is not something to make a decision from, and
 * asking again will produce the same oversized reply. Treating it as a
 * transport blip meant one overlong response cost four round trips.
 */
export class ResponseTooLargeError extends Error {
  constructor(bytes) {
    super(`TypeSafe response exceeds the ${MAX_RESPONSE_BYTES} byte limit (read ${bytes}+ bytes)`);
    this.name = "ResponseTooLargeError";
    this.bytes = bytes;
  }

  get retryable() {
    return false;
  }
}

export class ApiError extends Error {
  /**
   * @param {number} status HTTP status, or 0 when the request never landed.
   * @param {string} body Raw response body, truncated for the message.
   */
  constructor(status, body) {
    const label = status ? `HTTP ${status}` : "network error";
    super(`TypeSafe request failed (${label}): ${truncate(body, 600)}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }

  get retryable() {
    return this.status === 0 || TRANSIENT.has(this.status);
  }
}

export class TypeSafeClient {
  /**
   * @param {object} options
   * @param {string} options.apiKey
   * @param {string} [options.baseUrl]
   * @param {number} [options.maxAttempts] Total tries, including the first.
   * @param {number} [options.timeoutMs] Per-attempt deadline.
   * @param {number} [options.baseDelayMs] First backoff step; doubles after.
   * @param {typeof fetch} [options.fetch] Injected for tests.
   * @param {(ms: number) => Promise<void>} [options.sleep] Injected for tests.
   */
  constructor({
    apiKey,
    baseUrl = defaultBaseUrl(),
    maxAttempts = 4,
    timeoutMs = 90_000,
    baseDelayMs = 700,
    fetch: fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
  }) {
    if (!apiKey) throw new Error("TypeSafeClient requires an apiKey");
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.maxAttempts = Math.max(1, maxAttempts);
    this.timeoutMs = timeoutMs;
    this.baseDelayMs = baseDelayMs;
    this.fetch = fetchImpl;
    this.sleep = sleep;
  }

  /**
   * Posts an evaluation request.
   * @param {object} payload Request body, already validated by the caller.
   * @param {AbortSignal} [signal] Cancels the whole retry sequence.
   * @returns {Promise<{raw: string, json: object}>} `raw` is the API's own
   *   bytes, kept so a caller can forward exactly what the API said instead of
   *   a re-serialization of it; `json` is the same content parsed.
   */
  async evaluate(payload, signal) {
    const url = this.baseUrl + EVALUATE_PATH;
    const body = JSON.stringify(payload);
    let lastError;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      signal?.throwIfAborted();
      let result;
      try {
        result = await this.#attempt(url, body, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        // An unreadable body is a dead end, not a blip — surface it at once.
        if (error instanceof ResponseTooLargeError) throw error;
        // A transport failure looks the same as a 5xx from here.
        result = { error: new ApiError(0, String(error?.message ?? error)) };
      }

      if (result.ok) return result.value;

      lastError = result.error;
      const isLast = attempt === this.maxAttempts;
      if (isLast || !lastError.retryable) throw lastError;

      await this.sleep(this.#delayFor(attempt, result.retryAfter), signal);
    }

    throw lastError;
  }

  /** One request/response round trip. Never throws for an HTTP error status. */
  async #attempt(url, body, signal) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    const response = await this.fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body,
      signal: combined,
    });

    const text = await readCapped(response);

    if (!response.ok) {
      return {
        ok: false,
        error: new ApiError(response.status, text),
        retryAfter: parseRetryAfter(response.headers?.get?.("retry-after")),
      };
    }

    try {
      return { ok: true, value: { raw: text, json: text ? JSON.parse(text) : {} } };
    } catch {
      // A 2xx that is not JSON is a broken gateway, not a usable answer.
      return { ok: false, error: new ApiError(response.status, text) };
    }
  }

  /** Exponential backoff, jittered, but never shorter than a Retry-After. */
  #delayFor(attempt, retryAfterMs) {
    const backoff = this.baseDelayMs * 2 ** (attempt - 1);
    const jittered = backoff * (0.75 + Math.random() * 0.5);
    return Math.round(Math.max(jittered, retryAfterMs ?? 0));
  }
}

/**
 * Reads a body, refusing anything past the cap.
 *
 * Streams and stops at the first chunk that crosses the limit, so an oversized
 * reply is never fully buffered. Counting is in bytes, not characters: a
 * character count under-reports any multi-byte UTF-8 and lets the real figure
 * drift above the cap.
 *
 * Reading the whole body and then checking its length would still reject, but
 * only after holding all of it in memory — which is the thing the cap exists
 * to prevent.
 */
async function readCapped(response) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new ResponseTooLargeError(declared);
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    // No stream available (some stubs, some polyfills): fall back to buffering.
    const text = await response.text();
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MAX_RESPONSE_BYTES) throw new ResponseTooLargeError(bytes);
    return text;
  }

  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new ResponseTooLargeError(total);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

/** Retry-After is either seconds or an HTTP date. */
function parseRetryAfter(header) {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(header);
  return Number.isNaN(when) ? undefined : Math.max(0, when - Date.now());
}

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    function finish() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
  });
}

function truncate(text, limit) {
  const clean = (text ?? "").trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean || "(empty response)";
}

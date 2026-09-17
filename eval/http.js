/** Minimal retrying JSON POST for the baseline adapters. */

const TRANSIENT = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export async function postJson(url, { headers, body, attempts = 4, timeoutMs = 60_000, signal }) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const text = await response.text();
      if (response.ok) return JSON.parse(text);

      lastError = new Error(`HTTP ${response.status}: ${text.slice(0, 400)}`);
      lastError.status = response.status;
      if (!TRANSIENT.has(response.status)) throw lastError;
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
      if (error.status && !TRANSIENT.has(error.status)) throw error;
    }
    if (attempt < attempts) {
      await new Promise((r) => setTimeout(r, 700 * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5)));
    }
  }
  throw lastError;
}

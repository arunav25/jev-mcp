/**
 * Baseline adapter for an OpenAI-compatible chat API.
 *
 * Two ways to get a probability out of a chat model:
 *
 *   logprobs   — constrain the reply to one token and read the distribution
 *                over "Yes" and "No". Closest thing to a real probability a
 *                chat model can give, and the only fair comparison.
 *   verbalized — ask it to state a number. Easy, and usually badly calibrated
 *                (models cluster on 0.8, 0.9, 0.95). Included because it is
 *                what most hand-rolled comparisons actually do.
 */

import { postJson } from "../http.js";
import { normalizeUsage } from "../performance.js";

const YES = /^\s*(yes|y|true|1)\b/i;
const NO = /^\s*(no|n|false|0)\b/i;

export function createOpenAIAdapter({
  model = "gpt-4o-mini",
  mode = "logprobs",
  baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  apiKey = process.env.OPENAI_API_KEY,
  temperature = 0,
} = {}) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set (or pass apiKey)");
  if (!["logprobs", "verbalized"].includes(mode)) throw new Error(`unknown mode "${mode}"`);

  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const headers = { authorization: `Bearer ${apiKey}` };

  return {
    name: `openai:${model}:${mode}`,
    method: mode,
    describe: () => `${model} via ${baseUrl} (${mode})`,
    fingerprint: { system: "openai", model, mode, temperature },

    async predict(item, { question, signal }) {
      const content = `${question}\n\n<input>\n${render(item.state)}\n</input>`;

      if (mode === "logprobs") {
        const data = await postJson(url, {
          headers,
          signal,
          body: {
            model,
            temperature,
            max_tokens: 1,
            logprobs: true,
            top_logprobs: 20,
            messages: [
              { role: "system", content: 'Answer with exactly one word: "Yes" or "No". No punctuation, no explanation.' },
              { role: "user", content },
            ],
          },
        });

        const top = data?.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs;
        if (!Array.isArray(top) || !top.length) {
          throw new Error("the endpoint returned no logprobs — rerun with mode=verbalized");
        }

        let yes = 0;
        let no = 0;
        for (const { token, logprob } of top) {
          const mass = Math.exp(logprob);
          if (YES.test(token)) yes += mass;
          else if (NO.test(token)) no += mass;
        }
        if (yes + no === 0) throw new Error(`neither Yes nor No appeared in the top tokens: ${top.map((t) => JSON.stringify(t.token)).join(",")}`);

        return { probability: yes / (yes + no), raw: { yesMass: yes, noMass: no }, usage: normalizeUsage(data?.usage) };
      }

      const data = await postJson(url, {
        headers,
        signal,
        body: {
          model,
          temperature,
          max_tokens: 8,
          messages: [
            { role: "system", content: "Reply with a single probability between 0 and 1, to two decimals. Nothing else." },
            { role: "user", content },
          ],
        },
      });
      return {
        probability: parseProbability(data?.choices?.[0]?.message?.content),
        raw: data?.choices?.[0]?.message,
        usage: normalizeUsage(data?.usage),
      };
    },
  };
}

/**
 * Parses a verbalized probability, strictly.
 *
 * Leniency here corrupts results silently, which is worse than failing: an
 * earlier version matched the first digits anywhere in the string, so "-0.8"
 * became 0.8, "1%" became 1, and "1.5" was rescaled to 0.015. A reply that
 * does not parse is recorded as a failed prediction and shows up in the
 * report's coverage line, where it can be seen.
 */
export function parseProbability(text) {
  const raw = String(text ?? "").trim();
  const match = raw.match(/^([0-9]*\.?[0-9]+)\s*(%?)\.?$/);
  if (!match) {
    throw new Error(`expected a bare probability, got ${JSON.stringify(raw.slice(0, 80))}`);
  }

  const value = Number(match[1]);
  if (!Number.isFinite(value)) throw new Error(`not a finite number: ${JSON.stringify(raw)}`);

  if (match[2] === "%") {
    if (value > 100) throw new Error(`percentage out of range: ${value}%`);
    return value / 100;
  }
  if (value > 1) {
    // Never guess that "1.5" or "85" meant a percentage; the caller should fix
    // the prompt rather than have the harness invent a scale.
    throw new Error(`expected a value in [0,1] or an explicit percentage, got ${value}`);
  }
  return value;
}

export function render(state) {
  return typeof state === "string" ? state : JSON.stringify(state, null, 2);
}

/**
 * Baseline adapter for the Anthropic Messages API.
 *
 * The API exposes no logprobs, so this is verbalized-probability only. Read
 * its calibration numbers with that in mind: a verbalized baseline losing on
 * ECE is partly an artefact of the interface, not only of the model.
 */

import { postJson } from "../http.js";
import { parseProbability, render } from "./openai.js";

export function createAnthropicAdapter({
  model = "claude-sonnet-4-5",
  apiKey = process.env.ANTHROPIC_API_KEY,
  baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
  version = "2023-06-01",
} = {}) {
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set (or pass apiKey)");

  return {
    name: `anthropic:${model}:verbalized`,
    method: "verbalized",
    describe: () => `${model} via the Messages API (verbalized probability)`,
    fingerprint: { system: "anthropic", model },

    async predict(item, { question, signal }) {
      const data = await postJson(`${baseUrl.replace(/\/+$/, "")}/v1/messages`, {
        headers: { "x-api-key": apiKey, "anthropic-version": version },
        signal,
        body: {
          model,
          max_tokens: 8,
          temperature: 0,
          system: "Reply with a single probability between 0 and 1, to two decimals. Nothing else.",
          messages: [{ role: "user", content: `${question}\n\n<input>\n${render(item.state)}\n</input>` }],
        },
      });
      const text = data?.content?.find((block) => block.type === "text")?.text;
      return { probability: parseProbability(text), raw: { text } };
    },
  };
}

/** JEV adapter: one noul question per item, probability read straight off. */

import { TypeSafeClient } from "../../src/client.js";
import { baseUrl, requireApiKey, DEFAULT_MODEL } from "../../src/config.js";

const QUESTION_ID = "target";

export function createJevAdapter({ model = DEFAULT_MODEL, criteria, env = process.env } = {}) {
  const client = new TypeSafeClient({ apiKey: requireApiKey(env), baseUrl: baseUrl(env) });

  return {
    name: `jev:${model}`,
    describe: () => `TypeSafe ${model} via /v1/systemone, noul question`,
    fingerprint: { system: "jev", model, criteria },

    async predict(item, { question, signal }) {
      const response = await client.evaluate(
        {
          state: item.state,
          model,
          questions: { [QUESTION_ID]: { type: "noul", instructions: question, ...(criteria ? { criteria } : {}) } },
        },
        signal,
      );

      const answer = response?.answers?.[QUESTION_ID];
      if (typeof answer?.noul !== "number") {
        throw new Error(`no noul value in response: ${JSON.stringify(response).slice(0, 300)}`);
      }
      return { probability: answer.noul, raw: answer };
    },
  };
}

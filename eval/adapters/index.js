/** Adapter registry. Add a system here and every command picks it up. */

import { createJevAdapter } from "./jev.js";
import { createOpenAIAdapter } from "./openai.js";
import { createAnthropicAdapter } from "./anthropic.js";

export const ADAPTERS = {
  jev: createJevAdapter,
  openai: createOpenAIAdapter,
  anthropic: createAnthropicAdapter,
};

/** Builds an adapter from a "kind:key=value,key=value" spec. */
export function createAdapter(spec) {
  const [kind, ...rest] = String(spec).split(":");
  const factory = ADAPTERS[kind];
  if (!factory) throw new Error(`unknown system "${kind}". Choose from ${Object.keys(ADAPTERS).join(", ")}.`);

  const options = {};
  for (const pair of rest.join(":").split(",").filter(Boolean)) {
    const [key, ...value] = pair.split("=");
    options[key] = value.join("=");
  }
  return factory(options);
}

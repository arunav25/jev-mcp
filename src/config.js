/**
 * Shared configuration: endpoint defaults, environment lookup, and the
 * guidance the server hands to a connecting agent.
 */

export const DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const EVALUATE_PATH = "/v1/systemone";
export const DEFAULT_MODEL = "jev-latest";

/** Server name advertised over MCP. Also the key written into client configs. */
export const SERVER_NAME = "jev";

/** Environment variables carried into a client's launch environment. */
export const ENV_PREFIX = "TYPESAFE_";
export const API_KEY_VAR = "TYPESAFE_API_KEY";
export const BASE_URL_VAR = "TYPESAFE_BASE_URL";

export const CONSOLE_URL = "https://console.typesafe.ai/";
export const DOCS_URL = "https://docs.typesafe.ai/";

/**
 * Reads the API key, failing with a message that says how to get one.
 * @returns {string}
 */
export function requireApiKey(env = process.env) {
  const key = env[API_KEY_VAR]?.trim();
  if (!key) {
    throw new Error(
      `${API_KEY_VAR} is not set. Create a key at ${CONSOLE_URL} and export it before starting the server.`,
    );
  }
  return key;
}

/** Base URL override, for staging environments and tests. */
export function baseUrl(env = process.env) {
  return (env[BASE_URL_VAR]?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/** Every TYPESAFE_* pair in the environment, as a plain object. */
export function typesafeEnv(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name, value]) => name.startsWith(ENV_PREFIX) && value !== undefined,
    ),
  );
}

/**
 * Usage notes sent once at initialize. An agent reads this before it has seen
 * the tool fire, so it covers the mistakes that are expensive to discover.
 */
export const SERVER_INSTRUCTIONS = `This server exposes one tool, "evaluate", backed by Jev — a classifier that returns
a probability distribution rather than prose. Reach for it when you need a decision you can branch on
(is this urgent, which queue owns it, how severe is it) instead of a paragraph you would have to parse.

Writing a good call:

- Separate the evidence from the judgment. Everything the decision depends on goes in "state"; what to
  decide goes in a question's "instructions". A question never sees anything outside "state".
- Put in "state" what you observed, not what you concluded about it. The raw ticket, diff, log or field
  values, or a faithful condensation that keeps the doubts and the counterevidence. A verdict you have
  already reached reads to the classifier as evidence for itself, so the probability that comes back is
  your own conclusion echoed with a number on it, not an independent check. That is the single most
  expensive mistake available here, because the answer looks like corroboration.
- Word instructions as the condition to test, not the answer you are expecting. "Does this message
  report a failed payout?" — not "Confirm this urgent payout failure."
- The key you give a question is a label for your own code. The model is not shown it, so the
  instructions have to stand alone — "urgent" as a key explains nothing; say what urgent means here.
- Ask one thing per question. Two judgments in one set of instructions produce a blurred distribution.
- Questions in a single call are evaluated together over the same state and cannot read one another's
  answers. If step two depends on step one, make two calls.
- Prefer a structured object for "state" when the input has parts (author, subject, body, history).
  Name the fields, then refer to them from the instructions.
- Send long identifiers as strings. Numbers cross this server as IEEE-754 doubles, so an integer above
  9007199254740991 loses its last digits, and two distinct ids can arrive identical. Quote them.

Reading the result:

- noul returns one number: the probability the condition holds. 0.5 is maximum uncertainty, not a
  middling amount of the quality you asked about.
- choice returns the winning option plus the probability of each. A narrow margin between the top two
  usually means the criteria overlap, not that the input is unusual.
- score is 0-indexed over the levels you supplied: N levels answer between 0 and N-1, so 3.87 across 5
  levels sits between the fourth and fifth level, not at 3.87 out of 5. The response carries a "legend"
  naming each index and a probability per level — quote the legend's words, not the bare number.
- confidence describes how concentrated the distribution is. It is not a measure of correctness.

Give a choice question an explicit escape option when the input might match nothing.

Reference: ${DOCS_URL}`;

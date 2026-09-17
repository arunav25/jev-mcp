/**
 * The "evaluate" tool: schema, pre-flight validation, and the handler that
 * forwards a well-formed request to the API.
 *
 * Validating criteria shapes here rather than letting the API reject them
 * turns a 422 round trip into an immediate, specific message the agent can
 * act on without burning a call.
 */

import { z } from "zod";
import { DEFAULT_MODEL } from "./config.js";
import { ApiError } from "./client.js";

/** Free-form content: prose, or structured data with named fields. */
const contentSchema = z.union([z.string(), z.record(z.string(), z.any()), z.array(z.any())]);

const questionSchema = z
  .object({
    type: z
      .enum(["noul", "choice", "score"])
      .describe(
        'Judgment shape. "noul": probability a stated condition holds. ' +
          '"choice": pick one option from a named set. ' +
          '"score": position on ordered, described levels.',
      ),
    instructions: contentSchema.describe(
      "What to judge, stated so it stands on its own. The question's key is not shown to the " +
        "model, so define any term that carries weight. Use an object or array to supply " +
        "definitions, contrasts or worked examples.",
    ),
    criteria: z
      .any()
      .optional()
      .describe(
        'Shape follows "type". noul (optional): {"true": ..., "false": ...} describing each side. ' +
          "choice (required): an object mapping each option to a description, or to null when the " +
          "name speaks for itself. score (required): an ordered array of at least two level " +
          "descriptions, lowest first.",
      ),
  })
  .superRefine(checkCriteria);

export const evaluateInputSchema = {
  state: contentSchema.describe(
    "The material being judged, and only that. Every question in the call reads this same " +
      "value and nothing else, so anything the decision depends on has to appear here. " +
      "Prefer an object with named fields when the input has parts.",
  ),
  questions: z
    .record(z.string().min(1), questionSchema)
    .describe(
      "Questions keyed by an id of your choosing; answers come back under those same ids. " +
        "Questions in one call run together over the same state and cannot see each other's " +
        "answers — split dependent judgments across calls.",
    ),
  model: z
    .string()
    .optional()
    .describe(`Model identifier. Defaults to "${DEFAULT_MODEL}".`),
};

/** Per-type criteria rules, reported against the offending path. */
function checkCriteria(question, ctx) {
  const { type, criteria } = question;
  const fail = (message) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["criteria"], message });

  if (type === "noul") {
    if (criteria === undefined || criteria === null) return;
    if (!isPlainObject(criteria)) return fail('noul criteria must be an object with "true" and/or "false" keys.');
    const unknown = Object.keys(criteria).filter((key) => key !== "true" && key !== "false");
    if (unknown.length) fail(`noul criteria accepts only "true" and "false"; found ${unknown.join(", ")}.`);
    return;
  }

  if (type === "choice") {
    if (!isPlainObject(criteria)) return fail("choice requires criteria: an object mapping each option to a description or null.");
    const options = Object.keys(criteria);
    if (options.length < 2) return fail("choice requires at least two options.");
    const bad = options.filter((key) => criteria[key] !== null && typeof criteria[key] !== "string");
    if (bad.length) fail(`choice option descriptions must be a string or null; check ${bad.join(", ")}.`);
    return;
  }

  if (!Array.isArray(criteria)) return fail("score requires criteria: an ordered array of level descriptions, lowest first.");
  if (criteria.length < 2) return fail("score requires at least two levels.");
  if (criteria.some((level) => typeof level !== "string" || !level.trim())) {
    fail("each score level must be a non-empty string describing a recognisable situation.");
  }
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const evaluateToolConfig = {
  title: "Evaluate with Jev",
  description:
    "Judge some content against one or more typed questions and get back probabilities rather " +
    "than prose — a yes/no likelihood (noul), a pick from a named set (choice), or a position on " +
    "ordered levels (score). Use it wherever you would otherwise ask a model for an answer and " +
    "then parse the reply.",
  inputSchema: evaluateInputSchema,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
};

/**
 * Builds the tool handler bound to a client.
 * @param {import("./client.js").TypeSafeClient} client
 */
export function createEvaluateHandler(client) {
  return async function evaluate({ state, questions, model }, extra) {
    if (state === undefined || state === null || state === "") {
      return toolError("state is required: put the material being judged there.");
    }
    if (!questions || Object.keys(questions).length === 0) {
      return toolError("questions is required and must contain at least one question.");
    }

    try {
      const result = await client.evaluate(
        { state, questions, model: model?.trim() || DEFAULT_MODEL },
        extra?.signal,
      );
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      if (error instanceof ApiError) return toolError(explain(error));
      throw error;
    }
  };
}

/** Turns an API failure into something an agent can act on. */
function explain(error) {
  switch (error.status) {
    case 401:
    case 403:
      return `${error.message}\n\nThe API key was rejected. Check TYPESAFE_API_KEY, then restart this server so it picks up the new value.`;
    case 422:
      return `${error.message}\n\nThe request shape was rejected. Most often a choice question is missing its criteria map, or a score question has fewer than two levels.`;
    case 429:
      return `${error.message}\n\nRate limited after several retries. Batch independent questions into one call rather than issuing them separately.`;
    default:
      return error.message;
  }
}

function toolError(text) {
  return { isError: true, content: [{ type: "text", text }] };
}

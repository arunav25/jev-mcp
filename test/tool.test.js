import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { createEvaluateHandler, evaluateInputSchema } from "../src/tool.js";
import { ApiError } from "../src/client.js";

const schema = z.object(evaluateInputSchema);

const parse = (input) => schema.safeParse(input);
const question = (extra) => ({ questions: { q: extra }, state: "text" });

test("accepts a noul question with no criteria", () => {
  assert.equal(parse(question({ type: "noul", instructions: "Is this urgent?" })).success, true);
});

test("accepts noul criteria limited to true and false", () => {
  const good = parse(question({ type: "noul", instructions: "x", criteria: { true: "a", false: "b" } }));
  assert.equal(good.success, true);

  const bad = parse(question({ type: "noul", instructions: "x", criteria: { maybe: "c" } }));
  assert.equal(bad.success, false);
  assert.match(bad.error.issues[0].message, /only "true" and "false"/);
});

test("requires a choice question to carry at least two options", () => {
  const missing = parse(question({ type: "choice", instructions: "which team" }));
  assert.equal(missing.success, false);
  assert.match(missing.error.issues[0].message, /choice requires criteria/);

  const thin = parse(question({ type: "choice", instructions: "which team", criteria: { billing: null } }));
  assert.equal(thin.success, false);
  assert.match(thin.error.issues[0].message, /at least two options/);

  const good = parse(
    question({ type: "choice", instructions: "which team", criteria: { billing: "payments", tech: null } }),
  );
  assert.equal(good.success, true);
});

test("rejects a non-string choice description", () => {
  const result = parse(question({ type: "choice", instructions: "x", criteria: { a: 1, b: "ok" } }));
  assert.equal(result.success, false);
  assert.match(result.error.issues[0].message, /string or null/);
});

test("requires score levels to be an ordered array of at least two strings", () => {
  assert.equal(parse(question({ type: "score", instructions: "x", criteria: { low: "a" } })).success, false);
  assert.equal(parse(question({ type: "score", instructions: "x", criteria: ["only one"] })).success, false);
  assert.equal(parse(question({ type: "score", instructions: "x", criteria: ["calm", "on fire"] })).success, true);

  const blank = parse(question({ type: "score", instructions: "x", criteria: ["calm", "  "] }));
  assert.equal(blank.success, false);
  assert.match(blank.error.issues[0].message, /non-empty string/);
});

test("accepts structured state and instructions", () => {
  const result = parse({
    state: { subject: "Payouts failing", body: "three days now" },
    questions: { urgent: { type: "noul", instructions: { asks: "urgency?", note: "tone counts" } } },
  });
  assert.equal(result.success, true);
});

test("rejects an unknown question type", () => {
  assert.equal(parse(question({ type: "vibes", instructions: "x" })).success, false);
});

test("handler applies the default model and returns the body as text", async () => {
  let sent;
  const body = '{"answers":{"urgent":{"type":"noul","noul":0.8}}}';
  const handler = createEvaluateHandler({
    evaluate: async (payload) => {
      sent = payload;
      return { raw: body, json: JSON.parse(body) };
    },
  });

  const result = await handler({ state: "s", questions: { urgent: { type: "noul", instructions: "i" } } });

  assert.equal(sent.model, "jev-latest");
  assert.ok(!result.isError);
  assert.equal(result.content[0].text, body, "the API response is forwarded byte for byte");
});

test("handler honours an explicit model", async () => {
  let sent;
  const handler = createEvaluateHandler({ evaluate: async (p) => ((sent = p), { raw: "{}", json: {} }) });
  await handler({ state: "s", questions: { a: {} }, model: "  jev-2  " });
  assert.equal(sent.model, "jev-2");
});

test("handler reports missing state and empty questions without calling the API", async () => {
  let called = false;
  const handler = createEvaluateHandler({ evaluate: async () => ((called = true), { raw: "{}", json: {} }) });

  assert.match((await handler({ questions: { a: {} } })).content[0].text, /state is required/);
  assert.match((await handler({ state: "s", questions: {} })).content[0].text, /at least one question/);
  assert.equal(called, false);
});

test("handler turns API failures into guidance", async () => {
  const handlerFor = (status, body) =>
    createEvaluateHandler({
      evaluate: async () => {
        throw new ApiError(status, body);
      },
    });
  const input = { state: "s", questions: { a: {} } };

  assert.match((await handlerFor(401, "bad key")(input)).content[0].text, /TYPESAFE_API_KEY/);
  assert.match((await handlerFor(422, "nope")(input)).content[0].text, /criteria map/);
  assert.match((await handlerFor(429, "slow")(input)).content[0].text, /Batch independent questions/);
  assert.equal((await handlerFor(500, "boom")(input)).isError, true);
});

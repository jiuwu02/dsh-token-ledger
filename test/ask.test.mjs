/**
 * The question answerer: what it may answer, what it must refuse, and what it
 * hands back to the human.
 *
 * Two properties matter more than any single answer here, and both are pinned
 * below. First, a batch in a forbidden zone is never sent to a model at all —
 * permissions, credentials, deletions, payment and publishing have to be
 * refused before the call, not argued about afterwards. Second, every failure
 * mode declines (returns null) rather than throwing or inventing an answer, so
 * the platform's waterfall continues to the human and no question is lost.
 *
 * The model is faked: `llm.stream` is a stub that replays a canned text, and
 * `ctx.get` answers only what answerQuestions reads. That keeps the test on the
 * plugin's own logic — request shaping, validation, the wait budget and the
 * ledger record — without a network or a real profile.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const load = (relative) => import(pathToFileURL(join(root, relative)).href);

// schema.js first: the module graph has a circular edge through it.
await load("lib/schema.js");
const { DEFAULT_ASK_PROMPT, shouldDefer, parseAnswerBatch, answerQuestions } =
  await load("lib/ask.js");

// The ledger writes under the storage directory the Host context exposes, so a
// scratch DSH_HOME keeps these runs out of the real profile.
const scratch = mkdtempSync(join(tmpdir(), "dsh-ask-"));
process.env.DSH_HOME = scratch;

const question = (over) => ({
  id: "q1",
  question: "Which file should I edit?",
  ...over,
});

// --- 1. The instruction is a real closing constraint --------------------
assert.ok(DEFAULT_ASK_PROMPT.length > 500, "the default instruction is not a stub");
assert.match(DEFAULT_ASK_PROMPT, /Emit ONLY one JSON object/u);
assert.match(DEFAULT_ASK_PROMPT, /no tool may be called/iu);
assert.match(DEFAULT_ASK_PROMPT, /empty answers array/iu);

// --- 2. Forbidden zones are refused before any model call --------------
const forbidden = [
  { label: "permission wording", request: { questions: [question({ question: "May I approve this permission prompt?" })] } },
  { label: "an intent batch (approval)", request: { questions: [question({ intent: "approval" })] } },
  { label: "an intent batch (plan review)", request: { questions: [question({ intent: "plan-review" })] } },
  { label: "credentials", request: { questions: [question({ question: "What is the API key for the deploy?" })] } },
  { label: "a Chinese credential question", request: { questions: [question({ question: "请输入你的密码" })] } },
  { label: "an irreversible delete", request: { questions: [question({ question: "Delete the production database?" })] } },
  { label: "payment", request: { questions: [question({ question: "Should I purchase the pro plan?" })] } },
  { label: "publishing", request: { questions: [question({ question: "Publish this to production now?" })] } },
  { label: "a sandbox escalation", request: { questions: [question({ question: "Escalate the sandbox for this command?" })] } },
  // The risky word can hide in an option rather than the question.
  { label: "a forbidden option label", request: { questions: [question({ options: [{ label: "Yes, approve and grant admin" }] })] } },
  { label: "an empty batch", request: { questions: [] } },
];
for (const testCase of forbidden)
  assert.equal(shouldDefer(testCase.request), true, testCase.label);

// Ordinary engineering questions must NOT be deferred, or the feature is dead.
const allowed = [
  { questions: [question({ question: "Which file should I edit?" })] },
  { questions: [question({ question: "Should I use a Map or an object here?" , options: [{ label: "Map" }, { label: "Object" }] })] },
  { questions: [question({ question: "Which test suite should run first?", header: "Testing" })] },
  { questions: [question({ question: "Continue with the refactor?" })] },
];
for (const request of allowed)
  assert.equal(shouldDefer(request), false, request.questions[0].question);

// --- 3. Answer validation: exact labels, one entry per question --------
const attribution = "(answered by workbuddy/hy4free)";
const twoQuestions = [
  {
    id: "a",
    question: "Which file?",
    options: [{ label: "index.js" }, { label: "client.js" }],
  },
  { id: "b", question: "Why?", options: undefined },
];
assert.deepEqual(
  parseAnswerBatch(
    '{"answers":[{"id":"a","selected":["index.js"]},{"id":"b","custom":"it is the entry"}]}',
    twoQuestions,
    attribution,
  ),
  {
    answers: [
      { id: "a", selected: ["index.js"], custom: attribution },
      { id: "b", selected: [], custom: "it is the entry " + attribution },
    ],
  },
);
// A fenced answer is still an answer: models wrap JSON unhelpfully often.
assert.notEqual(
  parseAnswerBatch(
    '```json\n{"answers":[{"id":"a","selected":["client.js"]},{"id":"b","custom":"x"}]}\n```',
    twoQuestions,
    attribution,
  ),
  null,
);
// A bare array is accepted too.
assert.notEqual(
  parseAnswerBatch(
    '[{"id":"a","selected":["client.js"]},{"id":"b","custom":"x"}]',
    twoQuestions,
    attribution,
  ),
  null,
);

// Everything below is a refusal, not a repair.
const refusals = [
  { label: "not JSON", text: "I would pick index.js.", questions: twoQuestions },
  { label: "missing a question", text: '{"answers":[{"id":"a","selected":["index.js"]}]}', questions: twoQuestions },
  { label: "an unknown id", text: '{"answers":[{"id":"a","selected":["index.js"]},{"id":"z","custom":"x"}]}', questions: twoQuestions },
  { label: "an invented label", text: '{"answers":[{"id":"a","selected":["README.md"]},{"id":"b","custom":"x"}]}', questions: twoQuestions },
  { label: "two labels on a single-select", text: '{"answers":[{"id":"a","selected":["index.js","client.js"]},{"id":"b","custom":"x"}]}', questions: twoQuestions },
  { label: "an empty answer", text: '{"answers":[{"id":"a","selected":[]},{"id":"b","custom":"x"}]}', questions: twoQuestions },
  { label: "blank text", text: "   ", questions: twoQuestions },
];
for (const testCase of refusals)
  assert.equal(
    parseAnswerBatch(testCase.text, testCase.questions, attribution),
    null,
    testCase.label,
  );
// multiSelect is what makes several labels legal.
assert.notEqual(
  parseAnswerBatch(
    '{"answers":[{"id":"a","selected":["index.js","client.js"]}]}',
    [{ id: "a", question: "Which files?", multiSelect: true, options: [{ label: "index.js" }, { label: "client.js" }] }],
    attribution,
  ),
  null,
);

// --- 4. answerQuestions: the call it makes, and the ways it declines ----
const calls = [];
const makeCtx = (reply) => ({
  get: (name) => {
    if (name === "llm")
      return {
        stream: (request) => {
          calls.push(request);
          return (async function* () {
            if (reply === "throw") throw new Error("adapter down");
            yield { type: "text-delta", text: reply };
            yield { type: "usage", usage: { inputTokens: 11, outputTokens: 7 } };
          })();
        },
      };
    if (name === "tokenMeter") return undefined;
    return undefined;
  },
  logger: { warn: () => {} },
});
// The route comes off the session, not the agent: resolveRoute reads
// `agent.session.requestHeader()`, exactly as the summarizer path does.
const agent = {
  session: {
    id: "sess-1",
    requestHeader: () => ({ config: { provider: "workbuddy", model: "hy4free" } }),
  },
};
const request = { questions: [question({ options: [{ label: "index.js" }] })], agent, signal: undefined };
const options = { prompt: "", provider: "", model: "", timeout: 120 };

// A usable answer comes back as a batch.
const okBatch = await answerQuestions(
  makeCtx('{"answers":[{"id":"q1","selected":["index.js"]}]}'),
  request,
  options,
);
assert.deepEqual(okBatch, { answers: [{ id: "q1", selected: ["index.js"], custom: "(answered by workbuddy/hy4free)" }] });
assert.equal(calls.length, 1);
assert.equal(calls[0].provider, "workbuddy");
assert.equal(calls[0].model, "hy4free");
assert.equal(calls[0].purpose, "ask-answer");
assert.equal(calls[0].sessionId, "sess-1");
assert.equal(calls[0].tools, undefined, "the answering call must not carry tools");

// An adapter failure declines instead of throwing.
assert.equal(
  await answerQuestions(makeCtx("throw"), request, options),
  null,
  "a failed call must hand the batch back",
);
// Unusable text declines.
assert.equal(
  await answerQuestions(makeCtx("I think index.js."), request, options),
  null,
  "unparseable text must hand the batch back",
);
// No agent means no session to bill and no route to resolve.
assert.equal(await answerQuestions(makeCtx("{}"), { questions: request.questions }, options), null);
// No routable model declines without calling anything.
const barrenCtx = {
  get: (name) => (name === "llm" ? { stream: () => { throw new Error("must not be called"); } } : undefined),
  logger: { warn: () => {} },
};
assert.equal(
  await answerQuestions(
    barrenCtx,
    { questions: request.questions, agent: { session: { id: "s", requestHeader: () => ({}) } } },
    options,
  ),
  null,
);

// --- 5. -1 means no deadline of our own -------------------------------
// A signal still reaches the call (the caller's own), but no plugin timeout is
// added on top; 120 builds one. The stubbed stream records what it received.
const withBudget = [];
const budgetCtx = {
  get: (name) =>
    name === "llm"
      ? {
          stream: (request) => {
            withBudget.push(request.signal);
            return (async function* () {
              yield { type: "text-delta", text: '{"answers":[{"id":"q1","selected":["index.js"]}]}' };
            })();
          },
        }
      : undefined,
  logger: { warn: () => {} },
};
await answerQuestions(budgetCtx, request, { ...options, timeout: 120 });
assert.ok(withBudget[0] instanceof AbortSignal, "a timeout must arm a deadline");
await answerQuestions(budgetCtx, request, { ...options, timeout: -1 });
assert.equal(withBudget[1], undefined, "-1 must not arm a deadline");

// --- 6. The spend lands in the ledger ----------------------------------
// answerQuestions bills under purpose "ask-answer" so the cost card can show it.
const ledgerFile = join(scratch, "storages", "dsh-token-panorama", "tool-usage.jsonl");
const found = existsSync(ledgerFile)
  ? readFileSync(ledgerFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.purpose === "ask-answer")
  : [];
assert.ok(found.length > 0, "an answering call must be recorded");
assert.equal(found[0].provider, "workbuddy");
assert.equal(found[0].sessionId, "sess-1");
assert.equal(typeof found[0].at, "number");

console.log("ask ok: instruction, forbidden zones, validation, decline paths, budget, ledger");

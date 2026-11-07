/**
 * The truncation ladder: a summary cut off by the output limit is retried with
 * more room instead of being abandoned.
 *
 * A truncated checkpoint is worse than none — it would replace real history
 * with a summary that stops mid-sentence — so the fix is not to accept the
 * partial text. It is to ask again with a larger output budget, which changes
 * nothing about the history, the prompt or the model. These pins hold the
 * ladder's shape: rung 0 is exactly what the session already sends, every later
 * rung offers strictly more room, and the climb stops at the platform's own
 * output reservation instead of growing without bound.
 *
 * schema.js is imported first for the same circular-edge reason as the other
 * tests.
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const load = (relative) => import(pathToFileURL(join(root, relative)).href);

await load("lib/schema.js");
const {
  MAX_OUTPUT_TOKENS,
  OUTPUT_RETRY_ATTEMPTS,
  outputBudgetFor,
  runSummarizer,
} = await load("lib/contextops.js");

// --- 1. The ceiling is the platform's own output reservation ------------
assert.equal(MAX_OUTPUT_TOKENS, 64_000);
assert.ok(OUTPUT_RETRY_ATTEMPTS >= 2, "one failure must be retried, not just reported");

// --- 2. Rung 0 is what the session already sends ------------------------
// A working configuration must not be silently changed by the ladder.
assert.equal(outputBudgetFor({ maxOutput: 8_000 }, 12_000, 0), 12_000);
assert.equal(outputBudgetFor({ maxOutput: 8_000 }, undefined, 0), 8_000);
// Nothing declared anywhere still yields a usable figure rather than NaN.
assert.equal(outputBudgetFor({ maxOutput: null }, undefined, 0), 4_096);
assert.equal(outputBudgetFor(null, undefined, 0), 4_096);

// --- 3. Every later rung offers strictly more room ---------------------
// A retry that repeated the same budget would reproduce the failure and bill
// for it, which is the exact outcome retrying exists to avoid.
for (const start of [1_000, 4_000, 8_000, 16_000]) {
  const first = outputBudgetFor({ maxOutput: start }, undefined, 0);
  const second = outputBudgetFor({ maxOutput: start }, undefined, 1);
  assert.ok(second > first, `rung 1 must exceed rung 0 (from ${start})`);
}
// The session's own figure is the starting point when it set one.
assert.equal(outputBudgetFor({ maxOutput: 8_000 }, 10_000, 1), 20_000);
assert.equal(outputBudgetFor({ maxOutput: 8_000 }, 10_000, 2), 40_000);

// --- 4. The climb is capped, never unbounded ---------------------------
assert.equal(outputBudgetFor({ maxOutput: 8_000 }, 40_000, 1), MAX_OUTPUT_TOKENS);
assert.equal(outputBudgetFor({ maxOutput: 8_000 }, 40_000, 9), MAX_OUTPUT_TOKENS);
assert.ok(outputBudgetFor({ maxOutput: 64_000 }, undefined, 3) <= MAX_OUTPUT_TOKENS);

// --- 5. Only max-tokens is retried ------------------------------------
// An adapter failure must surface on the first attempt: re-sending it would
// only pay for the same error again.
const seen = [];
const makeCtx = (replies) => ({
  get: (name) =>
    name === "llm"
      ? {
          stream: (config) => {
            seen.push(config.maxTokens);
            const reply = replies[seen.length - 1] ?? { kind: "stop" };
            return (async function* () {
              if (reply.kind === "error") {
                yield { type: "finish", reason: { kind: "error", failure: { message: "adapter down", code: "ADAPTER_DOWN" } } };
                return;
              }
              if (reply.kind === "max-tokens") {
                yield { type: "text-delta", text: "half a summa" };
                yield { type: "finish", reason: { kind: "max-tokens" } };
                return;
              }
              yield { type: "text-delta", text: reply.text ?? "a whole summary" };
              yield { type: "finish", reason: { kind: "stop" } };
            })();
          },
        }
      : undefined,
  logger: { warn: () => {} },
});
const agent = {
  session: {
    id: "sess-truncate",
    requestHeader: () => ({ config: { provider: "p", model: "m", maxTokens: 8_000 } }),
  },
};
const route = { provider: "p", model: "m", contextWindow: 960_000, maxOutput: 8_000 };
const messages = [{ role: "user", content: [{ type: "text", text: "summarize this" }] }];

// Truncated twice, then complete: the third rung is the one that lands, and the
// budgets it used climbed instead of repeating.
seen.length = 0;
const rescued = await runSummarizer(
  makeCtx([
    { kind: "max-tokens" },
    { kind: "max-tokens" },
    { kind: "stop", text: "the summary, complete" },
  ]),
  agent,
  route,
  messages,
  undefined,
  "compaction",
);
assert.equal(rescued, "the summary, complete");
assert.equal(seen.length, 3, "two truncations must be retried, not abandoned");
assert.ok(seen[1] > seen[0] && seen[2] > seen[1], "each retry must ask for more room");
assert.equal(seen[0], 8_000, "rung 0 must keep the session's own budget");

// An adapter error is not retried.
seen.length = 0;
await assert.rejects(
  () => runSummarizer(makeCtx([{ kind: "error" }]), agent, route, messages, undefined, "compaction"),
  /adapter down/u,
);
assert.equal(seen.length, 1, "a failed call must not be re-sent");

// A truncation that never resolves gives up after the ladder, with the
// truncation message rather than a broken partial summary.
seen.length = 0;
await assert.rejects(
  () =>
    runSummarizer(
      makeCtx(Array.from({ length: OUTPUT_RETRY_ATTEMPTS }, () => ({ kind: "max-tokens" }))),
      agent,
      route,
      messages,
      undefined,
      "compaction",
    ),
  (error) => error.code === "max-tokens",
  "an unrecoverable truncation must report truncation",
);
assert.equal(seen.length, OUTPUT_RETRY_ATTEMPTS, "the ladder must be bounded");

console.log("truncate ok: output ladder, strictly-growing rungs, cap, retry only max-tokens, bounded");

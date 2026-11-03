/**
 * Logic smoke (B5) plus the regression pins this round added.
 *
 * Pure Node, no host: the modules under test are the parts a live smoke
 * cannot reach deterministically — the usage-chunk field probe, the schema
 * gates, the workweek peak rule, the task lock, the preset merge and the
 * ledger fold. What is deliberately NOT here is the live route envelope and
 * a real compaction dry-run; those need a running Host and are exercised by
 * the plugin actually running in the GUI.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Plugin state redirects into a throwaway directory before any module
// touches storageDirOf.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-token-panorama-test-"));
const root = dirname(dirname(fileURLToPath(import.meta.url)));

// file:// URLs, because a Windows absolute path is not a supported ESM
// specifier ("Received protocol 'c:'").
const load = (relative) => import(pathToFileURL(join(root, relative)).href);
const { Config, PEAK_MODES, modelRow } = await load("lib/schema.js");
const { isPeak } = await load("lib/billing.js");
const { usageFromChunk, appendLedger, toolUsageSummary } = await load(
  "lib/ledger.js",
);
const { TaskLocks } = await load("lib/lock.js");
const { mergeSlots } = await load("lib/store.js");
const { pricePresetCatalog, applyPricePreset } = await load("lib/prices.js");

const ctx = { get: () => undefined, logger: undefined };

// --- B5: the usage-chunk field probe --------------------------------------
assert.deepEqual(
  usageFromChunk({
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 5,
    },
  }),
  { input: 100, output: 50, cacheRead: 20, cacheWrite: 5 },
  "canonical token fields must be read",
);
assert.deepEqual(
  usageFromChunk({
    usage: { promptTokens: 7, completionTokens: 3, cachedTokens: 2, cacheWriteTokens: 1 },
  }),
  { input: 7, output: 3, cacheRead: 2, cacheWrite: 1 },
  "alias token fields must be read",
);
assert.deepEqual(
  usageFromChunk({ input: 4, output: 1, cacheRead: 0, cacheWrite: 0 }),
  { input: 4, output: 1, cacheRead: 0, cacheWrite: 0 },
  "fields on the chunk itself must be read",
);
assert.equal(
  usageFromChunk({ usage: { inputTokens: 0, outputTokens: 0 } }),
  null,
  "an all-zero usage must fall back to the labelled estimate",
);
assert.equal(usageFromChunk(null), null, "a null chunk must not crash the probe");

// --- schema gates: budget and the workweek mode ---------------------------
assert.deepEqual(Config({}).budget, {
  dailyTokens: 0,
  weeklyTokens: 0,
  dailyCost: 0,
  weeklyCost: 0,
});
assert.throws(
  () => Config({ budget: { dailyTokens: -1 } }),
  "a negative budget must be rejected like any other field",
);
assert.ok(PEAK_MODES.includes("workweek"));
assert.doesNotThrow(() =>
  Config({
    peakProfiles: {
      w: {
        mode: "workweek",
        windows: [{ start: "09:00", end: "12:00" }],
        weekdays: [1, 2, 3, 4, 5],
        offPeakRatio: 0.5,
      },
    },
  }),
);

// --- the workweek rule and the two gaps it closes -------------------------
// 2026-11-02 is a Monday observed as a statutory holiday, 2026-11-03 is an
// ordinary Tuesday and 2026-11-07 an ordinary Saturday.
const workweek = {
  mode: "workweek",
  windows: [{ start: "09:00", end: "12:00" }],
  weekdays: [1, 2, 3, 4, 5],
  offPeakRatio: 0.5,
};
const rules = {
  timeZone: "Asia/Shanghai",
  currency: "CNY",
  peakProfiles: {},
  // `billingRules` hands out Sets here; the fixture mirrors that shape.
  holidays: new Set(["2026-11-02"]),
  makeupDays: new Set(),
  models: { m: modelRow(2, 0.04, 2, 8, "") },
  defaultPrice: modelRow(2, 0.04, 2, 8, ""),
};
assert.equal(isPeak("2026-11-03T10", workweek, rules), true, "weekday window");
assert.equal(isPeak("2026-11-03T13", workweek, rules), false, "outside window");
assert.equal(isPeak("2026-11-07T10", workweek, rules), false, "weekend day");
assert.equal(
  isPeak("2026-11-02T10", workweek, rules),
  false,
  "statutory holiday must not be peak",
);
// The older modes each miss exactly one of those cases — pinned here because
// "workweek" exists to close them, and a refactor must not reopen either.
assert.equal(
  isPeak("2026-11-02T10", { ...workweek, mode: "weekdays" }, rules),
  true,
  "weekdays ignores holidays: the first gap",
);
assert.equal(
  isPeak("2026-11-07T10", { ...workweek, mode: "workday" }, rules),
  true,
  "workday bills an ordinary Saturday: the second gap",
);

// --- the task lock: cross-owner refusal and stale sweep -------------------
const locksA = new TaskLocks(ctx, { ttlMs: 60 });
const locksB = new TaskLocks(ctx, { ttlMs: 60 });
assert.equal(await locksA.acquire("context:s1"), true);
assert.equal(
  await locksB.acquire("context:s1"),
  false,
  "a second owner must be refused while the lock is live",
);
assert.equal(await locksA.release("context:s1"), true);
assert.equal(await locksB.acquire("context:s1"), true);
await locksB.release("context:s1");
await locksA.acquire("context:s2");
await new Promise((resolve) => setTimeout(resolve, 90));
assert.equal(
  await locksB.acquire("context:s2"),
  true,
  "an expired lock must be swept instead of holding the session forever",
);

// --- B2: the presets carry the researched prices -------------------------
const catalog = pricePresetCatalog();
assert.ok(catalog.presets.length >= 10, "the catalog must cover the majors");
for (const preset of catalog.presets) {
  assert.ok(preset.currency === "CNY" || preset.currency === "USD");
  assert.equal(preset.asOf, "2026-11-03");
  assert.ok(typeof preset.source === "string" && preset.source !== "");
}
// The fetched figures, pinned. These are the official numbers read on
// 2026-11-03 (DeepSeek and Moonshot official pages; the rest via the LiteLLM
// mirror named on each preset). Editing a preset has to move this line.
const rowOf = (id) => catalog.presets.find((preset) => preset.id === id).row;
assert.deepEqual(rowOf("deepseek-v4-pro"), {
  input: 9,
  cacheRead: 0.3,
  cacheWrite: 9,
  output: 27,
  peakProfile: "deepseek-standard",
});
assert.deepEqual(rowOf("kimi-k3.1-pro"), {
  input: 13,
  cacheRead: 1.3,
  cacheWrite: 13,
  output: 68,
  peakProfile: "",
});
assert.deepEqual(rowOf("claude-sonnet-5.5"), {
  input: 2,
  cacheRead: 0.1,
  cacheWrite: 2.5,
  output: 10,
  peakProfile: "",
});
assert.deepEqual(rowOf("gpt-6.1-sol"), {
  input: 2,
  cacheRead: 0.1,
  cacheWrite: 2,
  output: 10,
  peakProfile: "",
});
assert.deepEqual(rowOf("gemini-4-argon"), {
  input: 2,
  cacheRead: 0.1,
  cacheWrite: 2,
  output: 10,
  peakProfile: "",
});
assert.deepEqual(rowOf("mimo-v2.6-flash"), {
  input: 1,
  cacheRead: 0.02,
  cacheWrite: 0,
  output: 2,
  peakProfile: "",
});
const draft = Config({});
const keys = applyPricePreset(draft, "deepseek-flash");
assert.deepEqual(
  [...keys].sort(),
  ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4.1-flash"],
);
assert.deepEqual(draft.models["deepseek-flash"], {
  input: 2,
  cacheRead: 0.04,
  cacheWrite: 2,
  output: 8,
  peakProfile: "deepseek-standard",
});
assert.equal(draft.peakProfiles["deepseek-standard"].mode, "workweek");
assert.equal(applyPricePreset(draft, "no-such-preset"), null);
assert.doesNotThrow(() => Config(draft), "an applied draft must validate");

// --- the tail merge behind the fast open ---------------------------------
const merged = mergeSlots(
  [["2026-11-03T10", "m", 10, 5, 2, 1, 18, 3]],
  [
    ["2026-11-03T10", "m", 1, 1, 0, 0, 2, 1],
    ["2026-11-03T11", "m", 7, 0, 0, 0, 7, 1],
  ],
);
assert.equal(merged.length, 2);
assert.deepEqual(
  merged.find((row) => row[0] === "2026-11-03T10"),
  ["2026-11-03T10", "m", 11, 6, 2, 1, 20, 4],
  "overlapping slots must add counters 2..7",
);

// --- A2: the tool ledger end to end --------------------------------------
await appendLedger(ctx, {
  kind: "usage",
  purpose: "compaction",
  model: "m",
  sessionId: "s1",
  input: 300,
  output: 100,
  cacheRead: 0,
  cacheWrite: 0,
  estimated: false,
});
await appendLedger(ctx, {
  kind: "usage",
  purpose: "prompt-optimizer",
  model: "m",
  sessionId: "s1",
  input: 1_000_000,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  estimated: false,
});
await appendLedger(ctx, {
  kind: "usage",
  purpose: "compaction",
  model: "m",
  sessionId: "s1",
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  estimated: true,
});
await appendLedger(ctx, {
  kind: "surface",
  op: "compact",
  sessionId: "s1",
  items: 10,
  beforeTokens: 1000,
  afterTokens: 100,
});
const summary = await toolUsageSummary(ctx, rules);
assert.equal(summary.calls, 3);
assert.equal(summary.estimatedCalls, 1);
assert.equal(summary.compaction.ops, 1);
assert.equal(summary.compaction.savedTokens, 900);
assert.equal(summary.compaction.consumedTokens, 400);
assert.equal(summary.compaction.savingsRatio, 2.25);
assert.equal(summary.optimizer.calls, 1);
assert.equal(summary.clear.ops, 0);
// 1M input at the configured 2/M plus the compaction request's own tokens.
assert.ok(
  Math.abs(summary.cost - 2.0014) < 1e-6,
  `unexpected tool cost: ${summary.cost}`,
);
assert.equal(summary.byDay.length, 1);

// --- C2: the export wiring stays present ---------------------------------
const clientText = readFileSync(join(root, "client.js"), "utf8");
for (const marker of ["const exportJson", "const exportCsv", "function download"]) {
  assert.ok(clientText.includes(marker), `client.js lost ${marker}`);
}

rmSync(process.env.DSH_HOME, { recursive: true, force: true });
console.log("smoke ok: probe, schema, workweek, lock, presets, merge, ledger, export");

/**
 * Regression pins for the 「会话统计」clear reset.
 *
 * The Host injects a runtime wrapper around the platform's two whole-log
 * projection units. These tests drive that wrapper against a fake registry
 * with the real event shapes the plugin writes, and cover the three things
 * that could go wrong: a false positive on a normal compaction, a missed
 * clear marker, and a patch that is not undone on unload.
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const load = (relative) => import(pathToFileURL(join(root, relative)).href);
const {
  CLEAR_ORIGIN,
  CLEAR_PLACEHOLDER,
  RESET_KEYS,
  isContextClear,
  installStatsReset,
} = await load("lib/stats-reset.js");

const PREFIX = "The context below is a checkpoint. Keep it.";
const SUFFIX = "End of checkpoint.";

/** The exact pair replaceSurface appends for a clear. */
function clearEvents() {
  return [
    {
      type: "compaction/summary",
      data: { summary: [{ type: "text", text: CLEAR_PLACEHOLDER }] },
    },
    {
      type: "user/message",
      data: {
        role: "user",
        content: [
          { type: "text", text: PREFIX },
          { type: "text", text: CLEAR_PLACEHOLDER },
          { type: "text", text: SUFFIX },
        ],
        source: { kind: "compact-checkpoint", origin: CLEAR_ORIGIN },
      },
    },
    { type: "compaction/end", data: {} },
  ];
}

/** A manual/automatic compaction: same event types, no clear marker. */
function compactEvents() {
  return [
    {
      type: "compaction/summary",
      data: { summary: [{ type: "text", text: "## Task\nDo the thing." }] },
    },
    {
      type: "user/message",
      data: {
        role: "user",
        content: [
          { type: "text", text: PREFIX },
          { type: "text", text: "## Task\nDo the thing." },
          { type: "text", text: SUFFIX },
        ],
        source: { kind: "compact-checkpoint" },
      },
    },
    { type: "compaction/end", data: {} },
  ];
}

// ---------------------------------------------------------------------------
// Marker recognition
// ---------------------------------------------------------------------------
assert.equal(isContextClear(clearEvents()[0]), true, "clear summary is a marker");
assert.equal(isContextClear(clearEvents()[1]), true, "clear checkpoint is a marker");
for (const event of compactEvents()) {
  assert.equal(
    isContextClear(event),
    false,
    `compaction event ${event.type} must NOT reset the dashboard`,
  );
}
for (const junk of [null, undefined, 0, "clear", {}, { type: "user/message" }]) {
  assert.equal(isContextClear(junk), false, "non-events are not markers");
}
assert.equal(
  isContextClear({
    type: "user/message",
    data: { source: { origin: CLEAR_ORIGIN }, content: [] },
  }),
  true,
  "source.origin alone is enough (older logs)",
);
assert.equal(
  isContextClear({
    type: "user/message",
    data: {
      content: [{ type: "text", text: CLEAR_PLACEHOLDER }],
      source: { kind: "compact-checkpoint" },
    },
  }),
  true,
  "placeholder text alone is enough (older checkpoint logs)",
);
assert.deepEqual(RESET_KEYS, ["sessionStats", "tokenUsage"]);
assert.equal(
  isContextClear({
    type: "user/message",
    data: {
      content: [{ type: "text", text: CLEAR_PLACEHOLDER }],
      source: { kind: "user" },
    },
  }),
  false,
  "a user message quoting the placeholder is NOT a clear",
);
assert.equal(
  isContextClear({
    type: "compaction/summary",
    data: {
      summary: [
        { type: "text", text: "## Task" },
        { type: "text", text: CLEAR_PLACEHOLDER },
      ],
    },
  }),
  false,
  "a normal summary that merely quotes the placeholder is NOT a clear",
);
assert.equal(
  isContextClear({
    type: "user/message",
    data: {
      source: { kind: "compact-checkpoint" },
      content: [{ type: "text", text: CLEAR_PLACEHOLDER }],
    },
  }),
  true,
  "an older checkpoint with no origin field is still a clear",
);

// ---------------------------------------------------------------------------
// Fake registry: one unit per dialog key, plus an unrelated unit.
// The fake init() is ALL ZERO, mirroring the real sessionStats/tokenUsage
// init() — a reset must therefore produce a zero view, not a fresh seed of
// pre-clear values. apply() accumulates a counter so we can prove what got
// folded after the marker.
// ---------------------------------------------------------------------------
function fakeRegistry() {
  const registrations = new Map();
  const add = (key) => {
    const def = {
      key,
      init: () => ({ totals: 0, seen: 0, zero: true }),
      apply: (state, event) => ({
        ...state,
        totals: state.totals + (event.data?.usage?.inputTokens ?? 0),
        seen: state.seen + 1,
      }),
      wire: { viewSchema: { parse: (v) => v }, view: (s) => s },
      stateVersion: 1,
    };
    registrations.set(key, { def, cells: new WeakMap(), refs: 1 });
    return def;
  };
  const stats = add("sessionStats");
  const usage = add("tokenUsage");
  const other = add("contextPressure");
  const service = {
    registrations,
    register(definition) {
      const def = { ...definition };
      registrations.set(definition.key, { def, cells: new WeakMap(), refs: 1 });
      return () => registrations.delete(definition.key);
    },
  };
  return { service, registrations, stats, usage, other };
}

/** Fold a sequence of events the way buildCell/restore do. */
function fold(def, events) {
  let state = def.init();
  for (const event of events) state = def.apply(state, event);
  return state;
}

// A normal turn BEFORE the clear accumulates, as the platform intends.
const before = [
  { type: "step/start", data: { turn: 1, step: 1 } },
  { type: "step/end", data: { turn: 1, step: 1 } },
  { type: "assistant/message", data: { usage: { inputTokens: 100 } } },
];

const warnings = [];
const env = fakeRegistry();
const originalRegister = env.service.register;
const undo = installStatsReset(env.service, (m) => warnings.push(m));
assert.equal(warnings.length, 0, "a well-formed registry needs no warning");
assert.notEqual(env.service.register, originalRegister, "register is wrapped");

// 1. A clear resets BOTH dialog units to zero, and leaves the unrelated one
//    alone. The decisive invariant: folding the WHOLE log equals folding only
//    the events after the last clear marker — no pre-clear byte survives.
//    clearEvents() = [summary(marker), checkpoint(marker), compaction/end],
//    so the post-marker tail is just compaction/end.
const tail = clearEvents().slice(2);
const post = [{ type: "assistant/message", data: { usage: { inputTokens: 7 } } }];
const fullEvents = [...before, ...clearEvents(), ...post];
const tailEvents = [...tail, ...post];
for (const [label, def] of [["sessionStats", env.stats], ["tokenUsage", env.usage]]) {
  const full = fold(def, fullEvents);
  const oracle = fold(def, tailEvents);
  assert.deepEqual(full, oracle, `${label}: pre-clear data is gone`);
  assert.equal(full.totals, 7, `${label}: only post-clear usage counted`);
  assert.equal(full.seen, 2, `${label}: only post-marker events folded`);
}
const otherAfterClear = fold(env.other, clearEvents());
assert.equal(otherAfterClear.seen, 3, "unrelated units are untouched");

// 2. A compaction keeps accumulating: only 清空上下文 resets.
const compactStats = fold(env.stats, [...before, ...compactEvents()]);
assert.equal(compactStats.seen, 6, "all six events still folded (no reset)");
assert.equal(compactStats.totals, 100, "pre-compact usage preserved");

// 3. Activity AFTER a clear starts counting from zero.
const afterState = fold(env.stats, [...clearEvents(), ...post]);
assert.equal(afterState.totals, 7, "only post-clear usage counted");
assert.equal(afterState.seen, 2, "only post-marker events folded");

// 4. A unit registered AFTER the plugin mounts is wrapped too.
env.registrations.delete("sessionStats");
const late = {
  key: "sessionStats",
  init: () => ({ fresh: true }),
  apply: (state, event) => ({ ...state, seen: (state.seen ?? 0) + 1 }),
  stateVersion: 1,
};
const disposeLate = env.service.register(late);
const lateDef = env.registrations.get("sessionStats").def;
assert.equal(lateDef.apply({ seen: 5 }, clearEvents()[1]).fresh, true,
  "late registration is wrapped");
disposeLate();

// 5. Unload puts everything back exactly.
undo();
assert.equal(env.service.register, originalRegister, "register restored");
const restored = fold(env.stats, clearEvents());
assert.equal(restored.seen, 3, "clear no longer resets after unload: all 3 events folded");

// 6. A registry with no public Map is a logged no-op, never a crash.
const bad = { register: () => () => {} };
const badWarnings = [];
const badRegister = bad.register;
const badUndo = installStatsReset(bad, (m) => badWarnings.push(m));
assert.equal(badWarnings.length, 1, "one warning");
assert.equal(bad.register, badRegister, "register was not monkeypatched");
badUndo();


// ---------------------------------------------------------------------------
// Live-drive chain: a wrapped unit emits the ZERO view on the change feed.
// This mirrors SessionProjectionRegistry.drive(): apply → changed reference →
// wire.view → viewSchema.parse → listener(session, key, value, seq).
// ---------------------------------------------------------------------------
const live = fakeRegistry();
const liveUndo = installStatsReset(live.service);
const frames = [];
for (const key of RESET_KEYS) {
  const registration = live.registrations.get(key);
  const def = registration.def;
  let state = def.init();
  for (const event of [...before, ...clearEvents().slice(0, 2)]) {
    const next = def.apply(state, event);
    if (!Object.is(next, state)) {
      const view = def.wire.viewSchema.parse(def.wire.view(next));
      frames.push({ sessionId: "session-A", key, value: view });
    }
    state = next;
  }
}
const zeroFrames = frames.filter((f) => f.key === "sessionStats" || f.key === "tokenUsage");
assert.ok(zeroFrames.length >= 2, "both dialog units emit a frame at the clear");
for (const frame of zeroFrames.slice(-2)) {
  assert.equal(frame.value.totals, 0, `${frame.key}: zero frame reached the client`);
}
liveUndo();

console.log("stats-reset ok: marker, clear reset, compact preserved, late registration, dispose, no-op fallback");

/**
 * The scan path's regression pins.
 *
 * These cover the three things the panel's speed now rests on: the zstd frame
 * walk that lets a pass read only what is new, the projection unit whose fold
 * must agree with the from-log fold, and the negative cache that stops an
 * unreadable log from being decoded on every pass. All of it runs without a
 * Host: a log is built here with the platform's own zstd codec.
 *
 * What is deliberately NOT here is a Host round trip — whether the registry
 * actually persists and serves the unit is the platform's contract, and the
 * plugin's own wiring is exercised by the plugin running in the GUI.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

// A sandbox may refuse the platform temp directory, so the scratch root falls
// back to one inside the repository (gitignored) rather than failing the suite.
const scratch = (() => {
  try {
    return mkdtempSync(join(tmpdir(), "dsh-token-panorama-scan-"));
  } catch {
    const local = join(dirname(dirname(fileURLToPath(import.meta.url))), ".tmp-test");
    mkdirSync(local, { recursive: true });
    return mkdtempSync(join(local, "scan-"));
  }
})();
process.env.DSH_HOME = scratch;
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const load = (relative) => import(pathToFileURL(join(root, relative)).href);

const { frameAfterSeq, frameSeqAt, inspectLog, lastSeqOf, readRecordsFrom } =
  await load("lib/frames.js");
const { emptyState, applyEvent, slotsOf, stateOf, USAGE_STATE_VERSION } =
  await load("lib/projection.js");
const { hourKey } = await load("lib/time.js");
const { UsageIndex, FAILURE_RETRY_MS } = await load("lib/store.js");

if (typeof zstdCompressSync !== "function") {
  console.log("scan ok (skipped: this Node has no zstd)");
  process.exit(0);
}

const ZONE = "Asia/Shanghai";
const header = { version: 4, id: "session-test", createdAt: 1700000000000, cwd: "C:\\w" };
const usageEvent = (seq, tokens) => ({
  seq,
  time: Date.parse("2026-11-03T02:00:00Z"),
  type: "assistant/message",
  data: {
    message: { source: { model: "m" } },
    usage: {
      inputTokens: tokens,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: tokens + 1,
    },
  },
});
const titleEvent = (seq, title) => ({
  seq,
  time: Date.parse("2026-11-03T02:00:00Z"),
  type: "session/title",
  data: { title },
});

/** Write a batch of records as one zstd frame, exactly as the backend appends. */
const frameOf = (records) =>
  zstdCompressSync(Buffer.from(records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8"));

// --- the frame walk: a container read that never inflates the prefix -------
const logPath = join(process.env.DSH_HOME, "session.v4.jsonl.zstd");
writeFileSync(logPath, frameOf([header, titleEvent(0, "first"), usageEvent(1, 10)]));
appendFileSync(logPath, frameOf([usageEvent(2, 20), usageEvent(3, 30)]));

const buffer = (await import("node:fs")).readFileSync(logPath);
const info = inspectLog(buffer);
assert.ok(info !== undefined, "the frame walk must find a log");
assert.equal(JSON.parse(info.headerText).id, "session-test");
assert.equal(info.ranges.length, 2, "two appends are two frames");

const all = (await readRecordsFrom(buffer, info.ranges, 0)).records;
assert.equal(all.length, 5, "every record must be readable");
assert.deepEqual(all.map((record) => record.seq ?? record.version), [4, 0, 1, 2, 3]);

assert.equal(lastSeqOf(buffer, info.ranges), 3, "the watermark is the last seq");
assert.equal(frameSeqAt(buffer, info.ranges, 1), 2, "a frame reports its first seq");

// Resuming at a seq must start at or before it, never after: a checkpoint lands
// mid-batch, and starting past it would drop the rest of that batch.
const resume = frameAfterSeq(buffer, info.ranges, 2);
assert.ok(resume !== undefined && resume <= 1, "resume must not skip the frame holding the watermark");
const tail = (await readRecordsFrom(buffer, info.ranges, resume)).records;
assert.deepEqual(
  tail.filter((record) => record.seq > 2).map((record) => record.seq),
  [3],
  "the resumed slice must hold exactly what is new",
);
// A frame's records are newline-terminated, so a torn append is left for the
// next pass instead of being parsed.
const torn = Buffer.concat([buffer, frameOf([usageEvent(4, 40)]).subarray(0, 12)]);
const kept = (await readRecordsFrom(torn, inspectLog(torn).ranges, 0)).records;
assert.equal(kept.length, 5, "a torn tail must be dropped, not guessed at");

// --- the projection unit: its fold is the panel's fold --------------------
const bucket = (time) => hourKey(time, ZONE);
const state = emptyState(ZONE);
const unrelated = { seq: 9, type: "turn/end", data: {} };
assert.equal(applyEvent(state, unrelated, bucket), state, "an unrelated event must not copy the state");
applyEvent(state, titleEvent(0, "named"), bucket);
applyEvent(state, usageEvent(1, 10), bucket);
applyEvent(state, usageEvent(2, 20), bucket);
assert.equal(state.title, "named");
assert.deepEqual(
  slotsOf(state),
  [["2026-11-03T10", "m", 30, 2, 0, 0, 32, 2]],
  "two usage events in one hour and model must merge into one slot",
);

// A stored row is validated, never trusted: a damaged one is dropped so it can
// never become a NaN in the panel's totals.
const damaged = { zone: ZONE, title: "", rows: [["hour", "m", 1, 2, 3, 4, 5, 6], ["hour"]] };
assert.equal(slotsOf(damaged).length, 1, "a short row must be dropped");
assert.equal(stateOf({ rows: {} }), undefined, "a non-array rows field is not a state");
assert.equal(USAGE_STATE_VERSION, 1, "a version bump must be deliberate: it invalidates every stored row");
assert.equal(
  JSON.parse(JSON.stringify(state)).rows.length,
  state.rows.length,
  "the state must survive the checkpoint's plain-JSON round trip",
);
assert.equal(zstdDecompressSync(frameOf([{ a: 1 }])).toString("utf8"), '{"a":1}\n');

// --- the negative cache: an unreadable log is not decoded twice -----------
let opens = 0;
let revision = "rev-1";
let refuse = true;
const index = new UsageIndex(
  {
    logger: { warn: () => {} },
    get: () => undefined,
    sessionPersistence: {
      list: async () => [{ header, revision, sizeBytes: 100, formatStatus: "current" }],
      resolveCurrentLog: async () => {
        throw new Error("no container");
      },
      open: async () => {
        opens += 1;
        if (refuse) throw new Error("stored log is corrupt");
        throw new Error("unused");
      },
    },
  },
  { timeZone: ZONE },
);
index.path = join(process.env.DSH_HOME, "usage-cache.json");

let result = await index.scan(false);
assert.equal(result.failed, 1, "the first pass must try and fail");
assert.equal(opens, 1);
result = await index.scan(false);
assert.equal(result.skipped, 1, "the second pass must skip the same bytes");
assert.equal(opens, 1, "a remembered failure must not open the log again");
revision = "rev-2";
await index.scan(false);
assert.equal(opens, 2, "new bytes must be retried at once: a repair has to show up");
index.failures.get("session-test").at -= FAILURE_RETRY_MS + 1;
await index.scan(false);
assert.equal(opens, 3, "an aged failure must be retried even without a new revision");

rmSync(process.env.DSH_HOME, { recursive: true, force: true });
console.log("scan ok: frame walk, resume, torn tail, projection fold, negative cache");

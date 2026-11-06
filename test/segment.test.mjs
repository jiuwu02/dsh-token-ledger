/**
 * Byte-budget regression (the 2,816,375-byte /compact 413).
 *
 * A live session failed four /compact attempts with
 * `preflight_compress_failed`: the plugin sized a segment as
 * `contextWindow * 2/3 * 4` UTF-16 characters, producing ONE rendered user
 * message of 2,816,375 UTF-8 bytes, while the fronting proxy enforced a
 * smaller window (180000 tokens) and a hard 2,000,000-byte fuse. Segmentation
 * measured in characters never saw the byte ceiling coming.
 *
 * These pins exercise the real exported helpers (schema.js is imported first
 * because the module graph has a circular edge through ledger/billing/store).
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const load = (relative) => import(pathToFileURL(join(root, relative)).href);

// Break the schema.js <-> contextops.js cycle in the order the other tests use.
await load("lib/schema.js");
const {
  MAX_SEGMENT_BYTES,
  renderBudgetBytes,
  splitSegments,
  buildExcerpt,
} = await load("lib/contextops.js");

const bytes = (text) => Buffer.byteLength(text, "utf8");
const PROXY_FUSE_BYTES = 2_000_000; // billion-context DOOMED_PROBE_ABSOLUTE_BYTES

// --- 1. The model optimistic window can no longer inflate one request ----
// hy4free declares 960000; the old math produced 2,560,000 chars (~2.8 MB).
assert.equal(renderBudgetBytes(640000), MAX_SEGMENT_BYTES);
assert.equal(renderBudgetBytes(null), MAX_SEGMENT_BYTES);
assert.equal(renderBudgetBytes(0), 4_000); // MIN_EXCERPT_BYTES floor
assert.ok(MAX_SEGMENT_BYTES < PROXY_FUSE_BYTES);

// --- 2. Chinese text: UTF-16 chars undercounted UTF-8 bytes by ~1.09x ----
const blocks = [
  "x".repeat(500_000),
  "中".repeat(200_000),
  "y".repeat(100),
];
const segments = splitSegments(blocks, MAX_SEGMENT_BYTES);
for (const segment of segments)
  assert.ok(bytes(segment) <= MAX_SEGMENT_BYTES, "segment exceeds byte ceiling");
assert.equal(segments.join("\n\n"), blocks.join("\n\n"), "no history lost");

// --- 3. The real failing payload: one 2,816,375-byte rendered message ----
// Simulates the giant instructionMessage built from the session span.
const doomed = "载".repeat(938_791) + "x"; // ~2,816,375 UTF-8 bytes
assert.ok(bytes(doomed) > 2_800_000);
const doomedSegments = splitSegments([doomed], renderBudgetBytes(640000));
assert.ok(doomedSegments.length > 1, "the oversized record must be hard-split");
for (const segment of doomedSegments) {
  assert.ok(bytes(segment) <= MAX_SEGMENT_BYTES);
  assert.ok(bytes(segment) < PROXY_FUSE_BYTES, "would trip the proxy 413 fuse");
  assert.equal(segment, segment.replace(/\uFFFD/g, ""), "no replacement chars");
}
assert.equal(doomedSegments.join(""), doomed, "hard-split is lossless");

// --- 4. Even the densest tokenizer estimate stays under the 180000 window --
for (const segment of doomedSegments) {
  const floorTokens = Math.ceil(bytes(segment) / 7.5);
  assert.ok(floorTokens < 180000, "segment would exceed the proxy window");
}

// --- 5. split OFF uses the same byte budget (both paths were failing) ----
const texts = [
  "A".repeat(200_000),
  "中".repeat(150_000),
  "B".repeat(300_000),
  "C".repeat(50_000),
];
const fakeSession = {
  surface: { nodes: texts.map((_, i) => i) },
  eventAt: (seq) => ({ seq, type: "user/message" }),
  deriveEventMessage: (event) => ({
    role: "user",
    content: [{ type: "text", text: texts[event.seq] }],
  }),
};
const t = (key, params) => "<" + key + ":" + (params?.items ?? "") + "/" + (params?.tokens ?? "") + ">";
const excerpt = buildExcerpt({}, { session: fakeSession }, 640000, t, undefined, true);
assert.ok(bytes(excerpt.text) <= MAX_SEGMENT_BYTES + 256, "excerpt over byte ceiling");
assert.ok(excerpt.omitted > 0, "an over-budget span must drop the oldest records");

console.log("segment ok: byte ceiling, UTF-8, hard-split, proxy fuse, excerpt");

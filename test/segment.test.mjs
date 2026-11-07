/**
 * Byte-budget regression (the /compact run that never reached a model).
 *
 * A live session failed four /compact attempts with `preflight_compress_failed`:
 * the plugin sized a segment as `contextWindow * 2/3 * 4` UTF-16 characters, so
 * ONE rendered user message came out at 2,816,375 UTF-8 bytes. Chinese text
 * costs roughly 1.09x more bytes than the characters it had been sized in, and
 * nothing in the pipeline was checking bytes at all.
 *
 * The fix is this module's own ceiling, not a number borrowed from whatever
 * sits between the plugin and the model: `MAX_SEGMENT_BYTES` bounds one
 * request's core text in UTF-8 bytes, and both summarizer paths (segments on,
 * and excerpt-only with segments off) measure with it. These pins hold that
 * ceiling, that the split is lossless, and that a single oversized record is
 * hard-split rather than sent whole.
 *
 * schema.js is imported first because the module graph has a circular edge
 * through ledger/billing/store.
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
// The module's own density assumption, the one the ceiling is documented in.
const BYTES_PER_TOKEN = 4;

// --- 1. The model's optimistic window can no longer inflate one request ----
// A model declaring a million tokens used to yield a multi-megabyte message.
assert.equal(renderBudgetBytes(640000), MAX_SEGMENT_BYTES);
assert.equal(renderBudgetBytes(null), MAX_SEGMENT_BYTES);
assert.equal(renderBudgetBytes(0), 4_000); // MIN_EXCERPT_BYTES floor
assert.ok(
  Math.ceil(MAX_SEGMENT_BYTES / BYTES_PER_TOKEN) < 200_000,
  "the ceiling must leave room in a 200k-token window for instruction and prompt",
);

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

// The measured ratio the fix was sized against: a CJK character is three UTF-8
// bytes but one UTF-16 code unit, so a character budget overshoots by ~1.09x on
// the mixed text a real session produces.
const mixed = "中".repeat(100_000);
assert.ok(bytes(mixed) / mixed.length > 2.9, "CJK costs ~3 bytes per character");

// --- 3. One record past the ceiling is hard-split, never sent whole --------
// The shape of the record that failed: a single rendered message of ~2.8 MB.
const doomed = "载".repeat(938_791) + "x"; // ~2,816,375 UTF-8 bytes
assert.ok(bytes(doomed) > 2_800_000);
const doomedSegments = splitSegments([doomed], renderBudgetBytes(640000));
assert.ok(doomedSegments.length > 1, "the oversized record must be hard-split");
for (const segment of doomedSegments) {
  assert.ok(bytes(segment) <= MAX_SEGMENT_BYTES);
  assert.equal(segment, segment.replace(/\uFFFD/g, ""), "no replacement chars");
}
assert.equal(doomedSegments.join(""), doomed, "hard-split is lossless");

// --- 4. Every segment stays inside one request at this module's estimate --
for (const segment of doomedSegments) {
  const floorTokens = Math.ceil(bytes(segment) / BYTES_PER_TOKEN);
  assert.ok(
    floorTokens < 200_000,
    "segment would not fit a 200k-token window with its instruction",
  );
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

// --- 6. splitTextByBytes never splits a surrogate pair -------------------
// Astral characters are two UTF-16 code units and four UTF-8 bytes; slicing by
// code unit index can land mid-pair and produce a replacement character.
const emoji = "😀".repeat(100_000);
const emojiSegments = splitSegments([emoji], 100_000);
assert.ok(emojiSegments.length > 1);
for (const segment of emojiSegments) {
  assert.ok(bytes(segment) <= 100_000);
  assert.equal(segment, segment.replace(/\uFFFD/g, ""), "no replacement chars");
}
assert.equal(emojiSegments.join(""), emoji, "astral split is lossless");

console.log("segment ok: byte ceiling, UTF-8, hard-split, window fit, excerpt, astral");

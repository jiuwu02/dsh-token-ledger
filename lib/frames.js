/**
 * Reading a stored zstd session log without decoding all of it.
 *
 * The persistence backend decodes an entire log before it can answer any read:
 * `open()` inflates every frame into one event array and `read(offset)` only
 * slices that array. Measured on this machine, a tail read of 687 events out of
 * 25 094 cost 512 ms against 551 ms for the whole log — 93 % of the work, for
 * none of the benefit. A scan that wants the appended tail therefore cannot ask
 * the seam for it; it has to read the container itself.
 *
 * A Zstandard log is a plain concatenation of independent frames, one per
 * append batch, and every frame in the recorded corpus ends on a record
 * boundary, so a frame edge is a safe place to start reading. The helpers below
 * find those edges by walking frame headers only — no decompression — which is
 * why a 29 MB log costs 5 ms to open and 9 % of its frames cost 5 % of the
 * decode.
 *
 * @module dsh-token-panorama/frames
 */

import { open } from "node:fs/promises";
import { zstdDecompressSync } from "node:zlib";

/** The four bytes every Zstandard frame begins with, little-endian. */
const ZSTD_MAGIC = 0xfd2fb528;

/**
 * Frames decoded between event-loop yields, so one huge log cannot stall the
 * Host while it is folded.
 */
const FRAMES_PER_YIELD = 256;

/**
 * Walk the container and report where each frame starts and ends.
 *
 * Only the frame and block headers are parsed; payloads are skipped by their
 * declared length. A truncated or malformed container yields the frames read so
 * far, which the caller treats as "this log ends here".
 * @param buffer - the stored log.
 * @returns `[start, end)` byte ranges, in file order.
 */
export function frameRanges(buffer) {
  const ranges = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 5) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break;
    offset += 4;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const headerRest =
      (singleSegment ? 0 : 1) +
      (dictionaryFlag === 3 ? 4 : dictionaryFlag) +
      (contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag);
    if (buffer.length - offset < headerRest) break;
    offset += headerRest;
    let complete = false;
    for (;;) {
      if (buffer.length - offset < 3) break;
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      // 3 is reserved; 1 is RLE, which carries one byte rather than blockSize.
      if (blockType === 3) break;
      offset += blockType === 1 ? 1 : blockSize;
      if (offset > buffer.length) break;
      if (lastBlock) {
        complete = true;
        break;
      }
    }
    if (!complete) break;
    if (checksum) {
      if (buffer.length - offset < 4) break;
      offset += 4;
    }
    ranges.push([start, offset]);
  }
  return ranges;
}

/**
 * Decode one frame's plaintext.
 * @param buffer - the stored log.
 * @param range - the frame's byte range.
 * @returns the inflated UTF-8 text.
 */
function frameText(buffer, range) {
  return zstdDecompressSync(buffer.subarray(range[0], range[1])).toString(
    "utf8",
  );
}

/**
 * The first `seq` a frame carries, or `undefined` when it carries none.
 *
 * Frames are whole append batches, so the first record is the one that decides
 * where the frame sits in the log's sequence.
 * @param text - the frame's plaintext.
 * @returns the sequence number, or undefined when the frame has no events.
 */
function firstSeqOf(text) {
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      const value = JSON.parse(line);
      return typeof value?.seq === "number" ? value.seq : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The first sequence number one frame of a log carries.
 *
 * Exposed so a reader working from a tail chunk can prove the chunk reaches
 * back to the watermark it wants to resume from: a frame that starts after the
 * watermark means the events in between were never read, and the caller has to
 * fall back to the whole file.
 * @param buffer - the stored log, or a chunk that starts on a frame edge.
 * @param ranges - its frame ranges.
 * @param index - which frame.
 * @returns the sequence number, or undefined when the frame carries none.
 */
export function frameSeqAt(buffer, ranges, index) {
  const range = ranges[index];
  if (range === undefined) return undefined;
  try {
    return firstSeqOf(frameText(buffer, range));
  } catch {
    return undefined;
  }
}

/**
 * The frame index to resume from so that no event after `seq` is missed.
 *
 * Frames are ordered by sequence, so the boundary is found by binary search over
 * the frames' first sequence numbers — 14 single-frame decodes find the edge of a
 * 10 000-frame log. The answer is deliberately one frame early: a checkpoint
 * usually lands inside a batch, and starting at the frame that first exceeds the
 * watermark would drop the rest of the batch it landed in.
 *
 * There is no "nothing new" answer. A log whose last frame begins at or before
 * `seq` can still hold later events in that same frame, so the last frame is
 * always offered — the caller filters by sequence number and pays one frame of
 * decode in the worst case, which is the price of never dropping an event.
 * @param buffer - the stored log.
 * @param ranges - its frame ranges.
 * @param seq - the last sequence already folded.
 * @returns the frame index to start decoding from.
 */
export function frameAfterSeq(buffer, ranges, seq) {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const first = firstSeqOf(frameText(buffer, ranges[middle]));
    if (first === undefined || first > seq) high = middle;
    else low = middle + 1;
  }
  // Every frame starts at or before the watermark: the newest events are inside
  // the last one, so that is where reading starts.
  if (low >= ranges.length) return ranges.length - 1;
  return Math.max(0, low - 1);
}

/** How much of a log's end a projection-seeded scan reads by default. */
export const TAIL_WINDOW = 128 * 1024;

/**
 * The most a seeded scan will read from the end of one log.
 *
 * A window that grows has to stop somewhere: past this point the caller reads
 * the log in full, which is what it would have paid anyway. 2 MB covers a live
 * session flushed at the Host's batch size (200 events), and a session that has
 * not been flushed for longer than that is cheaper to refold than to hunt for.
 */
export const MAX_TAIL_WINDOW = 2 * 1024 * 1024;

/**
 * Read the last `window` bytes of a stored log.
 *
 * A seeded scan only has to prove where the log now ends, and the last frame
 * carries that: reading 128 KB instead of a 28 MB file is what makes the
 * projection-seeded path cost nothing. The chunk usually starts inside a frame,
 * which {@link tailFrames} is there to fix.
 * @param path - the log file.
 * @param window - how many trailing bytes to read.
 * @returns the trailing bytes, shorter than `window` for a small file.
 */
export async function readTailChunk(path, window = TAIL_WINDOW) {
  const handle = await open(path, "r");
  try {
    const size = (await handle.stat()).size;
    const start = Math.max(0, size - window);
    const buffer = Buffer.allocUnsafe(size - start);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        filled,
        buffer.length - filled,
        start + filled,
      );
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return filled === buffer.length ? buffer : buffer.subarray(0, filled);
  } finally {
    await handle.close();
  }
}

/**
 * Locate the frame boundary a tail chunk starts on.
 *
 * A chunk read from the middle of a file begins inside a frame, so its first
 * bytes are unusable. The boundary is the first candidate whose frames walk
 * exactly to the end of the chunk: a stray occurrence of the magic inside
 * compressed data decodes into frames that stop short, and is skipped.
 * Verifying the walk reaches the end is what makes this safe, and it is why a
 * bare magic scan is not.
 * @param buffer - the tail chunk.
 * @returns the offset of the first whole frame within `buffer`, and that
 *   frame's ranges measured from that offset — so `buffer.subarray(offset)` is
 *   the chunk those ranges describe.
 */
export function tailFrames(buffer) {
  for (let start = 0; start <= buffer.length - 5; start += 1) {
    if (buffer.readUInt32LE(start) !== ZSTD_MAGIC) continue;
    const ranges = frameRanges(buffer.subarray(start));
    if (ranges.length === 0) continue;
    if (start + ranges[ranges.length - 1][1] === buffer.length)
      return { offset: start, ranges };
  }
  return undefined;
}

/**
 * The highest sequence number the log contains.
 *
 * One frame is decoded — the last — so a caller can check a stored watermark
 * against the log's real end without paying for the whole file. A torn final
 * record moves the probe one frame back.
 * @param buffer - the stored log.
 * @param ranges - its frame ranges.
 * @returns the highest sequence number, or -1 when the log carries none.
 */
export function lastSeqOf(buffer, ranges) {
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    let text;
    try {
      text = frameText(buffer, ranges[index]);
    } catch {
      continue;
    }
    let top = -1;
    for (const line of text.split("\n")) {
      if (line === "" || !line.includes('"seq"')) continue;
      try {
        const value = JSON.parse(line);
        if (typeof value?.seq === "number" && value.seq > top) top = value.seq;
      } catch {
        /* a torn record is simply not counted */
      }
    }
    if (top !== -1) return top;
  }
  return -1;
}

/**
 * Decode frames into JSONL records, starting at a frame edge.
 *
 * Only complete newline-terminated records are returned, and the reported end
 * offset stops at the last frame that ended on a boundary, so a torn tail is
 * left for the next pass rather than half-folded now.
 * @param buffer - the stored log.
 * @param ranges - its frame ranges.
 * @param from - the index of the first frame to decode.
 * @returns the parsed records and the byte offset the next pass can resume at.
 */
export async function readRecordsFrom(buffer, ranges, from) {
  const records = [];
  let end = ranges[from - 1]?.[1] ?? 0;
  let carry = "";
  for (let index = from; index < ranges.length; index += 1) {
    const text = carry + frameText(buffer, ranges[index]);
    const complete = text.lastIndexOf("\n");
    if (complete !== -1) {
      for (const line of text.slice(0, complete).split("\n"))
        if (line !== "") records.push(JSON.parse(line));
      carry = text.slice(complete + 1);
      end = ranges[index][1];
    } else {
      carry = text;
    }
    if ((index - from) % FRAMES_PER_YIELD === FRAMES_PER_YIELD - 1)
      await new Promise((resolve) => setImmediate(resolve));
  }
  // A final record without its newline is a torn append: the log is being
  // written right now, and the next pass will see it whole.
  return { records, end };
}

/**
 * Everything one pass needs to know about a stored log before decoding it.
 *
 * The header record is kept as text because the caller only has to compare its
 * id, and parsing it eagerly would cost more than the comparison.
 * @param buffer - the stored log.
 * @returns the frame ranges and header record, or undefined when the file is
 *   not a readable zstd log.
 */
export function inspectLog(buffer) {
  const ranges = frameRanges(buffer);
  if (ranges.length === 0) return undefined;
  const text = frameText(buffer, ranges[0]);
  const newline = text.indexOf("\n");
  if (newline === -1) return undefined;
  return { ranges, headerText: text.slice(0, newline) };
}

/**
 * Whether this Node build can decode zstd frames synchronously.
 * @returns true when the incremental reader can be used at all.
 */
export function zstdAvailable() {
  return typeof zstdDecompressSync === "function";
}

/**
 * The derived usage read model: one cache record per session, keyed by the
 * persistence revision that produced it.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { count } from "./time.js";
import { foldEvents } from "./scan.js";
import { modelRow } from "./schema.js";
import { isPeak, priceOf, profileOf, slotCost } from "./billing.js";
import {
  MAX_TAIL_WINDOW,
  TAIL_WINDOW,
  frameAfterSeq,
  frameSeqAt,
  inspectLog,
  lastSeqOf,
  readRecordsFrom,
  readTailChunk,
  tailFrames,
  zstdAvailable,
} from "./frames.js";
import { USAGE_PROJECTION_KEY, slotsOf, stateOf } from "./projection.js";

/** Sessions read in parallel while scanning. */
export const READ_CONCURRENCY = 6;

/**
 * How long a session that cannot be read at all is left alone.
 *
 * A log the backend refuses — a torn record, a compaction pair whose ids
 * disagree — fails the same way on every pass, and the persistence layer has no
 * memory of that: each attempt re-decodes the whole file before throwing. A
 * corruption that only the log's own size can change is therefore retried when
 * the file's revision moves, and a log that fails for a reason the revision does
 * not capture is retried after this long. Skipping a broken log costs nothing a
 * user can see: the record it would have produced cannot exist.
 */
export const FAILURE_RETRY_MS = 10 * 60_000;

/**
 * How long one scan pass satisfies `ensureFresh`.
 *
 * The panel is opened repeatedly and a scan costs a stat of every log plus a
 * re-read of whatever moved; paying that on every open is what made opening
 * the page wait seconds once the corpus grew. Inside this window the cached
 * aggregate answers immediately and no scan runs at all — the next window
 * crossing picks the new events up.
 */
export const SCAN_DEBOUNCE_MS = 3_000;

/**
 * Merge freshly folded slots into a record's existing ones.
 *
 * A changed session is re-read from its first unfolded event rather than from
 * zero, so the fold only ever sees the appended tail. Slots aggregate by
 * hour and model exactly as `foldEvents` builds them, so merging is per-row
 * addition of the same six counters — the two paths cannot disagree because
 * there is only one row shape.
 * @param existing - the slots already folded for this session.
 * @param added - the slots folded from the appended events.
 * @returns the merged slot rows.
 */
export function mergeSlots(existing, added) {
  const byKey = new Map();
  for (const slot of existing) byKey.set(`${slot[0]}|${slot[1]}`, [...slot]);
  for (const slot of added) {
    const key = `${slot[0]}|${slot[1]}`;
    const row = byKey.get(key);
    if (row === undefined) {
      byKey.set(key, [...slot]);
      continue;
    }
    for (let index = 2; index <= 7; index += 1)
      row[index] += count(slot[index]);
  }
  return [...byKey.values()];
}

/**
 * A fresh aggregate bucket.
 *
 * Layout, in order: input, output, cache-read, cache-write, total, calls, cost
 * — the eight columns every day, hour and model row already used — followed by
 * the peak band the same seven counters describe. The peak half travels with
 * the row rather than in a parallel map because a card that shows a cost and a
 * card that shows how much of it was peak must never disagree about which
 * slots they cover; one array keeps them on the same slice.
 * @returns a zeroed row.
 */
function newRow() {
  return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
}

/**
 * Add one slot into a bucket.
 * @param row - the bucket from {@link newRow}.
 * @param slot - `[hour, model, input, output, cacheRead, cacheWrite, total, calls]`.
 * @param price - the slot's cost in the configured currency.
 * @param peak - whether the slot billed at the peak rate.
 */
function foldInto(row, slot, price, peak) {
  for (let index = 2; index <= 7; index += 1)
    row[index - 2] += count(slot[index]);
  row[6] += price;
  if (!peak) return;
  for (let index = 2; index <= 7; index += 1)
    row[index + 5] += count(slot[index]);
  row[13] += price;
}

/**
 * The bucket for one key in a flat map.
 * @param map - key to bucket.
 * @param key - the bucket's key.
 * @returns the bucket, created when absent.
 */
function bucket(map, key) {
  let row = map.get(key);
  if (row === undefined) {
    row = newRow();
    map.set(key, row);
  }
  return row;
}

/**
 * The bucket for one key inside a two-level map.
 * @param outer - outer key to inner map.
 * @param outerKey - the outer key, usually a model.
 * @param key - the inner key, usually a day or an hour.
 * @returns the bucket, created when absent.
 */
function bucketOf(outer, outerKey, key) {
  let inner = outer.get(outerKey);
  if (inner === undefined) {
    inner = new Map();
    outer.set(outerKey, inner);
  }
  return bucket(inner, key);
}

/**
 * Schema version of the cache document. Bumping it discards every record,
 * which is the correct response to a change in what a record holds — a stale
 * record read under a new shape would report wrong totals rather than fail.
 */
export const CACHE_VERSION = 5;

/**
 * Run `task` over `items` with at most `limit` in flight.
 * @param items - inputs in result order.
 * @param limit - maximum concurrent tasks.
 * @param task - async worker.
 * @returns results in the input order.
 */
async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await task(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * Resolve the cache file location: a derived read model lives beside the other
 * profile storages, never inside a workspace.
 * @param ctx - host plugin context.
 * @returns absolute path of the cache document.
 */
/**
 * The directory this plugin owns under the profile home.
 *
 * Shared by every cache the plugin keeps so one rule decides where plugin
 * state lives, and a host that moves the profile home moves all of it.
 * @param ctx - host plugin context.
 * @returns the plugin storage directory.
 */
export function storageDirOf(ctx) {
  const home =
    ctx.get("profileContext")?.home ??
    process.env.DSH_HOME ??
    join(homedir(), ".dsh");
  return join(home, "storages", "dsh-token-panorama");
}

/**
 * The derived usage read model: one cache record per session keyed by the
 * persistence revision that produced it.
 */
export class UsageIndex {
  /**
   * @param ctx - host plugin context with `sessionPersistence` injected.
   * @param rules - the resolved billing rules.
   */
  constructor(ctx, rules) {
    this.ctx = ctx;
    this.rules = rules;
    this.path = join(storageDirOf(ctx), "usage-cache.json");
    this.records = new Map();
    /** Sessions whose log refused to be read, so a pass can skip them. */
    this.failures = new Map();
    /** Resolved log paths, dropped with the record they belong to. */
    this.paths = new Map();
    this.loaded = false;
    this.lastScanAt = 0;
    this.scanPromise = null;
    this.lastError = null;
    /** The last aggregate built, and the rules object it was priced with. */
    this.doc = null;
    this.docRules = null;
  }

  /** Read the cache document once per plugin lifetime. */
  async load() {
    if (this.loaded) return;
    this.loaded = true;
    let text;
    try {
      text = await readFile(this.path, "utf8");
    } catch {
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (
      parsed?.version !== CACHE_VERSION ||
      typeof parsed.sessions !== "object" ||
      parsed.sessions === null
    )
      return;
    for (const [id, record] of Object.entries(parsed.sessions)) {
      if (typeof record?.revision !== "string") continue;
      if (!Array.isArray(record.slots)) continue;
      this.records.set(id, record);
    }
  }

  /** Persist the cache document atomically; failures never break a scan. */
  async save() {
    const sessions = {};
    for (const [id, record] of this.records) sessions[id] = record;
    const body = `${JSON.stringify({ version: CACHE_VERSION, sessions })}\n`;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      const staged = `${this.path}.tmp`;
      await writeFile(staged, body, "utf8");
      await rename(staged, this.path);
    } catch (error) {
      this.ctx.logger?.warn?.(
        `dsh-token-panorama: could not persist the usage cache: ${String(error)}`,
      );
    }
  }

  /**
   * Scan the corpus. Concurrent callers share one run.
   * @param force - re-read every session even when its revision is unchanged.
   * @returns the scan summary.
   */
  async scan(force = false) {
    if (this.scanPromise !== null) return this.scanPromise;
    this.scanPromise = this.runScan(force).finally(() => {
      this.scanPromise = null;
    });
    return this.scanPromise;
  }

  /**
   * One scan pass: list the corpus, re-read only changed sessions, prune
   * records whose session disappeared.
   *
   * The pass reads the logs itself instead of going through
   * `sessionPersistence.open()`. That seam decodes a whole log before it can
   * answer anything, so a session that appended a hundred events would cost a
   * full re-inflation of its entire history — on a 28 MB log, half a second for
   * a tail that is 8 % of the file. Reading the container directly makes the
   * cost follow the number of frames that are actually new, and lets a log the
   * backend refuses be remembered as unreadable instead of being decoded again
   * on every open.
   * @param force - ignore cached revisions.
   */
  async runScan(force) {
    await this.load();
    const persistence = this.ctx.sessionPersistence;
    let snapshots;
    try {
      snapshots = await persistence.list();
    } catch (error) {
      this.lastError = String(error);
      throw error;
    }
    const timeZone = this.rules.timeZone;
    const seen = new Set();
    let read = 0;
    let reused = 0;
    let failed = 0;
    let skipped = 0;
    const pending = snapshots.filter((snapshot) => {
      const id = snapshot.header?.id;
      if (typeof id !== "string") return false;
      seen.add(id);
      const cached = this.records.get(id);
      if (
        !force &&
        cached !== undefined &&
        cached.revision === snapshot.revision &&
        cached.zone === timeZone
      ) {
        reused += 1;
        return false;
      }
      // A log that already failed at this exact revision will fail again: the
      // backend's decode refusal is a property of the bytes, not of the moment.
      // Retrying it every pass is how three unreadable sessions used to cost a
      // third of a second per panel open, forever.
      if (!force && this.isUnreadable(id, snapshot)) {
        skipped += 1;
        return false;
      }
      return true;
    });
    await this.primePaths(persistence, pending);
    await mapLimit(pending, READ_CONCURRENCY, async (snapshot) => {
      const id = snapshot.header.id;
      const outcome = await this.readSession(snapshot, timeZone, force);
      if (outcome === "read") read += 1;
      else if (outcome === "failed") failed += 1;
    });
    for (const id of [...this.records.keys()])
      if (!seen.has(id)) {
        this.records.delete(id);
        this.failures.delete(id);
      }
    for (const id of [...this.failures.keys()])
      if (!seen.has(id)) this.failures.delete(id);
    this.lastScanAt = Date.now();
    this.lastError = null;
    // Whatever this pass saw, the previous aggregate no longer describes it.
    this.doc = null;
    if (read > 0 || force) await this.save();
    return {
      sessions: seen.size,
      read,
      reused,
      skipped,
      failed,
      at: this.lastScanAt,
    };
  }

  /**
   * Whether a session's last attempt failed and is still worth skipping.
   * @param id - the session.
   * @param snapshot - its current listing entry.
   * @returns true when the same bytes already failed recently.
   */
  isUnreadable(id, snapshot) {
    const failure = this.failures.get(id);
    if (failure === undefined) return false;
    // Different bytes: whatever the last attempt choked on may be gone, so the
    // file is read again immediately. This is what makes repair and append
    // visible at once instead of after the retry window.
    if (failure.revision !== snapshot.revision) return false;
    // Same bytes: the failure is a property of this exact log, and the window
    // is only there to keep a transient one from parking the session forever.
    return Date.now() - failure.at < FAILURE_RETRY_MS;
  }

  /**
   * Read one session and fold whatever it appended since the last pass.
   *
   * Three readers, tried in order of cost. The projection cache is the cheapest:
   * the Host folded this session while it was live and its companion service
   * wrote the result to disk, so a finished session needs no log read at all and
   * a live one only the frames past its watermark. The container reader is the
   * fallback — it inspects the log for frame edges and inflates only the frames
   * past the stored cursor. The persistence seam is the last resort and the only
   * path that validates the log's own event grammar.
   *
   * A log this reader accepts but the backend would refuse cannot corrupt a
   * fold — the fold only reads `type`, `time` and `data.usage` — but a backend
   * failure is recorded so the next pass does not pay to decode the same bytes
   * again.
   * @param snapshot - the session's listing entry.
   * @param timeZone - the zone that decides slot boundaries.
   * @param force - whether the caller asked for a full re-read.
   * @returns what happened: "read", "empty" or "failed".
   */
  async readSession(snapshot, timeZone, force) {
    const id = snapshot.header.id;
    try {
      const cached = this.records.get(id);
      // A forced pass distrusts this index's own record, not the Host's fold: the
      // projection row was produced by the Host from the same events, and the
      // seed path proves its watermark against the log's real end before using
      // it. Passing no record throws away the revision shortcut while keeping
      // that proof, which is what makes the refresh button cheap instead of a
      // full re-inflation of the corpus.
      const seeded = await this.readSeeded(
        snapshot,
        timeZone,
        force ? undefined : cached,
      );
      if (seeded !== undefined) return seeded;
      const resumable =
        !force &&
        cached !== undefined &&
        cached.zone === timeZone &&
        cached.bytes > 0 &&
        Number.isFinite(cached.events);
      const done = await this.readLog(
        snapshot,
        timeZone,
        resumable ? cached : undefined,
      );
      if (done !== undefined) return done;
      return await this.readThroughSeam(snapshot, timeZone);
    } catch (error) {
      this.failures.set(id, {
        revision: snapshot.revision,
        at: Date.now(),
        error: String(error),
      });
      // A session that failed keeps whatever fold it already had: losing a
      // whole history to one bad tail would misprice every day it covers.
      this.ctx.logger?.warn?.(
        `dsh-token-panorama: could not read session ${id}: ${String(error)}`,
      );
      return "failed";
    }
  }

  /**
   * Fold one session from the Host's own projection of it.
   *
   * The Host folds every committed session event while the events are still in
   * memory, and its companion service writes those states to disk. Reading that
   * row instead of the log is what turns "scan the corpus" into "list the
   * corpus": the row already covers every event the Host saw, so a session that
   * is not live has nothing left to read.
   *
   * Every proof that fails returns `undefined` and the caller reads the log
   * instead, so a row can only ever save work, never change an answer. The row
   * is accepted only when its state version, its zone and its watermark agree
   * with the log the listing describes. A watermark past the log's end means the
   * record describes a different log. A watermark behind the log's end is not a
   * rejection: the state is the fold of everything up to that point, and the
   * frames after it are decoded and merged on top — provided the chunk read from
   * the tail still reaches back to it.
   * @param snapshot - the session's listing entry.
   * @param timeZone - the zone that decides slot boundaries.
   * @param cached - the record to resume from, when the caller has one.
   * @returns the outcome, or undefined when the seed cannot be used.
   */
  async readSeeded(snapshot, timeZone, cached) {
    if (!zstdAvailable()) return undefined;
    const id = snapshot.header.id;
    // Nothing moved since the last pass: the record already covers this
    // revision, and no row can know more than the log it was folded from.
    if (
      cached !== undefined &&
      cached.zone === timeZone &&
      cached.revision === snapshot.revision
    )
      return "empty";
    const row = this.projectionRow(snapshot.header, timeZone);
    if (row === undefined) return undefined;
    const path = await this.currentPath(id);
    if (path === undefined) return undefined;
    // The window starts small — a session that is not live needs none of it —
    // and grows while the frames it holds do not reach back to the watermark.
    // The Host folds a live session in batches (every 200 events, plus a
    // five-second timer), so a scan of a working session can find its row a few
    // hundred events behind: a fixed window would then miss the gap and pay for
    // a whole-log decode, which is the cost this reader exists to avoid.
    let window = TAIL_WINDOW;
    let chunk;
    let body;
    let ranges;
    let end;
    for (;;) {
      try {
        chunk = await readTailChunk(path, window);
      } catch {
        // The remembered path is the only thing that can be wrong here, and a
        // wrong one would fail every future pass.
        this.paths.delete(id);
        return undefined;
      }
      if (chunk.length === 0) return undefined;
      const tail = tailFrames(chunk);
      if (tail === undefined) return undefined;
      // The tail's ranges are measured from the frame the chunk happens to start
      // on, so everything after this point works on that slice.
      body = chunk.subarray(tail.offset);
      ranges = tail.ranges;
      end = lastSeqOf(body, ranges);
      if (end === -1) return undefined;
      // The row claims more events than the log holds: it was folded from a log
      // that is no longer this one, and its state cannot be trusted at all.
      if (row.seq > end) return undefined;
      if (row.seq === end) break;
      // The chunk reaches back only so far. If its first frame starts after the
      // watermark, the events in between were never read, and merging the row
      // with this tail would silently lose them; widen and look again.
      const firstSeq = frameSeqAt(body, ranges, 0);
      if (firstSeq !== undefined && firstSeq <= row.seq + 1) break;
      // A chunk that already holds the whole file cannot be widened: the
      // watermark is not reachable from the tail, so the caller refolds the log.
      if (chunk.length < window || window >= MAX_TAIL_WINDOW) return undefined;
      window = Math.min(window * 4, MAX_TAIL_WINDOW);
    }
    let folded;
    let added = 0;
    if (row.seq === end) {
      // The row is already the whole fold. This is the case a corpus of finished
      // sessions is entirely made of.
      folded = { title: row.state.title, lastSeq: row.seq, slots: row.slots };
    } else {
      const read = await readRecordsFrom(
        body,
        ranges,
        frameAfterSeq(body, ranges, row.seq),
      );
      // `frameAfterSeq` starts one frame early on purpose, so the slice repeats
      // events the row already counted. Dropping them by seq is what keeps an
      // hour from being billed twice.
      const events = read.records.filter(
        (event) => typeof event?.seq !== "number" || event.seq > row.seq,
      );
      const merged = foldEvents(events, timeZone);
      added = events.length;
      folded = {
        title: merged.title !== "" ? merged.title : row.state.title,
        lastSeq: merged.lastSeq === -1 ? row.seq : merged.lastSeq,
        slots: mergeSlots(row.slots, merged.slots),
      };
    }
    this.store(
      id,
      snapshot,
      timeZone,
      folded,
      (cached?.events ?? 0) + added,
      // No byte cursor: the chunk that was read is not the file, so the next
      // pass must look at the container again rather than resume from here.
      0,
      folded.lastSeq,
      cached === undefined ? undefined : { ...cached, slots: [] },
    );
    this.failures.delete(id);
    return "read";
  }

  /**
   * The projection row to seed from, or undefined when there is no usable one.
   *
   * Read through the cache's own view face rather than its record table: the
   * view is the contract — it checks the record against the lifecycle the
   * listed header witnesses, drops rows written at another state version, and
   * validates the state before handing it out. Reading the rows directly would
   * skip all three checks and trust whatever the file happens to hold.
   * @param header - the listed session header.
   * @param timeZone - the zone the fold is bucketed in.
   * @returns the watermark and its state.
   */
  projectionRow(header, timeZone) {
    const cache = this.ctx.get("sessionProjectionCache");
    if (typeof cache?.cachedSnapshot !== "function") return undefined;
    let block;
    try {
      block = cache.cachedSnapshot(header, [USAGE_PROJECTION_KEY]);
    } catch {
      return undefined;
    }
    const value = block?.values?.[USAGE_PROJECTION_KEY];
    if (value === undefined) return undefined;
    const state = stateOf(value);
    if (state === undefined) return undefined;
    // A row bucketed in another zone would put one event's tokens in an hour the
    // panel never shows; the log has to be folded again instead.
    if (state.zone !== timeZone) return undefined;
    if (typeof block.asOfSeq !== "number" || block.asOfSeq < 0) return undefined;
    // Every stored row must be a slot. One that is not means the state on disk
    // is not the fold this reader thinks it is, and a partial fold is more
    // dangerous than no seed at all: the totals would come out low and be
    // cached as the truth.
    const slots = slotsOf(state);
    if (slots.length !== state.rows.length) return undefined;
    return { seq: block.asOfSeq, state, slots };
  }

  /**
   * Fold one session straight from its stored log.
   *
   * This is the reader that made the difference: the persistence seam inflates
   * the whole log before it will hand back a single event, so a 28 MB session
   * cost half a second whether the pass needed all of it or the last four
   * events. Reading the container directly skips that — the zstd frame table is
   * walked without decompressing anything, and only the frames past the stored
   * cursor are inflated. A pass over an unchanged corpus resumes at the end of
   * the log and decodes nothing at all.
   *
   * The record's own revision is what makes this safe: a log that was rewritten,
   * truncated, or replaced by a generation with another header cannot resume,
   * and every one of those cases falls back to a full read rather than mixing
   * two logs into one fold.
   * @param snapshot - the session's listing entry.
   * @param timeZone - the zone that decides slot boundaries.
   * @param cached - the record to resume from, or undefined for a full read.
   * @returns the outcome, or undefined when the file is not a log this reader
   *   understands and the seam should be tried instead.
   */
  async readLog(snapshot, timeZone, cached) {
    const id = snapshot.header.id;
    const path = await this.currentPath(id);
    if (path === undefined) return undefined;
    let buffer;
    try {
      buffer = await readFile(path);
    } catch (error) {
      // The remembered path is the only thing that can be wrong here, and a
      // wrong one would fail every future pass.
      this.paths.delete(id);
      throw error;
    }
    const info = inspectLog(buffer);
    if (info === undefined) return undefined;
    let header;
    try {
      header = JSON.parse(info.headerText);
    } catch {
      return undefined;
    }
    if (header?.id !== id) return undefined;
    if (cached !== undefined) {
      // A different creation time means a different session was rewritten over
      // this id: the cursor describes bytes that are no longer here.
      if (header.createdAt !== cached.createdAt) return undefined;
      if (buffer.length < cached.bytes) return undefined;
      if (buffer.length === cached.bytes) {
        // The file is exactly where the recorded read stopped, so the record
        // already covers it and the listing's revision was the only thing that
        // moved.
        this.adopt(id, snapshot, cached, buffer.length);
        return "empty";
      }
    }
    const from =
      cached === undefined
        ? 0
        : frameAfterSeq(buffer, info.ranges, cached.lastSeq);
    const read = await readRecordsFrom(buffer, info.ranges, from);
    // The first record is the session header, not an event. A resumed slice
    // starts one frame early on purpose, so it repeats a few events the record
    // already counted and they are dropped by sequence number.
    const events =
      cached === undefined
        ? read.records.slice(1)
        : read.records.filter(
            (event) =>
              typeof event?.seq !== "number" || event.seq > cached.lastSeq,
          );
    if (cached !== undefined && events.length === 0) {
      this.adopt(id, snapshot, cached, read.end);
      return "empty";
    }
    const folded = foldEvents(events, timeZone);
    this.store(
      id,
      snapshot,
      timeZone,
      folded,
      cached === undefined ? events.length : cached.events + events.length,
      read.end,
      folded.lastSeq === -1 ? (cached?.lastSeq ?? -1) : folded.lastSeq,
      cached,
    );
    this.failures.delete(id);
    return "read";
  }

  /**
   * Accept a new revision for a record whose bytes were already folded.
   *
   * The fold is unchanged — the log holds nothing the record does not already
   * cover — so only the listing's witness and the byte cursor move. The zone is
   * not touched: the slots were bucketed in the record's own zone, and
   * `readSession` only resumes a record whose zone matches the current one.
   * @param id - the session.
   * @param snapshot - its listing entry.
   * @param cached - the record being carried forward.
   * @param bytes - the byte offset the record now covers.
   */
  adopt(id, snapshot, cached, bytes) {
    this.records.set(id, {
      ...cached,
      revision: snapshot.revision,
      bytes: Number.isFinite(bytes) ? bytes : cached.bytes,
    });
  }

  /**
   * The fallback read: let the persistence seam decode and validate the log.
   * @param snapshot - the session's listing entry.
   * @param timeZone - the zone that decides slot boundaries.
   * @returns the outcome.
   */
  async readThroughSeam(snapshot, timeZone) {
    const id = snapshot.header.id;
    const handle = await this.ctx.sessionPersistence.open(id, "read");
    try {
      const slice = await handle.read(0, Number.MAX_SAFE_INTEGER);
      const folded = foldEvents(slice.events, timeZone);
      // The cursor stays 0: the container was not inspected here, so the next
      // pass has to look at it before it may resume.
      this.store(
        id,
        snapshot,
        timeZone,
        folded,
        slice.events.length,
        0,
        folded.lastSeq,
        undefined,
      );
      this.failures.delete(id);
      return "read";
    } finally {
      try {
        await handle.close();
      } catch {
        /* a read handle that refuses to close costs nothing here */
      }
    }
  }

  /**
   * Record one folded result.
   * @param id - the session.
   * @param snapshot - its listing entry, for the revision and header fields.
   * @param timeZone - the zone the slots are keyed in.
   * @param folded - the fold from this pass, covering only what was re-read.
   * @param events - how many events the record now covers in total.
   * @param bytes - the byte cursor the next pass resumes at (0 when unknown).
   * @param lastSeq - the highest sequence number the record has folded.
   * @param previous - the record this one replaces, when resuming.
   */
  store(id, snapshot, timeZone, folded, events, bytes, lastSeq, previous) {
    this.records.set(id, {
      revision: snapshot.revision,
      zone: timeZone,
      createdAt: count(snapshot.header.createdAt),
      origin: snapshot.header.origin === "subagent" ? "subagent" : "main",
      cwd: typeof snapshot.header.cwd === "string" ? snapshot.header.cwd : "",
      parent:
        typeof snapshot.header.parentSession === "string"
          ? snapshot.header.parentSession
          : "",
      // The newest title wins, but only when the tail carried one: a session
      // that appended usage without renaming keeps its name.
      title: folded.title !== "" ? folded.title : (previous?.title ?? ""),
      slots:
        previous === undefined
          ? folded.slots
          : mergeSlots(previous.slots, folded.slots),
      events,
      bytes,
      lastSeq,
    });
  }

  /**
   * Resolve every session's log path in one corpus walk.
   *
   * The backend can report each artifact's path while it lists them, which it
   * already does to build the listing. Doing that instead of one
   * `resolveCurrentLog` per session is what keeps a seeded scan from paying a
   * directory walk per session.
   * @param persistence - the persistence service.
   * @param pending - the sessions this pass will read.
   */
  async primePaths(persistence, pending) {
    if (typeof persistence?.listArtifacts !== "function") return;
    // Only sessions that will actually be read need a path, and a pass that
    // reads nothing must not pay for the walk: that is the steady state the
    // panel is opened in.
    if (!pending.some((snapshot) => !this.paths.has(snapshot.header.id)))
      return;
    let artifacts;
    try {
      artifacts = await persistence.listArtifacts();
    } catch {
      // A backend that cannot list artifacts still answers per id; the fallback
      // is exactly what this method exists to avoid, not a failure.
      return;
    }
    this.paths.clear();
    for (const artifact of artifacts) {
      const id = artifact?.header?.id;
      if (typeof id === "string" && typeof artifact.path === "string")
        this.paths.set(id, artifact.path);
    }
  }

  /**
   * The log file a session id currently resolves to.
   *
   * The backend knows the layout — project directory, generation suffix,
   * compression — and this is the one call that will not decode the log to
   * answer. It costs a directory walk, so the answer is remembered until the
   * session's listing revision moves.
   * @param id - the session.
   * @returns the absolute path, or undefined when the backend cannot resolve it.
   */
  async currentPath(id) {
    const persistence = this.ctx.sessionPersistence;
    if (typeof persistence?.resolveCurrentLog !== "function") return undefined;
    const remembered = this.paths.get(id);
    if (remembered !== undefined) return remembered;
    try {
      const path = await persistence.resolveCurrentLog(id);
      if (typeof path !== "string") return undefined;
      this.paths.set(id, path);
      return path;
    } catch {
      return undefined;
    }
  }

  /**
   * Bring the index up to date, at most once per debounce window.
   *
   * Listing the corpus is cheap — the persistence service reports each log's
   * revision without decoding it — but "cheap" still grew into a wait once the
   * roster ran to hundreds of sessions, and the panel is opened far more often
   * than the data moves. Inside the window the caller gets the cached
   * aggregate with no scan at all; `isFresh` is what the route uses to decide
   * whether it may answer from cache.
   */
  async ensureFresh() {
    if (this.isFresh()) return;
    await this.scan(false);
  }

  /**
   * Whether the last scan pass is recent enough to answer from cache.
   * @returns true within the debounce window after a completed pass.
   */
  isFresh() {
    return (
      this.lastScanAt > 0 && Date.now() - this.lastScanAt < SCAN_DEBOUNCE_MS
    );
  }

  /**
   * Drop every cached fold and the cache file, so the next scan re-reads the
   * corpus from zero. This is the settings window's escape hatch: a cache that
   * somehow disagrees with the logs is worse than no cache, and rebuilding
   * once is cheaper than arguing with it.
   */
  async clear() {
    this.records.clear();
    this.failures.clear();
    this.paths.clear();
    this.doc = null;
    this.docRules = null;
    this.loaded = true;
    this.lastScanAt = 0;
    this.lastError = null;
    try {
      await rm(this.path, { force: true });
    } catch (error) {
      this.ctx.logger?.warn?.(
        `dsh-token-panorama: could not delete the usage cache: ${String(error)}`,
      );
    }
  }

  /**
   * The registry-global archive set, or an empty set when the workspace
   * service is absent from this composition. Archived sessions keep their logs,
   * so `sessionPersistence` already lists them; this only labels them so the
   * Client can show or filter them.
   * @returns the archived session ids.
   */
  archivedIds() {
    try {
      const registry = this.ctx.get("workspaceRegistry");
      const ids = registry?.archivedSessionIds;
      return Array.isArray(ids) ? new Set(ids) : new Set();
    } catch {
      return new Set();
    }
  }

  /**
   * Aggregate every cached record into the payload the Client renders.
   *
   * Cost is decided here rather than in the Client because the price sheet and
   * the peak windows are Host configuration: sending priced numbers keeps one
   * definition of the billing rules, and the Client only sums what it shows.
   * @returns the wire document, minus the per-call `scan` field.
   */
  buildSnapshot() {
    const rules = this.rules;
    const days = new Map();
    // Hourly rows alongside the daily ones: the Client switches its trend axis
    // to hours when the range narrows to today or the last 24 hours, and
    // deriving those from slots it already has would mean re-aggregating every
    // session on each render.
    const hours = new Map();
    const models = new Map();
    // Per-model daily rows, so the Client can re-derive every card for one
    // model without a second Host call: `{model: [[day, …counters], …]}`.
    const modelDays = new Map();
    /** Per-model hourly rows, the hour-grain twin of `modelDays`. */
    const modelHours = new Map();
    /** Per-model billing counters, same shape as the global ones. */
    const modelBilling = new Map();
    const totals = [0, 0, 0, 0, 0, 0];
    const archived = this.archivedIds();
    const sessions = [];
    const unpriced = new Set();
    const priced = new Set();
    let cost = 0;
    let peakCost = 0;
    let offPeakCost = 0;
    let peakTokens = 0;
    let offPeakTokens = 0;
    let peakCalls = 0;
    let offPeakCalls = 0;
    let subagent = 0;
    let main = 0;
    let archivedCount = 0;

    for (const [id, record] of this.records) {
      if (record.origin === "subagent") subagent += 1;
      else main += 1;
      const isArchived = archived.has(id);
      if (isArchived) archivedCount += 1;

      const byDay = new Map();
      const byModel = new Map();
      /** `[hour, model, …counters, cost]` per slot the session ran. */
      const bySlot = [];
      const sessionModels = new Set();
      let sessionTotal = 0;
      let sessionCalls = 0;
      let sessionCost = 0;

      for (const slot of record.slots) {
        // Peak is a per-model decision: each model names the profile it
        // follows, so one session can bill two models on different schedules.
        // A model with no schedule bills flat, and `isPeak` reports false for
        // it; counting that as off-peak would put a model that never gets a
        // discount into the discounted column, so it is reported as peak — the
        // band whose price it actually pays.
        const profile = profileOf(priceOf(slot[1], rules), rules);
        const peak = profile === undefined || isPeak(slot[0], profile, rules);
        const slotTotal = count(slot[6]);
        const slotCalls = count(slot[7]);
        const slotPrice = slotCost(slot, peak, rules);
        const known = rules.models?.[slot[1]] !== undefined;
        if (known) priced.add(slot[1]);
        else unpriced.add(slot[1]);

        // Every aggregate below is a bucket of the same shape, so the slot is
        // folded into all of them through one pair of helpers. Spelling the
        // six counter additions out at each site is how the day rows and the
        // hour rows drifted apart in the first place.
        const day = slot[0].slice(0, 10);
        foldInto(bucket(days, day), slot, slotPrice, peak);
        foldInto(bucket(hours, slot[0]), slot, slotPrice, peak);
        foldInto(bucket(models, slot[1]), slot, slotPrice, peak);
        foldInto(bucket(byDay, day), slot, slotPrice, peak);
        foldInto(bucket(byModel, slot[1]), slot, slotPrice, peak);
        foldInto(bucketOf(modelDays, slot[1], day), slot, slotPrice, peak);
        foldInto(bucketOf(modelHours, slot[1], slot[0]), slot, slotPrice, peak);

        if (peak) {
          peakTokens += slotTotal;
          peakCalls += slotCalls;
          peakCost += slotPrice;
        } else {
          offPeakTokens += slotTotal;
          offPeakCalls += slotCalls;
          offPeakCost += slotPrice;
        }
        sessionTotal += slotTotal;
        sessionCalls += slotCalls;
        sessionCost += slotPrice;
        cost += slotPrice;
        sessionModels.add(slot[1]);

        // The slot itself, at the hour grain it was recorded at. This is the
        // finest fact the Host has, so the Client can answer any range, grain
        // or model filter from the session row alone — a day-level rollup
        // would make "this session used model X, but only after 18:00"
        // unanswerable and would mis-attribute a multi-model day.
        bySlot.push([
          slot[0],
          slot[1],
          count(slot[2]),
          count(slot[3]),
          count(slot[4]),
          count(slot[5]),
          slotTotal,
          slotCalls,
          slotPrice,
          peak ? 1 : 0,
        ]);

        // The same slot, attributed to its model's billing counters, so the
        // Client can re-derive the peak/off-peak cards for one model without
        // re-reading anything.
        let modelBill = modelBilling.get(slot[1]);
        if (modelBill === undefined) {
          modelBill = {
            cost: 0,
            peakCost: 0,
            offPeakCost: 0,
            peakTokens: 0,
            offPeakTokens: 0,
            peakCalls: 0,
            offPeakCalls: 0,
            hits: 0,
            misses: 0,
          };
          modelBilling.set(slot[1], modelBill);
        }
        modelBill.cost += slotPrice;
        if (peak) {
          modelBill.peakCost += slotPrice;
          modelBill.peakTokens += slotTotal;
          modelBill.peakCalls += slotCalls;
        } else {
          modelBill.offPeakCost += slotPrice;
          modelBill.offPeakTokens += slotTotal;
          modelBill.offPeakCalls += slotCalls;
        }
        // A cache hit is input the provider served from cache; a miss is input
        // it had to read fresh. A cache write is a third thing — input it
        // stored — so it stays out of the hit-rate denominator.
        modelBill.hits += count(slot[4]);
        modelBill.misses += count(slot[2]);
      }

      sessions.push([
        id,
        record.title ?? "",
        record.createdAt,
        record.origin === "subagent" ? 1 : 0,
        isArchived ? 1 : 0,
        sessionTotal,
        sessionCalls,
        record.parent ?? "",
        [...byDay.entries()]
          .map(([day, row]) => [day, ...row])
          .sort((left, right) => (left[0] < right[0] ? -1 : 1)),
        sessionCost,
        record.cwd ?? "",
        // `[hour, model, input, output, cacheRead, cacheWrite, total, calls,
        // cost]` — every slot the session ran, so the Client can narrow the
        // row to the shared range and to a focused model without re-reading
        // the session logs.
        bySlot.sort((left, right) =>
          left[0] === right[0]
            ? left[1] < right[1]
              ? -1
              : 1
            : left[0] < right[0]
              ? -1
              : 1,
        ),
        // Every model the session touched, so "did this session use model X"
        // is a set lookup rather than a scan of its slots.
        [...sessionModels].sort(),
      ]);
    }

    for (const row of days.values())
      for (let index = 0; index < 6; index += 1) totals[index] += row[index];
    // The peak band is the same column block on the same rows, so the
    // account-wide peak figures come from the same pass rather than from a
    // second loop that could drift from the per-day cards.
    //
    // `newRow` is 14 long — input, output, cacheRead, cacheWrite, total,
    // calls, cost, then the same seven for the peak band. The peak total is
    // therefore index 11 and the peak cost index 13; reading 12 here would
    // pick up the peak *call count*, which is a number of the right shape and
    // would silently report two tokens instead of a million.
    const peakTotals = [0, 0];
    for (const row of days.values()) {
      peakTotals[0] += row[11];
      peakTotals[1] += row[13];
    }
    const dayRows = [...days.entries()]
      .map(([day, row]) => [day, ...row])
      .sort((left, right) => (left[0] < right[0] ? -1 : 1));
    const hourRows = [...hours.entries()]
      .map(([hour, row]) => [hour, ...row])
      .sort((left, right) => (left[0] < right[0] ? -1 : 1));
    const modelRows = [...models.entries()]
      .map(([model, row]) => [model, ...row])
      .sort((left, right) => right[6] - left[6]);
    sessions.sort((left, right) => right[6] - left[6]);

    // A cache hit rate answers "of the input the model read, how much came
    // from cache". A cache write is input the provider had to store, not a
    // read it served, so counting it as a miss would understate the hit rate
    // for exactly the sessions that are warming a cache.
    const cacheRead = totals[2];
    const missInput = totals[0];
    const cacheBase = cacheRead + missInput;

    return {
      generatedAt: Date.now(),
      lastScanAt: this.lastScanAt,
      sessions: {
        total: this.records.size,
        subagent,
        main,
        archived: archivedCount,
      },
      totals: {
        input: totals[0],
        output: totals[1],
        cacheRead: totals[2],
        cacheWrite: totals[3],
        total: totals[4],
        calls: totals[5],
        cost,
        // The peak share of the same span. Every day, hour and model row
        // carries this block too, so a card narrowed to a range sums the rows
        // it shows and gets the right peak split for that range — which is why
        // the whole-corpus figures here are only the default the Client shows
        // before it has filtered anything.
        peakTokens: peakTotals[0],
        peakCost: peakTotals[1],
      },
      cache: {
        hits: cacheRead,
        misses: missInput,
        hitRate: cacheBase === 0 ? null : cacheRead / cacheBase,
      },
      billing: {
        currency: rules.currency,
        timeZone: rules.timeZone,
        cost,
        peakCost,
        offPeakCost,
        peakTokens,
        offPeakTokens,
        peakCalls,
        offPeakCalls,
        hitRate: cacheBase === 0 ? 0 : cacheRead / cacheBase,
        hits: cacheRead,
        misses: missInput,
        priced: [...priced].sort(),
        unpriced: [...unpriced].sort(),
        // The models actually observed in the logs, so the settings window can
        // open with a row per model instead of an empty table. Usage rides
        // along because it is what tells the user which rows matter.
        observed: modelRows.map((row) => ({
          model: row[0],
          total: row[5],
          calls: row[6],
          cost: row[7],
          configured: rules.models?.[row[0]] !== undefined,
        })),
      },
      days: dayRows,
      // Hourly rows in the same layout as `days`, so the trend card can switch
      // its axis to hours for a one-day range without re-reading the corpus.
      hours: hourRows,
      models: modelRows,
      // `[model, {cost, peakCost, …}]` so a focused model can re-derive every
      // billing figure the cards show, over any range.
      modelBilling: [...modelBilling.entries()],
      // `[model, [[day, input, output, cacheRead, cacheWrite, total, calls, cost], …]]`
      // so the Client can total one model over any range without a round trip.
      modelDays: [...modelDays.entries()].map(([model, perModel]) => [
        model,
        [...perModel.entries()]
          .map(([day, row]) => [day, ...row])
          .sort((left, right) => (left[0] < right[0] ? -1 : 1)),
      ]),
      // The hour-grain twin of `modelDays`: `[model, [[hour, …], …]]`.
      modelHours: [...modelHours.entries()].map(([model, perHour]) => [
        model,
        [...perHour.entries()]
          .map(([hour, row]) => [hour, ...row])
          .sort((left, right) => (left[0] < right[0] ? -1 : 1)),
      ]),
      sessionRows: sessions,
      firstDay: dayRows.length === 0 ? null : dayRows[0][0],
      lastDay: dayRows.length === 0 ? null : dayRows[dayRows.length - 1][0],
      firstHour: hourRows.length === 0 ? null : hourRows[0][0],
      lastHour: hourRows.length === 0 ? null : hourRows[hourRows.length - 1][0],
      error: this.lastError,
    };
  }

  /**
   * Aggregate every cached record into the payload the Client renders.
   *
   * The aggregate is memoized: folding the corpus is the expensive half of a
   * panel open and the answer only changes when a scan changes the records or
   * `reprice` swaps the rules object. Each call still returns a fresh shallow
   * copy, so the route can attach its per-call fields without mutating what
   * the next caller receives.
   * @param scanInfo - the summary of the scan behind this snapshot.
   * @returns the wire document.
   */
  snapshot(scanInfo) {
    if (this.doc === null || this.docRules !== this.rules) {
      this.doc = this.buildSnapshot();
      this.docRules = this.rules;
    }
    return { ...this.doc, scan: scanInfo ?? null };
  }
}

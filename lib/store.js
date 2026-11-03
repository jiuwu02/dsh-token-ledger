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

/** Sessions read in parallel while scanning. */
export const READ_CONCURRENCY = 6;

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
export const CACHE_VERSION = 3;

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
      return true;
    });
    await mapLimit(pending, READ_CONCURRENCY, async (snapshot) => {
      const id = snapshot.header.id;
      let handle;
      try {
        handle = await persistence.open(id, "read");
        // A session that already has a fold is re-read from its first unfolded
        // event: the persistence handle indexes reads by event, and only the
        // tail can have changed. `read(offset)` returns exactly the events
        // past that point, so an unchanged prefix is never decoded into a
        // second fold. Any doubt — a forced pass, a zone change, a record from
        // an older cache shape — falls back to the full read below.
        const cached = this.records.get(id);
        const from =
          !force &&
          cached !== undefined &&
          cached.zone === timeZone &&
          Number.isInteger(cached.events) &&
          cached.events > 0
            ? cached.events
            : 0;
        const slice = await handle.read(from, Number.MAX_SAFE_INTEGER);
        const folded = foldEvents(slice.events, timeZone);
        const slots =
          from === 0 ? folded.slots : mergeSlots(cached.slots, folded.slots);
        this.records.set(id, {
          revision: snapshot.revision,
          zone: timeZone,
          createdAt: count(snapshot.header.createdAt),
          origin: snapshot.header.origin === "subagent" ? "subagent" : "main",
          cwd:
            typeof snapshot.header.cwd === "string" ? snapshot.header.cwd : "",
          parent:
            typeof snapshot.header.parentSession === "string"
              ? snapshot.header.parentSession
              : "",
          // The newest title wins, but only when the tail carried one: a
          // session that appended usage without renaming keeps its name.
          title: folded.title !== "" ? folded.title : (cached?.title ?? ""),
          slots,
          events: from + slice.events.length,
        });
        read += 1;
      } catch (error) {
        failed += 1;
        this.ctx.logger?.warn?.(
          `dsh-token-panorama: could not read session ${id}: ${String(error)}`,
        );
        const cached = this.records.get(id);
        if (cached === undefined) this.records.delete(id);
      } finally {
        if (handle !== undefined) {
          try {
            await handle.close();
          } catch {
            /* a read handle that refuses to close costs nothing here */
          }
        }
      }
    });
    for (const id of [...this.records.keys()])
      if (!seen.has(id)) this.records.delete(id);
    this.lastScanAt = Date.now();
    this.lastError = null;
    // Whatever this pass saw, the previous aggregate no longer describes it.
    this.doc = null;
    if (read > 0 || force) await this.save();
    return { sessions: seen.size, read, reused, failed, at: this.lastScanAt };
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

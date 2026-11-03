/**
 * Dynamic holiday calendars: fetched at runtime, cached on disk.
 *
 * Chinese statutory holidays and the make-up workdays that shift them are
 * published once a year for one year only, so no shipped dataset can cover
 * "any year". Instead this module keeps a per-year cache under the profile
 * home and fills it from public mirrors on demand: a year that is already
 * published is immutable and is fetched once, a year that is not published
 * yet is retried daily, and the bundled 2026 figures seed the cache so the
 * plugin bills correctly before the first fetch completes or offline.
 *
 * A source is accepted only when it agrees with the invariants this module
 * relies on — a make-up day is always a weekend, because that is what 调休
 * means — which keeps a source that returns every weekday from quietly
 * turning the whole calendar into make-up days.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

import { storageDirOf } from "./store.js";

/** Cache document schema version; a mismatch discards every cached year. */
export const HOLIDAY_CACHE_VERSION = 1;

/** An unpublished year is retried this often; a published one never is. */
export const HOLIDAY_RETRY_MS = 24 * 60 * 60 * 1000;

/** Per-source fetch budget, so one dead mirror cannot stall a panel load. */
const FETCH_TIMEOUT_MS = 8000;

/** Consecutive failed years before the pass gives up for this request. */
const MAX_SOURCE_FAILURES = 3;

/**
 * The bundled 2026 figures, used to seed the cache on first run.
 *
 * The dates live here rather than in the config because they are published
 * facts, not user choices: the user picks a calendar, not 33 individual days.
 * @property label - the name shown in the settings window.
 * @property days - the dates the calendar covers.
 */
export const HOLIDAY_SETS = {
  "cn-2026": {
    label: "China statutory holidays (2026)",
    days: [
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-02-15",
      "2026-02-16",
      "2026-02-17",
      "2026-02-18",
      "2026-02-19",
      "2026-02-20",
      "2026-02-21",
      "2026-02-22",
      "2026-02-23",
      "2026-04-04",
      "2026-04-05",
      "2026-04-06",
      "2026-05-01",
      "2026-05-02",
      "2026-05-03",
      "2026-05-04",
      "2026-05-05",
      "2026-06-19",
      "2026-06-20",
      "2026-06-21",
      "2026-09-25",
      "2026-09-26",
      "2026-09-27",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
    ],
  },
  "cn-2026-makeup": {
    label: "China make-up workdays (2026)",
    days: [
      "2026-01-04",
      "2026-02-14",
      "2026-02-28",
      "2026-04-26",
      "2026-05-09",
      "2026-09-20",
      "2026-10-10",
    ],
  },
};

/**
 * The calendar categories the settings window offers.
 *
 * A category spans every cached year, which is what makes the calendar adapt
 * to a new year without the user revisiting the settings: enabling `cn`
 * today keeps applying to 2027 the moment its dates land in the cache.
 */
export const HOLIDAY_CATEGORIES = [
  { key: "cn", label: "China statutory holidays" },
  { key: "cn-makeup", label: "China make-up workdays" },
];

/** The weekday a make-up day must fall on: 调休 always works a weekend. */
function isWeekend(date) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

/** `YYYY-MM-DD` for a `Date`, in UTC so the local zone cannot shift it. */
function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Normalize a holiday-cn payload.
 * @param payload - parsed JSON carrying `days: [{date, isOffDay}]`.
 * @returns the accepted day list, or null when the shape is unusable.
 */
function parseHolidayCn(payload) {
  if (!Array.isArray(payload?.days)) return null;
  const days = payload.days
    .filter((entry) => typeof entry?.date === "string")
    .map((entry) => ({
      date: entry.date,
      name: typeof entry.name === "string" ? entry.name : "",
      off: entry.isOffDay === true,
    }));
  return normalize(days);
}

/**
 * Normalize a timor.tech payload.
 * @param payload - parsed JSON carrying `holiday: {"MM-DD": {date, holiday}}`.
 * @returns the accepted day list, or null when the shape is unusable.
 */
function parseTimor(payload) {
  const table = payload?.holiday;
  if (table === undefined || table === null || typeof table !== "object")
    return null;
  const days = Object.values(table)
    .filter((entry) => typeof entry?.date === "string")
    .map((entry) => ({
      date: entry.date,
      name: typeof entry.name === "string" ? entry.name : "",
      off: entry.holiday === true,
    }));
  return normalize(days);
}

/**
 * Drop malformed dates, de-duplicate, and enforce the weekend invariant.
 * @param days - candidate day records.
 * @returns sorted, de-duplicated, validated days.
 */
function normalize(days) {
  const seen = new Map();
  for (const day of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date)) continue;
    // A make-up day works a weekend that would otherwise be free. Anything
    // else means the source returned ordinary weekdays, which would bill
    // every Monday as a make-up day.
    if (!day.off && !isWeekend(day.date)) continue;
    seen.set(day.date, day);
  }
  return [...seen.values()].sort((left, right) =>
    left.date < right.date ? -1 : left.date > right.date ? 1 : 0,
  );
}

/** The mirrors, tried in order; each parses its own payload shape. */
const SOURCES = [
  {
    name: "holiday-cn (jsDelivr)",
    url: (year) =>
      `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`,
    parse: parseHolidayCn,
  },
  {
    name: "holiday-cn (GitHub)",
    url: (year) =>
      `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`,
    parse: parseHolidayCn,
  },
  {
    name: "timor.tech",
    url: (year) => `https://timor.tech/api/holiday/year/${year}`,
    parse: parseTimor,
  },
];

/**
 * Read a year from one source, trying each mirror in turn.
 * @param year - the four-digit year to fetch.
 * @param log - optional warn sink for a source that failed outright.
 * @returns `{days}` on success, `{days: []}` when no source has the year yet,
 *   or null when every source failed (the year stays unknown, not empty).
 */
async function fetchYear(year, log) {
  let reachable = false;
  for (const source of SOURCES) {
    try {
      const response = await fetch(source.url(year), {
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        // A missing year file is an answer, not a failure: the mirror is up
        // and simply has nothing published for that year yet.
        if (response.status === 404) {
          reachable = true;
          continue;
        }
        throw new Error(`HTTP ${response.status}`);
      }
      const days = source.parse(await response.json());
      if (days === null) throw new Error("unrecognized payload");
      reachable = true;
      return { days };
    } catch (error) {
      log?.(
        `dsh-token-panorama: holiday source ${source.name} failed for ${year}: ${String(error)}`,
      );
    }
  }
  return reachable ? { days: [] } : null;
}

/**
 * Seed the cache from the bundled figures, keyed by year.
 * @returns `{year: [{date, name, off}]}`.
 */
function seedYears() {
  const years = {};
  for (const [key, set] of Object.entries(HOLIDAY_SETS)) {
    const year = key.match(/^cn-(\d{4})/)?.[1];
    if (year === undefined) continue;
    const off = key.endsWith("-makeup") ? false : true;
    for (const date of set.days) {
      (years[year] ??= []).push({
        date,
        name: set.label,
        off,
      });
    }
  }
  for (const days of Object.values(years))
    days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return years;
}

/**
 * The per-year holiday cache, shared by the pricing pass and the settings
 * window.
 *
 * Reads are synchronous (`sets`, `years`) because the pricing pass runs inside
 * a snapshot; only `ensure` touches the network, and it is called from the
 * request handlers before that snapshot is built.
 */
export class HolidayStore {
  /** @param ctx - host plugin context, used for storage path and logging. */
  constructor(ctx) {
    this.ctx = ctx;
    this.path = `${storageDirOf(ctx)}/holidays.json`;
    // Seeded synchronously so the first pricing pass, which runs before any
    // await can resolve, already bills against real dates instead of an empty
    // calendar. `load` replaces this with the on-disk cache when there is one.
    const now = Date.now();
    this.years = {};
    for (const [year, days] of Object.entries(seedYears()))
      this.years[year] = { fetchedAt: now, days };
    this.loaded = false;
    this.fetching = null;
  }

  /** Read the cache once; seed it from the bundled figures when empty. */
  async load() {
    if (this.loaded) return;
    this.loaded = true;
    let parsed;
    try {
      parsed = JSON.parse(await readFile(this.path, "utf8"));
    } catch {
      parsed = undefined;
    }
    if (
      parsed?.version === HOLIDAY_CACHE_VERSION &&
      typeof parsed.years === "object" &&
      parsed.years !== null
    ) {
      this.years = parsed.years;
      return;
    }
    await this.save();
  }

  /** Persist the cache atomically; a failure never breaks pricing. */
  async save() {
    const body = `${JSON.stringify({ version: HOLIDAY_CACHE_VERSION, years: this.years })}\n`;
    try {
      await mkdir(storageDirOf(this.ctx), { recursive: true });
      const staged = `${this.path}.tmp`;
      await writeFile(staged, body, "utf8");
      await rename(staged, this.path);
    } catch (error) {
      this.ctx.logger?.warn?.(
        `dsh-token-panorama: could not persist the holiday cache: ${String(error)}`,
      );
    }
  }

  /**
   * The cached years, newest first.
   * @returns `[{year, days, fetchedAt, published}]`.
   */
  yearList() {
    return Object.entries(this.years)
      .map(([year, entry]) => ({
        year,
        days: Array.isArray(entry?.days) ? entry.days.length : 0,
        fetchedAt: typeof entry?.fetchedAt === "number" ? entry.fetchedAt : 0,
        published: (entry?.days?.length ?? 0) > 0,
      }))
      .sort((left, right) => (left.year < right.year ? 1 : -1));
  }

  /**
   * Every cached date, split by category.
   * @returns `{holidays: Set, makeupDays: Set}` over all cached years.
   */
  sets() {
    const holidays = new Set();
    const makeupDays = new Set();
    for (const entry of Object.values(this.years)) {
      for (const day of entry?.days ?? []) {
        if (day?.off === true) holidays.add(day.date);
        else if (day?.off === false) makeupDays.add(day.date);
      }
    }
    return { holidays, makeupDays };
  }

  /**
   * The category rows the settings window renders, with per-year counts.
   * @returns `[{key, label, days, years: [{year, days}]}]`.
   */
  catalog() {
    const { holidays, makeupDays } = this.sets();
    const years = this.yearList().filter((entry) => entry.published);
    return HOLIDAY_CATEGORIES.map((category) => {
      const total =
        category.key === "cn-makeup" ? makeupDays.size : holidays.size;
      return {
        ...category,
        days: total,
        years: years.map((entry) => ({
          year: entry.year,
          days: this.yearDays(entry.year, category.key).length,
        })),
      };
    });
  }

  /**
   * One category's dates for one year.
   * @param year - the four-digit year.
   * @param category - `cn` or `cn-makeup`.
   * @returns the sorted date strings.
   */
  yearDays(year, category) {
    const days = this.years[year]?.days;
    if (!Array.isArray(days)) return [];
    const wantOff = category !== "cn-makeup";
    return days.filter((day) => day?.off === wantOff).map((day) => day.date);
  }

  /**
   * Fill any year the usage corpus spans that the cache does not hold yet.
   *
   * Concurrent callers share one pass, and a year that is already published is
   * never re-fetched, so this costs nothing once the cache is warm.
   * @param years - the four-digit years the data needs.
   * @param force - re-fetch even published years.
   * @returns true when the cache changed.
   */
  async ensure(years, force = false) {
    await this.load();
    const wanted = [...new Set(years)]
      .filter((year) => /^\d{4}$/.test(year))
      .sort();
    const now = Date.now();
    const pending = wanted.filter((year) => {
      const entry = this.years[year];
      if (entry === undefined) return true;
      if (force) return true;
      const fetchedAt =
        typeof entry.fetchedAt === "number" ? entry.fetchedAt : 0;
      // Published years are immutable, so only an unpublished one (or one
      // whose fetch never landed) is worth another request.
      return (
        (entry.days?.length ?? 0) === 0 && now - fetchedAt >= HOLIDAY_RETRY_MS
      );
    });
    if (pending.length === 0) return false;
    if (this.fetching !== null) await this.fetching;
    const run = (async () => {
      let changed = false;
      let failures = 0;
      for (const year of pending) {
        if (failures >= MAX_SOURCE_FAILURES) break;
        const result = await fetchYear(year, (line) =>
          this.ctx.logger?.warn?.(line),
        );
        if (result === null) {
          failures += 1;
          continue;
        }
        // An empty answer is recorded too, so an unpublished year is retried
        // tomorrow rather than on every panel load.
        this.years[year] = { fetchedAt: Date.now(), days: result.days };
        changed = true;
      }
      if (changed) await this.save();
      return changed;
    })();
    this.fetching = run.finally(() => {
      this.fetching = null;
    });
    return this.fetching;
  }
}

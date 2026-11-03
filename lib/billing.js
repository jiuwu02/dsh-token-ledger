/**
 * Billing: which hour is peak, what a slot costs, and the migrations that keep
 * an older config file usable after the shape changed.
 */

import { PRICE_UNIT, count } from "./time.js";
import { Price } from "./schema.js";

/**
 * The calendar categories a config may enable.
 *
 * A category spans every cached year, so the same key keeps working when the
 * next year's dates arrive. The pre-dynamic per-year keys (`cn-2026`) are
 * accepted on read and folded into their category, so an upgraded profile
 * keeps recognising the same holidays without being rewritten.
 */
const CATEGORY_KEYS = new Set(["cn", "cn-makeup"]);

/** Per-year keys written by earlier versions, mapped to their category. */
const LEGACY_KEY = /^cn-(\d{4})(-makeup)?$/;

/**
 * Minutes since midnight for one `HH:MM` value that the schema already
 * validated.
 * @param clock - text such as `09:30`.
 * @returns the minute count.
 */
function minutesOf(clock) {
  return Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
}

/**
 * Whether one calendar day counts as a statutory holiday or make-up workday,
 * given the calendars the user enabled.
 * @param day - `YYYY-MM-DD`.
 * @param rules - the resolved billing rules.
 * @returns "holiday", "workday", or "" when no calendar covers the day.
 */
function dayKind(day, rules) {
  if (rules.holidays.has(day)) return "holiday";
  if (rules.makeupDays.has(day)) return "workday";
  return "";
}

/**
 * Whether one peak profile applies to a calendar day.
 *
 * The mode decides the day set; the `off` list is what lets one profile cover
 * both an alarm-clock-style schedule and the holiday calendar: a `workday`
 * profile skips statutory holidays, a `holiday` profile runs only on them, and
 * the two together describe a provider that prices both bands on those days.
 * @param day - `YYYY-MM-DD`.
 * @param profile - the peak profile.
 * @param rules - the resolved billing rules.
 * @returns true when the profile covers that day.
 */
function appliesOn(day, profile, rules) {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  const isoWeekday = weekday === 0 ? 7 : weekday;
  const kind = dayKind(day, rules);
  if (profile.mode === "everyday") return true;
  if (profile.mode === "weekdays") return isoWeekday >= 1 && isoWeekday <= 5;
  if (profile.mode === "custom")
    return (profile.weekdays ?? []).includes(isoWeekday);
  if (profile.mode === "workday") return kind !== "holiday";
  // DeepSeek's published band: Monday through Friday, but not on a statutory
  // holiday. Neither half alone is the rule — a weekday list bills a holiday
  // Tuesday at peak and `workday` bills an ordinary Saturday at peak — so the
  // mode that names it joins both tests.
  if (profile.mode === "workweek")
    return kind !== "holiday" && isoWeekday >= 1 && isoWeekday <= 5;
  if (profile.mode === "holiday") return kind === "holiday";
  return false;
}

/**
 * Whether one slot bills at the peak rate under one profile.
 *
 * A window whose end is not after its start wraps midnight, so `22:00`–`02:00`
 * works as one entry.
 * @param hour - the slot key, `YYYY-MM-DDTHH`.
 * @param profile - the profile the model follows, or undefined for flat pricing.
 * @param rules - the resolved billing rules.
 * @returns true when the slot lies inside the profile's window on a covered day.
 */
export function isPeak(hour, profile, rules) {
  if (profile === undefined || profile === null) return false;
  const day = hour.slice(0, 10);
  if (!appliesOn(day, profile, rules)) return false;
  const minute = Number(hour.slice(11, 13)) * 60;
  for (const window of profile.windows ?? []) {
    const start = minutesOf(window.start);
    const end = minutesOf(window.end);
    const inside =
      end > start
        ? minute >= start && minute < end
        : minute >= start || minute < end;
    if (inside) return true;
  }
  return false;
}

/**
 * Normalize the validated config into the shape the pricing pass reads.
 *
 * The enabled holiday categories are resolved against the fetched cache here,
 * so the pricing pass never has to think about calendar keys again.
 * @param config - the validated plugin config.
 * @param catalog - the fetched holiday days, split by category.
 * @returns lookup sets, the profile table, and the price sheet.
 */
export function billingRules(config, catalog) {
  const { holidays, makeupDays } =
    catalog === undefined
      ? { holidays: new Set(), makeupDays: new Set() }
      : catalog;
  const enabled = new Set(migrateCalendars(config, { holidays, makeupDays }));
  const keep = {
    holidays: enabled.has("cn") ? new Set(holidays) : new Set(),
    makeupDays: enabled.has("cn-makeup") ? new Set(makeupDays) : new Set(),
  };
  const peakProfiles = migrateProfiles(config);
  const models = {};
  for (const [model, row] of Object.entries(config.models ?? {}))
    models[model] = migratePriceRow(row);
  return {
    timeZone: config.timeZone,
    currency: config.currency,
    peakProfiles,
    holidays: keep.holidays,
    makeupDays: keep.makeupDays,
    models,
    defaultPrice: migratePriceRow(config.defaultPrice),
  };
}

/**
 * The enabled holiday categories, accepting any config generation.
 *
 * Three shapes are recognised, newest first: category keys (`cn`), the
 * per-year keys earlier versions wrote (`cn-2026`), and the oldest shape that
 * listed individual dates. Dates are folded into whichever category they
 * belong to, so an upgraded profile keeps recognising the same holidays
 * without a rewrite; an empty selection stays empty rather than falling back
 * to a calendar the user may have deliberately turned off.
 * @param config - the validated plugin config.
 * @param catalog - the fetched holiday days, used to classify bare dates.
 * @returns category keys.
 */
export function migrateCalendars(config, catalog) {
  const entries = (config.holidays ?? []).filter(
    (entry) => typeof entry === "string",
  );
  const categories = new Set(
    entries.filter((entry) => CATEGORY_KEYS.has(entry)),
  );
  if (categories.size > 0) return [...categories];
  const legacy = entries
    .map((entry) => entry.match(LEGACY_KEY))
    .filter(Boolean);
  if (legacy.length > 0) {
    for (const match of legacy)
      categories.add(match[2] === undefined ? "cn" : "cn-makeup");
    return [...categories];
  }
  const dates = new Set(entries);
  if (dates.size === 0) return [];
  // The oldest shape listed bare dates. Which category each one belongs to is
  // answered by the fetched cache when it is available; without it there is
  // nothing to match against, so the statutory calendar is the safe reading
  // of a date the user recorded by hand.
  if (catalog === undefined) return ["cn"];
  for (const day of catalog.holidays) if (dates.has(day)) categories.add("cn");
  for (const day of catalog.makeupDays)
    if (dates.has(day)) categories.add("cn-makeup");
  return categories.size > 0 ? [...categories] : ["cn"];
}

/**
 * The named peak schedules, accepting either config generation.
 *
 * The old shape stored one flat `peakWindows` list shared by every model. That
 * becomes a single `standard` schedule — the same name the new models default
 * to — carrying those windows and the union of their weekdays.
 * @param config - the validated plugin config.
 * @returns the profile table.
 */
function migrateProfiles(config) {
  const named = {};
  for (const [name, profile] of Object.entries(config.peakProfiles ?? {}))
    named[name] = profile;
  if (Object.keys(named).length > 0) return named;
  const legacy = Array.isArray(config.peakWindows) ? config.peakWindows : [];
  if (legacy.length === 0) return named;
  const weekdays = new Set();
  const windows = [];
  for (const window of legacy) {
    if (window === null || typeof window !== "object") continue;
    windows.push({
      start: typeof window.start === "string" ? window.start : "09:00",
      end: typeof window.end === "string" ? window.end : "18:00",
    });
    for (const day of window.weekdays ?? [1, 2, 3, 4, 5])
      if (typeof day === "number") weekdays.add(day);
  }
  if (windows.length === 0) return named;
  const days = [...weekdays].sort((left, right) => left - right);
  named.standard = {
    mode:
      days.length === 5 && days.every((day, i) => day === i + 1)
        ? "weekdays"
        : "custom",
    windows,
    weekdays: days,
    offPeakRatio: 0.5,
  };
  return named;
}

/**
 * Accept a price row from any config shape.
 *
 * Three generations are recognised, newest first:
 *
 * 1. The current four-rate row (`input`/`cacheRead`/`cacheWrite`/`output`).
 * 2. The three-rate row (`input`/`output`/`cache`), whose cache-write rate was
 *    charged at the miss rate — that is what DeepSeek bills, so it migrates by
 *    copying `input` rather than asking the user to retype it.
 * 3. The pre-1.1 peak/off-peak pair (`hitPeak`/`missPeak`/`outPeak`), whose
 *    peak half is the listed rate the current shape stores.
 *
 * A row from an even older release (no price field at all) keeps
 * `undefined`, which reads as "not priced" rather than "priced at zero".
 * @param row - a price row from any shape, or undefined.
 * @returns a `{input, cacheRead, cacheWrite, output, peakProfile}` row.
 */
function migratePriceRow(row) {
  if (row === null || typeof row !== "object") return undefined;
  if (typeof row.cacheRead === "number" || typeof row.cacheWrite === "number")
    return row;
  if (typeof row.input === "number" || typeof row.output === "number") {
    // The three-rate shape: its `cache` is the cache-read rate, and a cache
    // write was billed at the miss rate — the only rule that shape expressed.
    const miss = typeof row.input === "number" ? row.input : 0;
    return {
      input: miss,
      cacheRead: typeof row.cache === "number" ? row.cache : 0,
      cacheWrite: miss,
      output: typeof row.output === "number" ? row.output : 0,
      peakProfile: typeof row.peakProfile === "string" ? row.peakProfile : "",
    };
  }
  const legacy =
    row.missPeak !== undefined ||
    row.hitPeak !== undefined ||
    row.outPeak !== undefined;
  if (!legacy) return row;
  const hasOffPeak =
    (row.missOffPeak !== undefined && row.missOffPeak !== row.missPeak) ||
    (row.hitOffPeak !== undefined && row.hitOffPeak !== row.hitPeak) ||
    (row.outOffPeak !== undefined && row.outOffPeak !== row.outPeak);
  const miss = count(row.missPeak);
  return {
    input: miss,
    cacheRead: typeof row.hitPeak === "number" ? row.hitPeak : 0,
    cacheWrite: miss,
    output: count(row.outPeak),
    peakProfile:
      typeof row.peakProfile === "string" && row.peakProfile !== ""
        ? row.peakProfile
        : hasOffPeak
          ? "standard"
          : "",
  };
}

/**
 * The price row one model bills at.
 * @param model - the model name carried by the log.
 * @param rules - the resolved billing rules.
 * @returns the model config row.
 */
export function priceOf(model, rules) {
  return rules.models?.[model] ?? rules.defaultPrice;
}

/**
 * The peak profile one model follows.
 *
 * A row may name a schedule that no longer exists — deleting a schedule in the
 * settings window leaves its references behind until the models are re-pointed.
 * Treating that as "no schedule" is the safe reading: the model then bills at
 * the peak price for every hour, which is what it costs before any discount.
 * Silently applying the off-peak ratio instead would under-report the bill.
 * @param row - the model config row.
 * @param rules - the resolved billing rules.
 * @returns the profile, or undefined when the model bills flat at peak price.
 */
export function profileOf(row, rules) {
  const key = row?.peakProfile;
  if (typeof key !== "string" || key === "") return undefined;
  return rules.peakProfiles?.[key];
}

/**
 * Price one slot row.
 *
 * The four counters are priced at their own rate: a cache read is not a
 * discounted miss, and a cache write is not a miss either — Anthropic charges
 * 1.25× for it while DeepSeek charges nothing extra. A provider that bills a
 * cache write at the miss rate therefore expresses that in its config row
 * (`cacheWrite` equal to `input`), not in this function.
 *
 * A model with a peak profile bills its off-peak band by scaling every listed
 * price with the profile's `offPeakRatio`, so one number per model stays the
 * single source of truth: changing the ratio re-prices every band at once.
 * @param slot - `[hour, model, input, output, cacheRead, cacheWrite, …]`.
 * @param peak - whether this slot bills at the peak rate.
 * @param rules - the resolved billing rules.
 * @returns the slot's cost in the configured currency.
 */
export function slotCost(slot, peak, rules) {
  const row = priceOf(slot[1], rules);
  const profile = profileOf(row, rules);
  const ratio =
    peak || profile === undefined ? 1 : (profile.offPeakRatio ?? 0.5);
  // Prices are money, not token counts: rounding them with `count` would turn
  // a cache price of 0.04 into 0 and silently drop the whole cache line.
  const amount = (value) =>
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : 0;
  const miss = amount(row?.input) * ratio;
  const hit = amount(row?.cacheRead) * ratio;
  const write = amount(row?.cacheWrite) * ratio;
  const out = amount(row?.output) * ratio;
  return (
    (slot[2] * miss + slot[4] * hit + slot[5] * write + slot[3] * out) /
    PRICE_UNIT
  );
}

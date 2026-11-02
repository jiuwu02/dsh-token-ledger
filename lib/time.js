/**
 * Wall-clock arithmetic for the configured IANA zone, plus the small numeric
 * helpers every other module needs.
 *
 * Usage is recorded by UTC instant but billed by local hour, so every
 * aggregation needs the same answer to "what time is it for the user". These
 * helpers answer it once and cache each zone's offset per hour bucket.
 */

/** Milliseconds in one hour; the slot width. */
export const HOUR_MS = 3_600_000;

/** Divisors used when pricing; provider prices are quoted per this many tokens. */
export const PRICE_UNIT = 1_000_000;

/**
 * Cache of the zone offset, keyed by the hour. A zone that observes daylight
 * saving changes offset at an hour boundary, so every instant inside one hour
 * bucket shares an answer that is exact for it.
 */
const offsetCache = new Map();

/**
 * The offset, in milliseconds, that `timeZone` was at on `time`, such that
 * `time + offset` has UTC fields equal to that zone's wall clock.
 * @param time - epoch milliseconds.
 * @param timeZone - IANA zone name.
 * @returns the offset in milliseconds.
 */
function zoneOffset(time, timeZone) {
  const bucket = Math.floor(time / HOUR_MS);
  const key = `${timeZone}|${bucket}`;
  const cached = offsetCache.get(key);
  if (cached !== undefined) return cached;
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    offsetCache.set(key, 0);
    return 0;
  }
  const parts = formatter.formatToParts(new Date(time));
  const read = (type) =>
    Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    read("hour") % 24,
    read("minute"),
    read("second"),
  );
  const offset = asUtc - (time - (time % 1000));
  offsetCache.set(key, offset);
  return offset;
}

/**
 * The wall-clock fields of one instant in a zone.
 * @param time - epoch milliseconds.
 * @param timeZone - IANA zone name.
 * @returns year, month (1-12), day, hour, and ISO weekday (1 = Monday).
 */
export function wallClock(time, timeZone) {
  const shifted = new Date(time + zoneOffset(time, timeZone));
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  return {
    year,
    month,
    day,
    hour: shifted.getUTCHours(),
    weekday: shifted.getUTCDay() === 0 ? 7 : shifted.getUTCDay(),
  };
}

/**
 * Zero-padded two-digit text.
 * @param value - a non-negative integer.
 * @returns the padded text.
 */
export function pad2(value) {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * The hourly slot key one instant belongs to.
 * @param time - epoch milliseconds.
 * @param timeZone - IANA zone name.
 * @returns `YYYY-MM-DDTHH` in that zone.
 */
export function hourKey(time, timeZone) {
  const clock = wallClock(time, timeZone);
  return `${clock.year}-${pad2(clock.month)}-${pad2(clock.day)}T${pad2(clock.hour)}`;
}

/**
 * Coerce one usage counter.
 * @param value - an untrusted field from a stored event.
 * @returns the finite non-negative integer, or 0.
 */
export function count(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}

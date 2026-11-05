/**
 * The durable usage fold, contributed to the Host's projection registry.
 *
 * The panel's cache can be thrown away — a version bump, a corrupt file, a
 * deleted profile — and rebuilding it means inflating every stored log. The
 * Host already runs a registry that folds every committed session event once,
 * while the events are still in memory, and a companion service persists those
 * states to disk. Contributing the same fold here makes the work survive the
 * panel's own cache: a scan can seed from a session's stored projection and
 * only read the frames appended after its watermark, and a session the Host
 * has just written needs no log read at all.
 *
 * The unit's state is deliberately the panel's own slot shape rather than a
 * second model of the same numbers: one definition of billable usage means a
 * seeded fold and a freshly folded one can never disagree about what a row
 * means.
 */

import { count } from "./time.js";

/**
 * The registry key this plugin owns.
 *
 * Named for the plugin rather than for "usage" so it cannot be confused with
 * the token meter's own totals unit, which folds the same events into a
 * different shape.
 */
export const USAGE_PROJECTION_KEY = "tokenPanoramaUsage";

/**
 * The unit's state version.
 *
 * Bumping this invalidates every stored row, which forces a full refold on the
 * next scan — exactly the re-read a changed fold definition requires.
 */
export const USAGE_STATE_VERSION = 1;

/**
 * The empty state: no title, no rows, and the zone the hours are keyed in.
 *
 * The zone travels with the state because a row is only usable by a fold that
 * buckets hours the same way: the same event lands in one hour under UTC and
 * in another under a zone that is not a whole number of hours away.
 * @param zone - the IANA zone the hour keys are bucketed in.
 * @returns a fresh state object.
 */
export function emptyState(zone) {
  return { zone: typeof zone === "string" ? zone : "", title: "", rows: [] };
}

/**
 * Fold one event into the state.
 *
 * The same reference is returned for every event that does not carry usage or
 * a title, so an unrelated event costs one type comparison. Relevant events
 * mutate the state in place: nothing reads this key through the change feed,
 * and avoiding a copy per usage event is what keeps the fold cheap enough to
 * run on every committed event of every session.
 * @param state - the current state.
 * @param event - the committed session event.
 * @param bucketAt - the hour bucketing function for this fold's zone.
 * @returns the state.
 */
export function applyEvent(state, event, bucketAt) {
  if (event === null || typeof event !== "object") return state;
  if (event.type === "session/title") {
    const text = event.data?.title;
    if (typeof text === "string" && text !== "" && text !== state.title)
      state.title = text;
    return state;
  }
  if (event.type !== "assistant/message") return state;
  const usage = event.data?.usage;
  if (usage === undefined || usage === null) return state;
  const hour = bucketAt(typeof event.time === "number" ? event.time : Date.now());
  if (typeof hour !== "string" || hour === "") return state;
  const model = modelOf(event);
  let row;
  for (const candidate of state.rows)
    if (candidate[0] === hour && candidate[1] === model) {
      row = candidate;
      break;
    }
  if (row === undefined) {
    row = [hour, model, 0, 0, 0, 0, 0, 0];
    state.rows.push(row);
  }
  const input = count(usage.inputTokens);
  const output = count(usage.outputTokens);
  const cacheRead = count(usage.cacheReadTokens);
  const cacheWrite = count(usage.cacheWriteTokens);
  row[2] += input;
  row[3] += output;
  row[4] += cacheRead;
  row[5] += cacheWrite;
  row[6] += count(usage.totalTokens) || input + output + cacheRead + cacheWrite;
  row[7] += 1;
  return state;
}

/**
 * The model a usage event was billed to.
 * @param event - an assistant message event.
 * @returns the model name, or "unknown".
 */
function modelOf(event) {
  const model = event.data?.message?.source?.model;
  return typeof model === "string" && model !== "" ? model : "unknown";
}

/**
 * Convert a stored state into slot rows, in the order a fresh fold produces.
 *
 * Rows are validated rather than trusted: a stored row is a structured clone of
 * a previous fold, but a damaged document must degrade to "that row is
 * dropped", never to a NaN in the panel's totals.
 * @param state - a state read back from the projection cache.
 * @returns the slot rows.
 */
export function slotsOf(state) {
  const rows = state?.rows;
  if (!Array.isArray(rows)) return [];
  const slots = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 8) continue;
    const [hour, model] = row;
    if (typeof hour !== "string" || typeof model !== "string") continue;
    const numbers = row.slice(2, 8);
    if (!numbers.every((value) => Number.isFinite(value))) continue;
    slots.push([hour, model, ...numbers]);
  }
  return slots.sort(compareSlots);
}

/**
 * Order slot rows the way a fold reports them: by hour, then by model.
 * @param left - one slot row.
 * @param right - another slot row.
 * @returns the sort order.
 */
function compareSlots(left, right) {
  if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1;
  if (left[1] === right[1]) return 0;
  return left[1] < right[1] ? -1 : 1;
}

/**
 * The state a stored document decodes to, or undefined when it is unusable.
 * @param value - the value served for this key.
 * @returns a state, or undefined.
 */
export function stateOf(value) {
  if (value === null || typeof value !== "object") return undefined;
  if (!Array.isArray(value.rows)) return undefined;
  return {
    zone: typeof value.zone === "string" ? value.zone : "",
    title: typeof value.title === "string" ? value.title : "",
    rows: value.rows,
  };
}

/**
 * Build the projection definition the registry registers.
 *
 * The zone is captured rather than read per event: a slot's hour depends on the
 * user's display zone, and a fold that straddled a zone change would put one
 * event's tokens in one hour bucket and the next event's in another. A zone
 * change therefore leaves the stored rows keyed to the old one, which is why
 * the state carries it — a reader can see the mismatch and refold instead of
 * billing the same hour twice under two clocks.
 * @param options - the fold's fixed inputs.
 * @param options.timeZone - the zone that decides slot boundaries.
 * @param options.hourKey - the hour bucketing function.
 * @param options.schema - the schema the registry validates its rows with.
 * @returns the definition.
 */
export function usageProjection({ timeZone, hourKey, schema }) {
  return {
    key: USAGE_PROJECTION_KEY,
    stateVersion: USAGE_STATE_VERSION,
    stateSchema: schema,
    init: () => emptyState(timeZone),
    apply: (state, event) =>
      applyEvent(state, event, (time) => hourKey(time, timeZone)),
    wire: {
      viewSchema: schema,
      // The stored state IS the view: the panel's reader wants the rows, not a
      // second rendering of them.
      view: (state) => state,
    },
  };
}

/**
 * Folding a session's event log into billable slots.
 *
 * One slot per local hour per model: a provider's peak bands start and end on
 * the hour, so an hourly slot lies entirely inside one price band and the
 * peak/off-peak split is exact rather than estimated.
 */

import { count, hourKey } from "./time.js";

/**
 * Fold one session's events into hourly, per-model slots plus the session's own
 * title. A slot row is `[hourKey, model, input, output, cacheRead, cacheWrite,
 * total, calls]`; every later dimension (day, model, price band) is derived
 * from those rows, so the cache stores each event exactly once.
 * The last sequence number seen is reported alongside the rows: an incremental
 * pass resumes the log from the frame that carries it, and only the fold itself
 * knows how far the events it was handed actually reached.
 * @param events - the session's committed event log.
 * @param timeZone - the zone that decides the slot boundary.
 * @returns the slot rows, the session's latest title, and the highest sequence
 *   number folded (-1 when the slice carried none).
 */
export function foldEvents(events, timeZone) {
  const slots = new Map();
  let title = "";
  let lastSeq = -1;
  for (const event of events) {
    if (typeof event?.seq === "number" && event.seq > lastSeq)
      lastSeq = event.seq;
    if (event?.type === "session/title") {
      const text = event.data?.title;
      if (typeof text === "string" && text !== "") title = text;
      continue;
    }
    if (event?.type !== "assistant/message") continue;
    const usage = event.data?.usage;
    if (usage === undefined || usage === null) continue;
    const hour = hourKey(
      typeof event.time === "number" ? event.time : Date.now(),
      timeZone,
    );
    const model = event.data?.message?.source?.model;
    const modelName =
      typeof model === "string" && model !== "" ? model : "unknown";
    const key = `${hour}|${modelName}`;
    let slot = slots.get(key);
    if (slot === undefined) {
      slot = [hour, modelName, 0, 0, 0, 0, 0, 0];
      slots.set(key, slot);
    }
    const input = count(usage.inputTokens);
    const output = count(usage.outputTokens);
    const cacheRead = count(usage.cacheReadTokens);
    const cacheWrite = count(usage.cacheWriteTokens);
    slot[2] += input;
    slot[3] += output;
    slot[4] += cacheRead;
    slot[5] += cacheWrite;
    slot[6] +=
      count(usage.totalTokens) || input + output + cacheRead + cacheWrite;
    slot[7] += 1;
  }
  return {
    title,
    lastSeq,
    slots: [...slots.values()].sort((left, right) =>
      left[0] === right[0]
        ? left[1] < right[1]
          ? -1
          : 1
        : left[0] < right[0]
          ? -1
          : 1,
    ),
  };
}

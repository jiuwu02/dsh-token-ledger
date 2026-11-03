/**
 * The tool self-consumption ledger: what the plugin's own LLM calls cost.
 *
 * Compaction and prompt optimization are direct LLM calls whose tokens never
 * appear in any session log, so without this ledger the panorama would show a
 * bill that is quietly missing a line. Every call appends one JSONL record to
 * the plugin storage directory, and the summary route folds the ledger into
 * the snapshot as a separately labelled source — the two sources are shown
 * side by side rather than silently merged into the session totals.
 *
 * Appends are fire-and-forget by design: an accounting write must never fail
 * the operation it is accounting for. Reads happen on snapshot builds only.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { storageDirOf } from "./store.js";
import { isPeak, priceOf, profileOf, slotCost } from "./billing.js";
import { count, hourKey, pad2, wallClock } from "./time.js";

/** File the ledger appends to, one JSON object per line. */
export const TOOL_USAGE_FILE = "tool-usage.jsonl";

/**
 * Pull a usage record out of one stream chunk, tolerantly.
 *
 * The stream protocol promises a `usage` chunk before the terminal `finish`
 * but no shape is fixed across adapters, so this probes the field names a
 * provider might carry instead of trusting one of them. That is also the
 * compatibility probe this plugin needs against SDK changes: a chunk that
 * matches nothing reports `null` and the caller falls back to an estimate
 * it labels as one, rather than recording a confident zero.
 * @param chunk - one chunk from `llm.stream`.
 * @returns the four token counts found, or null when none were.
 */
export function usageFromChunk(chunk) {
  if (chunk === undefined || chunk === null || typeof chunk !== "object")
    return null;
  const source =
    typeof chunk.usage === "object" && chunk.usage !== null
      ? chunk.usage
      : chunk;
  const pick = (...names) => {
    for (const name of names) {
      const value = source[name];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0)
        return value;
    }
    return 0;
  };
  const input = pick("inputTokens", "promptTokens", "input", "prompt");
  const output = pick(
    "outputTokens",
    "completionTokens",
    "output",
    "completion",
  );
  const cacheRead = pick(
    "cacheReadInputTokens",
    "cachedTokens",
    "cachedInputTokens",
    "cacheReadTokens",
    "cacheRead",
  );
  const cacheWrite = pick(
    "cacheCreationInputTokens",
    "cacheWriteInputTokens",
    "cacheWriteTokens",
    "cacheWrite",
  );
  if (input + output + cacheRead + cacheWrite === 0) return null;
  return { input, output, cacheRead, cacheWrite };
}

/**
 * Append one ledger record. Never throws: this runs after the money is
 * already spent, and a failure here must not turn a successful compaction
 * into an error the user sees.
 * @param ctx - host plugin context, for the storage directory and logger.
 * @param entry - the record; `kind` distinguishes usage from surface rows.
 * @returns whether the record landed.
 */
export async function appendLedger(ctx, entry) {
  try {
    const dir = storageDirOf(ctx);
    await mkdir(dir, { recursive: true });
    await appendFile(
      join(dir, TOOL_USAGE_FILE),
      `${JSON.stringify({ at: Date.now(), ...entry })}\n`,
      "utf8",
    );
    return true;
  } catch (error) {
    ctx.logger?.warn?.(
      `dsh-token-panorama: could not append the tool ledger: ${String(error)}`,
    );
    return false;
  }
}

/**
 * Read every ledger record. A missing or unreadable file reads as empty, and
 * one unparseable line is skipped rather than failing the snapshot.
 * @param ctx - host plugin context.
 * @returns the records, oldest first.
 */
export async function readLedger(ctx) {
  let text;
  try {
    text = await readFile(join(storageDirOf(ctx), TOOL_USAGE_FILE), "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry = JSON.parse(line);
      if (typeof entry === "object" && entry !== null) entries.push(entry);
    } catch {
      /* one torn line costs one record, not the whole ledger */
    }
  }
  return entries;
}

/**
 * Price one ledger usage record the same way session slots are priced, so a
 * tool call and a conversation call cost the same money for the same tokens.
 * @param entry - a usage ledger record.
 * @param rules - the resolved billing rules.
 * @returns the cost in the configured currency.
 */
function usageCost(entry, rules) {
  const at = typeof entry.at === "number" ? entry.at : Date.now();
  const hour = hourKey(at, rules.timeZone);
  const row = priceOf(entry.model, rules);
  const profile = profileOf(row, rules);
  const peak = profile === undefined || isPeak(hour, profile, rules);
  const slot = [
    hour,
    entry.model,
    count(entry.input),
    count(entry.output),
    count(entry.cacheRead),
    count(entry.cacheWrite),
    0,
    1,
  ];
  return slotCost(slot, peak, rules);
}

/**
 * Fold the ledger into the snapshot block the Client draws.
 *
 * The compaction figures answer one question — did compressing pay for
 * itself — so they are kept apart from the raw spend: `savedTokens` is the
 * history the rewrites removed and `consumedTokens` is what the summarizer
 * spent to remove it. Both sides of that ratio come from this ledger, and
 * the ratio is null rather than a divide-by-zero when nothing ran yet.
 * @param ctx - host plugin context.
 * @param rules - the resolved billing rules.
 * @returns the tool-usage block for the snapshot.
 */
export async function toolUsageSummary(ctx, rules) {
  const entries = await readLedger(ctx);
  const byPurpose = new Map();
  const byDay = new Map();
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let calls = 0;
  let estimatedCalls = 0;
  let cost = 0;
  const compaction = { ops: 0, beforeTokens: 0, afterTokens: 0 };
  const clear = { ops: 0, beforeTokens: 0, afterTokens: 0 };
  const purposeCost = new Map();
  const purposeTokens = new Map();

  for (const entry of entries) {
    if (entry.kind === "surface") {
      const target = entry.op === "clear" ? clear : compaction;
      target.ops += 1;
      target.beforeTokens += count(entry.beforeTokens);
      target.afterTokens += count(entry.afterTokens);
      continue;
    }
    if (entry.kind !== "usage") continue;
    const input = count(entry.input);
    const output = count(entry.output);
    const cacheRead = count(entry.cacheRead);
    const cacheWrite = count(entry.cacheWrite);
    const total = input + output + cacheRead + cacheWrite;
    const entryCost = usageCost(entry, rules);
    calls += 1;
    if (entry.estimated === true) estimatedCalls += 1;
    totals.input += input;
    totals.output += output;
    totals.cacheRead += cacheRead;
    totals.cacheWrite += cacheWrite;
    totals.total += total;
    cost += entryCost;
    const purpose =
      typeof entry.purpose === "string" && entry.purpose !== ""
        ? entry.purpose
        : "unknown";
    const ofPurpose = byPurpose.get(purpose) ?? {
      purpose,
      calls: 0,
      estimatedCalls: 0,
      total: 0,
    };
    ofPurpose.calls += 1;
    ofPurpose.estimatedCalls += entry.estimated === true ? 1 : 0;
    ofPurpose.total += total;
    byPurpose.set(purpose, ofPurpose);
    purposeCost.set(purpose, (purposeCost.get(purpose) ?? 0) + entryCost);
    purposeTokens.set(purpose, (purposeTokens.get(purpose) ?? 0) + total);

    const at = typeof entry.at === "number" ? entry.at : Date.now();
    const clock = wallClock(at, rules.timeZone);
    const day = `${clock.year}-${pad2(clock.month)}-${pad2(clock.day)}`;
    let row = byDay.get(day);
    if (row === undefined) {
      row = [day, 0, 0, 0, 0, 0, 0, 0];
      byDay.set(day, row);
    }
    row[1] += input;
    row[2] += output;
    row[3] += cacheRead;
    row[4] += cacheWrite;
    row[5] += total;
    row[6] += 1;
    row[7] += entryCost;
  }

  const savedTokens = compaction.beforeTokens - compaction.afterTokens;
  const compactionCost = purposeCost.get("compaction") ?? 0;
  const compactionTokens = purposeTokens.get("compaction") ?? 0;
  return {
    calls,
    estimatedCalls,
    ...totals,
    cost,
    currency: rules.currency,
    byPurpose: [...byPurpose.values()]
      .map((entry) => ({
        ...entry,
        cost: purposeCost.get(entry.purpose) ?? 0,
      }))
      .sort((left, right) => right.total - left.total),
    byDay: [...byDay.values()].sort((left, right) =>
      left[0] < right[0] ? -1 : 1,
    ),
    compaction: {
      ...compaction,
      savedTokens: savedTokens > 0 ? savedTokens : 0,
      consumedTokens: compactionTokens,
      cost: compactionCost,
      // The payoff ratio: tokens of history removed per token the
      // summarizer spent. Null until a compaction has run.
      savingsRatio:
        compactionTokens > 0 ? savedTokens / compactionTokens : null,
    },
    optimizer: {
      cost: purposeCost.get("prompt-optimizer") ?? 0,
      tokens: purposeTokens.get("prompt-optimizer") ?? 0,
      calls: byPurpose.get("prompt-optimizer")?.calls ?? 0,
    },
    clear: { ...clear, savedTokens: clear.beforeTokens - clear.afterTokens },
  };
}

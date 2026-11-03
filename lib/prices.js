/**
 * Built-in model price presets, filled from prices fetched off the network.
 *
 * Every row records where its numbers come from and when they were read,
 * because a price sheet is only true on the day it was published: the
 * settings window shows the data date beside each preset and asks the user
 * to re-check before trusting an old one. Nothing here is guessed — the
 * numbers were transcribed from the cited pages on `asOf`.
 *
 * Units are the same as the config sheet: price per 1M tokens, in the
 * currency named on each preset. `row` matches `ModelConfig` so applying a
 * preset is a plain assignment into the draft, re-validated by `Config` on
 * save like any hand-typed value.
 */

import { modelRow } from "./schema.js";

/** The day the built-in numbers were read off the cited pages. */
export const PRESETS_AS_OF = "2026-11-03";

/**
 * One price preset.
 * @typedef {object} PricePreset
 * @property {string} id - stable key the settings window selects on.
 * @property {string} provider - whose price list this came from.
 * @property {string[]} models - every config sheet key this row fills.
 * @property {string} label - what the picker shows.
 * @property {"CNY"|"USD"} currency - the currency the source lists.
 * @property {string} asOf - the day the numbers were fetched.
 * @property {string} source - the page the numbers were read from.
 * @property {string} note - caveats the picker shows beside the row.
 * @property {object} row - the `ModelConfig` row to write.
 * @property {object} [peakProfile] - peak schedule to ensure exists, keyed
 *   `peakProfileName`, when the source publishes one.
 * @property {string} [peakProfileName] - key of the schedule to ensure.
 */

/**
 * The DeepSeek peak schedule, expressed the way their docs define it.
 *
 * The footnote on the pricing page is exact: peak is Beijing-time Monday
 * through Friday, excluding Chinese statutory holidays, 09:00-12:00 and
 * 14:00-18:00; weekends and statutory holidays are off-peak all day. That is
 * the `workweek` mode — a plain weekday list would bill a holiday Tuesday at
 * peak, and the older `workday` mode bills an ordinary Saturday at peak.
 * The windows are wall-clock in the configured billing zone, so a zone other
 * than Asia/Shanghai has to shift them by hand; the preset says so.
 */
const DEEPSEEK_PEAK = {
  mode: "workweek",
  windows: [
    { start: "09:00", end: "12:00" },
    { start: "14:00", end: "18:00" },
  ],
  weekdays: [1, 2, 3, 4, 5],
  offPeakRatio: 0.5,
};

/**
 * The built-in price sheet.
 *
 * A cache write is billed the way each provider bills it, not by a shared
 * rule: DeepSeek and OpenAI charge a write at the miss rate, Anthropic at
 * 1.25x the input rate, Kimi at the input rate for the default 5-minute TTL
 * (a one-hour TTL doubles it), and MiMo waives it.
 * @type {PricePreset[]}
 */
export const PRICE_PRESETS = [
  {
    id: "deepseek-flash",
    provider: "DeepSeek",
    models: ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4.1-flash"],
    label: "DeepSeek deepseek-flash (V4.1-Flash)",
    currency: "CNY",
    asOf: PRESETS_AS_OF,
    source: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing",
    note: "官方中文价目（元/百万 tokens）取高峰价；空闲价=0.5x。缓存写入按未命中价计。旧名 deepseek-v4-flash 按 Flash 价计费。峰值窗口按北京时间，计费时区非 Asia/Shanghai 时请手动换算。",
    row: modelRow(2, 0.04, 2, 8, "deepseek-standard"),
    peakProfile: DEEPSEEK_PEAK,
    peakProfileName: "deepseek-standard",
  },
  {
    id: "deepseek-v4-pro",
    provider: "DeepSeek",
    models: ["deepseek-v4-pro", "deepseek-v4-pro-0813"],
    label: "DeepSeek deepseek-v4-pro (V4-Pro-0813)",
    currency: "CNY",
    asOf: PRESETS_AS_OF,
    source: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing",
    note: "官方中文价目取高峰价；空闲价=0.5x。缓存写入按未命中价计。峰值窗口按北京时间。",
    row: modelRow(9, 0.3, 9, 27, "deepseek-standard"),
    peakProfile: DEEPSEEK_PEAK,
    peakProfileName: "deepseek-standard",
  },
  {
    id: "kimi-k3.1-pro",
    provider: "Moonshot",
    models: ["kimi-k3.1-pro"],
    label: "Kimi kimi-k3.1-pro",
    currency: "CNY",
    asOf: PRESETS_AS_OF,
    source: "https://platform.moonshot.cn/docs/pricing/chat",
    note: "官方价目（元/百万 tokens）；缓存写入按默认 5min TTL 档计，1h TTL 档为 26 元；无峰谷差价。",
    row: modelRow(13, 1.3, 13, 68, ""),
  },
  {
    id: "kimi-k3",
    provider: "Moonshot",
    models: ["kimi-k3"],
    label: "Kimi kimi-k3",
    currency: "CNY",
    asOf: PRESETS_AS_OF,
    source: "https://platform.moonshot.cn/docs/pricing/chat",
    note: "官方价目（元/百万 tokens）；缓存写入按默认 5min TTL 档计，1h TTL 档为 40 元；无峰谷差价。",
    row: modelRow(20, 2, 20, 100, ""),
  },
  {
    id: "mimo-v2.6-flash",
    provider: "Xiaomi",
    models: ["mimo-v2.6-flash"],
    label: "Xiaomi MiMo mimo-v2.6-flash",
    currency: "CNY",
    asOf: PRESETS_AS_OF,
    source: "https://apicostcheck.com/providers/xiaomi_mimo/",
    note: "官方渠道未直接公布文本价目；LiteLLM 数据（$0.14/$0.28，2026-11-03 同步）按汇率折算与该元价一致。缓存写入免费。请以官方为准。",
    row: modelRow(1, 0.02, 0, 2, ""),
  },
  {
    id: "claude-sonnet-5.5",
    provider: "Anthropic",
    models: ["claude-sonnet-5-5", "claude-sonnet-5.5"],
    label: "Claude Sonnet 5.5",
    currency: "USD",
    asOf: PRESETS_AS_OF,
    source:
      "https://apicostcheck.com/providers/anthropic/ (对照 platform.claude.com 官方价目)",
    note: "USD/百万 tokens；缓存读=官方 cached input 价；缓存写按 Anthropic 规则 1.25x 输入价（5min TTL）。无峰谷差价。",
    row: modelRow(2, 0.1, 2.5, 10, ""),
  },
  {
    id: "claude-opus-5.5",
    provider: "Anthropic",
    models: ["claude-opus-5-5", "claude-opus-5.5"],
    label: "Claude Opus 5.5",
    currency: "USD",
    asOf: PRESETS_AS_OF,
    source:
      "https://apicostcheck.com/providers/anthropic/ (fast mode $8/$40 为 2x 标准价，佐证标准价 $4/$20)",
    note: "USD/百万 tokens；缓存写按 1.25x 输入价。无峰谷差价。",
    row: modelRow(4, 0.2, 5, 20, ""),
  },
  {
    id: "claude-haiku-5.5",
    provider: "Anthropic",
    models: ["claude-haiku-5-5", "claude-haiku-5.5"],
    label: "Claude Haiku 5.5",
    currency: "USD",
    asOf: PRESETS_AS_OF,
    source: "https://apicostcheck.com/providers/anthropic/",
    note: "USD/百万 tokens；缓存写按 1.25x 输入价。无峰谷差价。",
    row: modelRow(0.1, 0.01, 0.125, 0.5, ""),
  },
  {
    id: "claude-sonnet-4.6",
    provider: "Anthropic",
    models: ["claude-sonnet-4-6", "claude-sonnet-4.6"],
    label: "Claude Sonnet 4.6",
    currency: "USD",
    asOf: PRESETS_AS_OF,
    source: "https://apicostcheck.com/providers/anthropic/",
    note: "USD/百万 tokens；缓存写按 1.25x 输入价。无峰谷差价。",
    row: modelRow(3, 0.3, 3.75, 15, ""),
  },
  {
    id: "gpt-6.1-sol",
    provider: "OpenAI",
    models: ["gpt-6.1-sol"],
    label: "GPT-6.1 Sol",
    currency: "USD",
    asOf: PRESETS_AS_OF,
    source:
      "https://developers.openai.com/api/docs/pricing (对照 apicostcheck.com/providers/openai/)",
    note: "USD/百万 tokens；OpenAI 的 cached input 即缓存读价，缓存写按未命中价计。无峰谷差价。",
    row: modelRow(2, 0.1, 2, 10, ""),
  },
  {
    id: "gpt-6-astra",
    provider: "OpenAI",
    models: ["gpt-6-astra"],
    label: "GPT-6 Astra",
    currency: "USD",
    asOf: PRESETS_AS_OF,
    source: "https://apicostcheck.com/providers/openai/",
    note: "USD/百万 tokens；缓存写按未命中价计。无峰谷差价。",
    row: modelRow(10, 1, 10, 50, ""),
  },
  {
    id: "gpt-5.6-terra",
    provider: "OpenAI",
    models: ["gpt-5.6-terra"],
    label: "GPT-5.6 Terra",
    currency: "USD",
    asOf: PRESETS_AS_OF,
    source:
      "https://developers.openai.com/api/docs/pricing (对照 apicostcheck.com/providers/openai/)",
    note: "USD/百万 tokens；超 272K 上下文档位约为 2x，请按实际档位复核。无峰谷差价。",
    row: modelRow(2, 0.2, 2, 12, ""),
  },
  {
    id: "gemini-4-argon",
    provider: "Google",
    models: ["gemini-4-argon"],
    label: "Gemini 4 Argon",
    currency: "USD",
    asOf: PRESETS_AS_OF,
    source: "https://apicostcheck.com/providers/gemini/",
    note: "USD/百万 tokens；缓存读=cached input 价，缓存写按未命中价计。无峰谷差价。",
    row: modelRow(2, 0.1, 2, 10, ""),
  },
  {
    id: "gemini-3.8-flash",
    provider: "Google",
    models: ["gemini-3.8-flash"],
    label: "Gemini 3.8 Flash",
    currency: "USD",
    asOf: PRESETS_AS_OF,
    source: "https://apicostcheck.com/providers/gemini/",
    note: "USD/百万 tokens；缓存写按未命中价计。无峰谷差价。",
    row: modelRow(0.75, 0.075, 0.75, 3.75, ""),
  },
];

/**
 * The wire view of the presets the settings window picks from.
 *
 * Flattened with the peak schedule's key spelled out so the Client never has
 * to know which presets carry a schedule; the Host merges any schedule into
 * the draft on apply.
 * @returns the preset list with its data date.
 */
export function pricePresetCatalog() {
  return {
    asOf: PRESETS_AS_OF,
    presets: PRICE_PRESETS.map((preset) => ({
      id: preset.id,
      provider: preset.provider,
      label: preset.label,
      models: preset.models,
      currency: preset.currency,
      asOf: preset.asOf,
      source: preset.source,
      note: preset.note,
      row: preset.row,
      peakProfileName: preset.peakProfileName ?? "",
    })),
  };
}

/**
 * Merge one preset into a draft config value, without touching other rows.
 *
 * Applied rows still go through `Config` on save — this only copies values,
 * so a preset can never write anything the schema would refuse.
 * @param draft - the draft config object the modal holds.
 * @param presetId - the preset to apply.
 * @returns the model keys written, or null when the preset is unknown.
 */
export function applyPricePreset(draft, presetId) {
  const preset = PRICE_PRESETS.find((candidate) => candidate.id === presetId);
  if (preset === undefined) return null;
  const models =
    draft.models !== undefined && draft.models !== null ? draft.models : {};
  for (const key of preset.models) models[key] = { ...preset.row };
  draft.models = models;
  if (preset.peakProfile !== undefined && preset.peakProfileName !== "") {
    const profiles =
      draft.peakProfiles !== undefined && draft.peakProfiles !== null
        ? draft.peakProfiles
        : {};
    profiles[preset.peakProfileName] = { ...preset.peakProfile };
    draft.peakProfiles = profiles;
  }
  return preset.models;
}

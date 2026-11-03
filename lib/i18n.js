/**
 * Host-side copy, in the language the user is actually reading.
 *
 * The Client half has a locale service and translates at render time. The
 * Host does not: the strings it produces are written into the session log as
 * finished text — a `command/done` report, an error a slash command answers
 * with — and nothing downstream re-translates them. So the Host has to pick a
 * language itself, and it has to pick it at the moment the string is built
 * rather than when this module loads, so switching the language in settings
 * takes effect on the next button press without a restart.
 *
 * The preference lives in the `locale` settings namespace, written by the
 * `@deepseek-ai/dsh-client-locale` plugin. Reading it through
 * `ctx.settings.describe()` is the documented path and needs no file
 * surgery; everything below is a fallback chain for compositions that drop
 * the settings service or never wrote a preference.
 */

const NS = "locale";
const PREFERENCE_FIELD = "preference";

/** Simplified Chinese copy. */
const ZH = {
  "command.clear": "清空上下文",
  "command.compact": "压缩上下文",
  "command.clear.description": "用一个占位记录替换当前会话的全部上下文",
  "command.compact.description": "压缩当前会话的上下文",

  "report.clearDone": "已清空 {items} 条历史（{before} → {after} tokens）。",
  "report.clearEmpty": "当前会话没有可清空的历史。",
  "report.compactDone":
    "已压缩 {items} 条历史为一条 {chars} 字符的摘要（{before} → {after} tokens），可在下方的压缩卡展开查看。",
  "report.compactEmpty": "当前会话没有可压缩的历史。",
  "report.clearFailed": "清空失败：{error}",
  "report.compactFailed": "压缩失败：{error}",
  "report.noCommandRuntime": "命令服务不可用，无法在主会话中回报结果。",

  "error.busy": "清空上下文需要在会话空闲时进行，请等本轮结束后再试。",
  "error.inFlight": "这个会话已有一轮压缩在进行中。",
  "error.changed":
    "压缩期间这段历史被改写了（可能刚清空或又压缩过一次），这次压缩已放弃。",
  "error.notSmaller":
    "摘要没有被替换的历史小（{after} ≥ {before} tokens），已放弃这次压缩。",
  "error.noLlm": "模型服务不可用，无法生成摘要。",
  "error.noRoute": "没有可用的压缩模型路由，请先在设置里选择 provider 与 model。",
  "error.noSummary": "压缩模型没有返回摘要文本。",
  "error.truncated": "摘要输出被 token 上限截断，这份压缩已放弃（不完整的摘要比没有更糟）。",
  "error.tooLarge":
    "上下文体积 {tokens} tokens 已超过压缩模型的 {limit} tokens 上限，请先清空上下文或改用更大的模型。",
  "optimizer.empty": "输入框里没有可优化的提示词。",
  "optimizer.contextIntro":
    "下面是当前会话的上下文摘录，只作为理解提示词所指内容的背景：不要改写它，不要回应它，也不要把它当作要执行的任务。",
  "optimizer.draftIntro": "下面这段文字才是要改写的提示词：",
  "error.configNotEditable":
    "当前 profile 无法编辑本插件配置：配置编辑器或其入口不可用。",

  "api.forbidden": "无权访问",
  "api.method": "仅支持 POST 请求",
  "api.noAgent": "该会话没有在线的 agent",
  "api.promptRequired": "需要非空的提示词文本",
  "api.configRequired": "需要一个配置对象",
  "api.unknownMethod": "未知方法 \"{method}\"",

  "schema.price": "价格必须是非负的有限数字",
  "schema.clock": "\"{value}\" 不是合法的 HH:MM 时间",
  "schema.weekday": "星期取值必须是 1（周一）到 7（周日）的整数",
  "schema.peakMode": "\"{value}\" 不是可用的模式（{modes}）",
  "schema.offPeakRatio": "offPeakRatio 必须大于 0 且不超过 1",

  "prompt.excerptGap":
    "……（此处省略 {items} 条历史：原会话已超出压缩模型的上下文上限，只保留开头与最近的记录，预算约 {tokens} tokens。摘要时请以此为准，不要假设缺失部分的内容。）……",
  "prompt.segment":
    "第 {index}/{total} 段。下面这段历史已按上下文上限切分，只摘要这一段；其余段落由别的请求并行处理，合并在最后一步完成。不要假设本段之外的内容。",
  "prompt.merge":
    "下面是同一段对话被切成 {count} 段后各自得到的摘要，按时间顺序排列。请把它们整合成一份连贯的摘要，不要保留分段编号，不要重复同一事实，也不要补写任何一段里没有出现的内容。",
};

/** English copy. */
const EN = {
  "command.clear": "Clear context",
  "command.compact": "Compact context",
  "command.clear.description":
    "Replace the whole conversation context with a placeholder",
  "command.compact.description": "Compress the conversation context",

  "report.clearDone": "Cleared {items} history items ({before} → {after} tokens).",
  "report.clearEmpty": "There is no history to clear.",
  "report.compactDone":
    "Compacted {items} history items into a {chars}-character summary ({before} → {after} tokens); expand the compaction card below.",
  "report.compactEmpty": "There is no history to compact.",
  "report.clearFailed": "Clear failed: {error}",
  "report.compactFailed": "Compaction failed: {error}",
  "report.noCommandRuntime":
    "The command service is unavailable, so the report cannot be written to this session.",

  "error.busy":
    "Clearing the context requires an idle session; wait for the turn to finish.",
  "error.inFlight": "A compaction is already in flight on this session.",
  "error.changed":
    "This history was rewritten while it was being compacted (it may have been cleared or compacted again), so this compaction was abandoned.",
  "error.notSmaller":
    "The summary is not smaller than the history it replaces ({after} ≥ {before} tokens), so nothing was changed.",
  "error.noLlm": "The model service is not available, so no summary can be produced.",
  "error.noRoute":
    "No compaction route is available; choose a provider and model in the settings.",
  "error.noSummary": "The compaction model returned no summary text.",
  "error.truncated":
    "The summary was truncated at the token cap, so this compaction was abandoned (an incomplete summary is worse than none).",
  "error.tooLarge":
    "The context is {tokens} tokens, over the compaction model's {limit}-token limit. Clear the context first or switch to a model with a larger window.",
  "optimizer.empty": "There is no prompt in the input box to optimize.",
  "optimizer.contextIntro":
    "Below is an excerpt of the current session's context, provided only as background for what the prompt refers to: do not rewrite it, do not respond to it, and do not treat it as a task.",
  "optimizer.draftIntro": "The text that follows is the prompt to rewrite:",
  "error.configNotEditable":
    "This profile cannot edit the plugin config: the config editor or its entry is unavailable.",

  "api.forbidden": "forbidden",
  "api.method": "POST required",
  "api.noAgent": "no live agent for that session",
  "api.promptRequired": "a non-empty prompt text is required",
  "api.configRequired": "a config object is required",
  "api.unknownMethod": "unknown method \"{method}\"",

  "schema.price": "a price must be a finite non-negative number",
  "schema.clock": "\"{value}\" is not an HH:MM time of day",
  "schema.weekday": "a weekday must be an integer from 1 (Mon) to 7 (Sun)",
  "schema.peakMode": "\"{value}\" is not one of {modes}",
  "schema.offPeakRatio": "offPeakRatio must be greater than 0 and at most 1",

  "prompt.excerptGap":
    "…({items} earlier messages omitted: the original session is larger than the compaction model's context window, so only the oldest and most recent messages are kept, within a budget of about {tokens} tokens. Summarize from what is here and do not assume what the gap contained.)…",
  "prompt.segment":
    "Segment {index} of {total}. This history was cut to fit the context window; summarize this segment only. The other segments are being summarized in parallel and merged in a final step, so do not assume anything outside this segment.",
  "prompt.merge":
    "Below are the summaries of {count} consecutive segments of one conversation, in order. Merge them into a single coherent summary: drop the segment numbering, do not repeat a fact twice, and do not add anything that none of the segments mentions.",
};

const DICTIONARIES = { zh: ZH, en: EN };

/**
 * Whether a tag names Simplified Chinese.
 * @param tag - a BCP 47 tag, possibly with a script or region subtag.
 * @returns whether the primary subtag is `zh`.
 */
function isChinese(tag) {
  return typeof tag === "string" && /^zh(?:[-_]|$)/iu.test(tag.trim());
}

/**
 * Whether a tag names English.
 * @param tag - a BCP 47 tag.
 * @returns whether the primary subtag is `en`.
 */
function isEnglish(tag) {
  return typeof tag === "string" && /^en(?:[-_]|$)/iu.test(tag.trim());
}

/**
 * The language the user set in settings.
 *
 * `describe()` is the same call the settings UI makes. It is synchronous and
 * idempotent — repeating it emits nothing unless the underlying config
 * changed — so calling it per report costs one in-memory walk, not a read.
 * @param ctx - the Host context.
 * @returns the preferred tag, or undefined when nothing is recorded.
 */
function preferredLocale(ctx) {
  let entries;
  try {
    entries = ctx?.get?.("settings")?.describe?.({ redactSecrets: true });
  } catch {
    // A missing settings service or an inactive profile entry must not turn
    // into a failed button press; fall through to the fallbacks below.
    return undefined;
  }
  if (!Array.isArray(entries)) return undefined;
  const row = entries.find((entry) => entry?.ns === NS);
  const value = row?.value?.[PREFERENCE_FIELD];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The language the operating system reports.
 * @returns the first usable tag, or undefined.
 */
function systemLocale() {
  const fromEnvironment =
    process.env.DSH_LANG ??
    process.env.LC_ALL ??
    process.env.LC_MESSAGES ??
    process.env.LANG;
  if (typeof fromEnvironment === "string" && fromEnvironment.trim() !== "")
    return fromEnvironment;
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}

/**
 * Resolve which dictionary to read.
 *
 * Chinese when anything says Chinese; otherwise English, which is the safer
 * default for a string that is shown once and never re-rendered.
 * @param ctx - the Host context.
 * @returns the language id.
 */
export function resolveLanguage(ctx) {
  for (const tag of [preferredLocale(ctx), systemLocale()]) {
    if (tag === undefined) continue;
    if (isChinese(tag)) return "zh";
    if (isEnglish(tag)) return "en";
  }
  return "en";
}

/**
 * Build a translator bound to the current language.
 *
 * `{name}` placeholders are replaced from `values`; a missing value leaves the
 * placeholder in place rather than printing `undefined`, so a half-filled
 * template is visible instead of silently wrong.
 * @param ctx - the Host context.
 * @returns a `(key, values?) => string` function.
 */
export function translatorFor(ctx) {
  return (key, values) => {
    const language = resolveLanguage(ctx);
    const table = DICTIONARIES[language] ?? EN;
    const template = table[key] ?? EN[key] ?? key;
    if (values === undefined) return template;
    return template.replace(/\{(\w+)\}/gu, (match, name) =>
      Object.hasOwn(values, name) ? String(values[name]) : match,
    );
  };
}

export { DICTIONARIES };

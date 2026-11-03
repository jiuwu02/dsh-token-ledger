/**
 * dsh-token-panorama — Client half.
 *
 * Registers one sidebar icon plus the main panel it opens. Everything the
 * panel shows is folded from the Host's day buckets on the client, so changing
 * the range or the grain never costs a round trip.
 */

window.__ModuleLoader__.load({
  id: "dsh-token-panorama",
  factory(require) {
    const React = require("react");
    // `react-dom` is a platform seed module (the shell's own client packages
    // require it the same way), which is why a portal is available to us at all.
    const ReactDOM = require("react-dom");
    const h = React.createElement;
    const {
      useCallback,
      useEffect,
      useLayoutEffect,
      useMemo,
      useRef,
      useState,
      useSyncExternalStore,
    } = React;

    /** No-op store face for renders before the input shell resolves. */
    const subscribeNoop = () => () => {};
    const snapshotNoop = () => undefined;

    /** Panel identity, shared by the sidebar row and the main slot key. */
    const PANEL_ID = "dsh-token-panorama";
    /** Locale namespace owned by this plugin. */
    const NS = "dsh-token-panorama";
    /**
     * The bound translator, captured when the plugin applies.
     *
     * Components registered as slots normally receive `t` from the framework
     * through their `locale` namespace, but a slot rendered on a path that does
     * not pass it still needs one; this is that fallback.
     */
    let boundT = null;

    //#region i18n

    const ZH = {
      "nav.label": "Token 全景",
      "page.title": "Token 全景",
      "page.subtitle": "基于会话日志聚合，覆盖主会话与子代理。",
      "action.refresh": "刷新",
      "action.refreshing": "刷新中…",
      "action.export": "导出",
      "action.exportCsv": "导出 CSV",
      "action.exportJson": "导出 JSON",
      "action.settings": "常规设置",
      "settings.title": "常规设置",
      "settings.hint":
        "时区、币种、价格时段与节假日决定成本估算；提示词优化与上下文设置在各自的标签页配置。保存后立即生效。",
      "settings.readonly": "当前 profile 不支持在线编辑配置，仅可查看。",
      "settings.save": "保存",
      "settings.saving": "保存中…",
      "settings.cancel": "取消",
      "settings.reset": "恢复默认",
      "settings.export": "导出配置",
      "settings.exportHint": "把当前计费配置导出为 JSON 文件，可分享给其他人。",
      "settings.import": "导入配置",
      "settings.importHint":
        "读取他人分享的计费配置文件，导入后需点保存才会生效。",
      "settings.importDone": "已导入 {models} 个模型的价格，确认无误后点保存。",
      "settings.importFailed": "导入失败：{error}",
      "settings.importInvalid": "文件格式不正确，不是本插件导出的计费配置。",
      "settings.readError": "文件读取失败",
      "settings.loading": "正在读取配置…",
      "settings.saved": "已保存，正在重新计价。",
      "settings.inherited": "留空表示沿用默认值。",
      "settings.tab.models": "模型与价格",
      "settings.tab.peaks": "峰谷方案",
      "settings.tab.holidays": "节假日",
      "settings.tab.general": "通用",
      "settings.tab.context": "上下文",
      "settings.tab.optimizer": "提示词优化",
      "context.clear": "清空上下文",
      "context.clear.hint":
        "把当前会话的全部历史替换为一条占位记录（会话与日志完整保留）。需要会话空闲，运行中点击会被拒绝。",
      "context.compact": "压缩上下文",
      "context.compact.hint":
        "用一次直接的模型调用把已完成的历史压缩成一条摘要。会话运行中也能用：压缩期间新产生的对话原样保留，接在摘要之后。",
      "optimize.button": "优化提示词",
      "optimize.hint":
        "把输入框里的提示词交给优化模型改写：目标更明确、约束更完整，只改提示词本身，不动附件与图片。",
      "optimize.working": "优化中…",
      "settings.models.title": "模型价格",
      "settings.models.hint":
        "按百万 tokens 计价，四项分开填写：未命中缓存的输入、命中缓存的读取、写入缓存、输出。供应商不收取的项填 0。命中价不是固定 10%——DeepSeek 只有 2%，填错会把缓存密集的账单高估数倍。打开峰谷开关后，这四项价格都按所选方案区分高峰期与空闲期。",
      "settings.models.model": "模型",
      "settings.models.input": "输入·未命中",
      "settings.models.cacheRead": "输入·命中缓存",
      "settings.models.cacheWrite": "缓存写入",
      "settings.models.output": "输出",
      "settings.models.inputHint": "提示词首次送入、未命中前缀缓存的部分",
      "settings.models.cacheReadHint": "命中前缀缓存、按折扣价读取的部分",
      "settings.models.cacheWriteHint":
        "写入缓存的部分。按 TTL 分档的供应商填短档（5 分钟）；不单独计费的填 0",
      "settings.models.outputHint": "模型生成的内容",
      "settings.models.missingSchedule": "方案已删除，请重新选择",
      "settings.models.peak": "峰谷计费",
      "settings.models.empty": "还没有可配置的模型。",
      "settings.models.unpriced": "未配置",
      "settings.models.addRow": "添加价格",
      "settings.models.addPlaceholder":
        "输入模型名称，例如 deepseek-v4.1-flash",
      "settings.models.add": "添加模型",
      "settings.on": "启用",
      "settings.off": "关闭",
      "settings.remove": "移除",
      "settings.peaks.title": "峰谷方案",
      "settings.peaks.hint":
        "一套时段规则可以被多个模型复用；关闭开关的模型全天按单一价格计费。",
      "settings.peaks.empty": "还没有峰谷方案。添加一个后再为模型启用。",
      "settings.peaks.name": "方案名称",
      "settings.peaks.start": "起始",
      "settings.peaks.end": "结束",
      "settings.peaks.ratio": "空闲价比例",
      "settings.peaks.ratioHint": "空闲价 = 标价 × 该比例",
      "settings.peaks.weekdays": "生效星期",
      "settings.peaks.windows": "高峰时段",
      "settings.peaks.addWindow": "添加时段",
      "settings.peaks.add": "新建方案",
      "settings.peaks.aria": "峰谷方案",
      "settings.mode.everyday": "每天",
      "settings.mode.workday": "法定工作日（智能跳过节假日）",
      "settings.mode.holiday": "法定节假日（智能跳过工作日）",
      "settings.mode.weekdays": "周一至周五",
      "settings.mode.custom": "自定义",
      "settings.holidays.title": "节假日日历",
      "settings.holidays.hint":
        "勾选后这些日期会被峰谷方案的「法定工作日 / 法定节假日」模式识别。",
      "settings.holidays.days": "{count} 天",
      "settings.holidays.years": "已加载 {years} 年数据",
      "settings.holidays.pending": "暂无数据",
      "settings.holidays.refresh": "刷新节假日数据",
      "settings.holidays.offline": "联网获取失败，当前使用已缓存数据",
      "settings.holidays.updated": "节假日数据已更新",
      "settings.holidays.unchanged": "节假日数据已是最新",
      "settings.holidaySet.cn": "中国法定节假日",
      "settings.holidaySet.cn-makeup": "中国调休补班日",
      "settings.close": "关闭",
      "settings.search": "搜索…",
      "settings.noMatch": "没有匹配的选项",
      "settings.all": "全部",
      "settings.field.timeZone": "计费时区",
      "settings.field.currency": "货币单位",
      "settings.fieldDesc.timeZone":
        "服务商计费所用的时区，决定每个时段的边界。",
      "settings.fieldDesc.currency": "显示在所有金额旁的单位标签。",
      "settings.field.compactPrompt": "压缩提示词",
      "settings.field.compactProvider": "压缩模型 Provider",
      "settings.field.compactModel": "压缩模型",
      "settings.field.autoCompact": "自动压缩",
      "settings.field.autoCompactThreshold": "触发阈值",
      "settings.field.splitCompaction": "超出上限时分段压缩",
      "settings.fieldDesc.autoCompact":
        "开启后由本插件在每一步开始前按真实占用判定，达到阈值就自动压缩，无需手动点按钮。",
      "settings.autoCompactThresholdHint":
        "按「系统提示词 + 工具定义 + 对话消息」的真实总占用，占所选模型输入上下文上限的比例。",
      "settings.fieldDesc.splitCompaction":
        "关闭：历史超出压缩模型上限时丢弃最早的部分，只压缩最近能装下的记录。开启：按上限切成多段并行压缩，再由一个子代理整合成一份摘要，不丢历史。",
      "settings.splitCompactionHint":
        "分段会同时发起多个请求，耗时更短，但调用次数与费用更高；关闭时最早的历史会被丢弃。",
      "settings.context.title": "上下文占用",
      "settings.context.window": "上下文上限",
      "settings.context.used": "已占用",
      "settings.context.ratio": "占用比例",
      "settings.context.system": "系统提示词",
      "settings.context.tools": "工具定义",
      "settings.context.messages": "对话消息",
      "settings.context.usage": "计费侧最后上报的用量 {tokens}，与上方三项总和不属同一口径。",
      "settings.context.unavailable": "无法读取当前会话的上下文占用。",
      "settings.context.noWindow": "所选模型未提供上下文上限，无法计算比例。",
      "settings.fieldDesc.compactPrompt":
        "「压缩上下文」命令与绿色按钮把这段指令连同全部历史交给压缩模型，由它写出替换用的摘要。",
      "settings.fieldDesc.compactProvider": "留空则沿用当前会话的 provider。",
      "settings.fieldDesc.compactModel": "留空则沿用当前会话的模型。",
      "settings.field.optimizerPrompt": "提示词优化指令",
      "settings.field.optimizerProvider": "优化模型 Provider",
      "settings.field.optimizerModel": "优化模型",
      "settings.fieldDesc.optimizerPrompt":
        "输入框工具栏的「优化提示词」按钮把这段指令连同草稿一起交给优化模型，由它写出替换用的提示词。",
      "settings.fieldDesc.optimizerProvider": "留空则沿用当前会话的 provider。",
      "settings.fieldDesc.optimizerModel": "留空则沿用当前会话的模型。",
      "settings.field.optimizerUseContext": "根据上下文优化提示词",
      "settings.fieldDesc.optimizerUseContext":
        "开启后，请求会附带当前会话上下文的摘录，改写会贴合正在进行的任务；摘录随每次点击发送，额外消耗 token。",
      "settings.placeholder.inherit": "继承会话设置",
      "settings.fieldEmpty": "未设置",
      "range.label": "时间范围",
      "range.from": "起始日期",
      "range.to": "结束日期",
      "range.all": "全部",
      "range.today": "今天",
      "range.24h": "近 24 小时",
      "range.week": "本周",
      "range.7": "近 7 天",
      "range.month": "本月",
      "range.30": "近 30 天",
      "range.hint": "所有卡片共用这一时间范围",
      "range.custom": "自定义",
      "stat.total": "累计消耗",
      "stat.input": "输入（未命中缓存）",
      "stat.output": "输出",
      "stat.cacheRead": "缓存读取",
      "stat.cacheWrite": "缓存写入",
      "stat.calls": "调用次数",
      "stat.sessions": "会话数",
      "stat.cost": "预估成本",
      "stat.hitRate": "缓存命中率",
      "stat.hitRateHint": "{hits} 命中 / {misses} 未命中",
      "stat.cacheWriteHint": "{tokens} tokens · 不计入命中率",
      "stat.peak": "高峰时段",
      "stat.offPeak": "空闲时段",
      "stat.peakHint": "{tokens} tokens · {cost}",
      "stat.offPeakHint": "{tokens} tokens · {cost}",
      "cost.rulePeak": "高峰 {peak}",
      "cost.ruleOffPeak": "空闲 {offPeak}",
      "cost.unpriced": "{models} 无定价，按默认价计算",
      "stat.tokens": "tokens",
      "heat.title": "使用热力图",
      "heat.hint": "颜色越深表示当日 token 消耗越高；此卡固定显示全部历史，不受上方时间范围影响。",
      "heat.week": "周",
      "heat.month": "月",
      "heat.less": "少",
      "heat.tokens": "消耗",
      "heat.cost": "计费",
      "heat.more": "多",
      "heat.empty": "所选范围内没有记录。",
      "heat.weekday.mon": "一",
      "heat.weekday.tue": "二",
      "heat.weekday.wed": "三",
      "heat.weekday.thu": "四",
      "heat.weekday.fri": "五",
      "heat.weekday.sat": "六",
      "heat.weekday.sun": "日",
      "heat.outside": "不在所选范围内",
      "trend.title": "用量趋势",
      "trend.hint": "悬停查看对应时间点的具体数值。",
      "trend.hour": "小时",
      "trend.day": "日",
      "trend.week": "周",
      "trend.month": "月",
      "trend.year": "年",
      "trend.empty": "所选范围内没有记录。",
      "trend.calls": "调用",
      "trend.hourHint": "时间范围缩到一天以内，横轴自动切换为小时。",
      "model.title": "模型分布",
      "model.hint": "按累计消耗排序，点击某个模型只看它的用量。",
      "model.focused":
        "已筛选 {model}：下方统计只计该模型，会话列表也仅显示用过它的会话。",
      "model.clear": "显示全部",
      "model.empty": "所选范围内没有记录。",
      "model.unknown": "未知模型",
      "session.title": "会话用量",
      "session.hint": "每个会话的 token 消耗，点表头可排序。",
      "session.empty": "所选范围内没有会话记录。",
      "session.untitled": "(未命名会话)",
      "session.archived": "已归档",
      "session.showArchived": "显示已归档",
      "session.count": "{shown} / {total} 个会话",
      "session.col.name": "会话",
      "session.col.tokens": "消耗",
      "session.col.calls": "调用",
      "session.col.created": "创建时间",
      "session.col.kind": "类型",
      "session.kind.main": "主会话",
      "session.kind.subagent": "子代理",
      "session.subagentTag": "子代理",
      "session.toggle": "展开或收起子代理",
      "session.truncated": "仅显示前 {shown} 个，共 {total} 个会话。",
      "session.export": "导出会话 CSV",
      "session.expand": "展开子代理",
      "session.collapse": "收起子代理",
      "session.subagents": "{count} 个子代理",
      "session.noSubagents": "无子代理",
      "session.orphan": "父会话不在本次统计内",
      "session.page": "第 {page} / {pages} 页",
      "session.prev": "上一页",
      "session.next": "下一页",
      "session.rows": "{shown} / {total}",
      "workspace.title": "工作区分布",
      "workspace.hint": "按会话的工作目录分组。",
      "workspace.empty": "所选范围内没有记录。",
      "workspace.unknown": "(无工作区)",
      "workspace.sessions": "{count} 个会话",
      "footer.source":
        "共 {sessions} 个会话（{main} 主会话 / {subagent} 子代理，{archived} 已归档），{calls} 次调用。",
      "footer.updated": "最后更新 {time}",
      "error.routeUnavailable": "用量接口不可用",
      "error.routeNonJson": "用量接口返回了非 JSON 响应",
      "error.routeStatus": "用量接口请求失败（HTTP {status}）",
      "state.loading": "正在读取会话日志…",
      "state.error": "读取失败：{message}",
      "state.retry": "重试",
    };

    const EN = {
      "nav.label": "Token Panorama",
      "page.title": "Token Panorama",
      "page.subtitle":
        "Aggregated from session logs, subagent sessions included.",
      "action.refresh": "Refresh",
      "action.refreshing": "Refreshing…",
      "action.export": "Export",
      "action.exportCsv": "Export CSV",
      "action.exportJson": "Export JSON",
      "action.settings": "General settings",
      "settings.title": "General settings",
      "settings.hint":
        "Time zone, currency, peak windows and holidays decide the cost estimate; prompt optimization and context settings live on their own tabs. Saving applies immediately.",
      "settings.readonly":
        "This profile cannot edit the config online; values are read-only.",
      "settings.save": "Save",
      "settings.saving": "Saving…",
      "settings.cancel": "Cancel",
      "settings.reset": "Reset to defaults",
      "settings.export": "Export config",
      "settings.exportHint":
        "Download the current billing configuration as JSON to share.",
      "settings.import": "Import config",
      "settings.importHint":
        "Load a shared billing configuration. Nothing is saved until you press Save.",
      "settings.importDone":
        "Imported prices for {models} models. Review them, then press Save.",
      "settings.importFailed": "Import failed: {error}",
      "settings.importInvalid":
        "That file is not a billing configuration exported by this plugin.",
      "settings.readError": "read error",
      "settings.loading": "Reading config…",
      "settings.saved": "Saved; re-pricing now.",
      "settings.inherited": "Leave a field empty to inherit its default.",
      "settings.tab.models": "Models & prices",
      "settings.tab.peaks": "Peak schedules",
      "settings.tab.holidays": "Holidays",
      "settings.tab.general": "General",
      "settings.tab.context": "Context",
      "settings.tab.optimizer": "Prompt optimization",
      "context.clear": "Clear context",
      "context.clear.hint":
        "Replace the whole session history with one placeholder record (session and log stay intact). The session must be idle; a click mid-turn is refused.",
      "context.compact": "Compact context",
      "context.compact.hint":
        "Compress the completed history into one summary with a direct model call. Works mid-conversation: whatever the session writes while it runs stays verbatim behind the summary.",
      "optimize.button": "Optimize prompt",
      "optimize.hint":
        "Send the draft in the input box to the optimizer model: a clearer goal, fuller constraints. Only the prompt text changes; attachments and images are untouched.",
      "optimize.working": "Optimizing…",
      "settings.models.title": "Model prices",
      "settings.models.hint":
        "Priced per million tokens, four items apart: uncached input, cache-hit input, cache write, output. Enter 0 for anything a provider does not bill. The cache-hit rate is not a flat 10% — DeepSeek charges 2%, and assuming otherwise overstates a cache-heavy bill several times over. Turning on peak pricing scales all four rates by the schedule.",
      "settings.models.model": "Model",
      "settings.models.input": "Input · miss",
      "settings.models.cacheRead": "Input · cache hit",
      "settings.models.cacheWrite": "Cache write",
      "settings.models.output": "Output",
      "settings.models.inputHint":
        "Prompt tokens sent fresh, outside any cached prefix",
      "settings.models.cacheReadHint":
        "Prompt tokens served from a cached prefix, at the discounted rate",
      "settings.models.cacheWriteHint":
        "Tokens written into the cache. Where a provider prices this by TTL, use the short (5-minute) band; 0 where it is not billed",
      "settings.models.outputHint": "Tokens the model generated",
      "settings.models.missingSchedule": "Schedule deleted — pick another",
      "settings.models.peak": "Peak pricing",
      "settings.models.empty": "No models to configure yet.",
      "settings.models.unpriced": "not priced",
      "settings.models.addRow": "Add price",
      "settings.models.addPlaceholder": "Model name, e.g. deepseek-v4.1-flash",
      "settings.models.add": "Add model",
      "settings.on": "On",
      "settings.off": "Off",
      "settings.remove": "Remove",
      "settings.peaks.title": "Peak schedules",
      "settings.peaks.hint":
        "One schedule can be shared by several models; a model with the toggle off bills one rate all day.",
      "settings.peaks.empty":
        "No peak schedule yet. Add one, then enable it per model.",
      "settings.peaks.name": "Schedule name",
      "settings.peaks.start": "Starts",
      "settings.peaks.end": "Ends",
      "settings.peaks.ratio": "Off-peak ratio",
      "settings.peaks.ratioHint": "Off-peak price = listed price × this ratio",
      "settings.peaks.weekdays": "Applies on",
      "settings.peaks.windows": "Peak windows",
      "settings.peaks.addWindow": "Add window",
      "settings.peaks.add": "New schedule",
      "settings.peaks.aria": "peak schedule",
      "settings.mode.everyday": "Every day",
      "settings.mode.workday": "Statutory workdays (skips holidays)",
      "settings.mode.holiday": "Statutory holidays (skips workdays)",
      "settings.mode.weekdays": "Monday to Friday",
      "settings.mode.custom": "Custom",
      "settings.holidays.title": "Holiday calendars",
      "settings.holidays.hint":
        "Ticking a calendar lets the statutory workday and holiday modes recognise those dates.",
      "settings.holidays.days": "{count} days",
      "settings.holidays.years": "{years} years loaded",
      "settings.holidays.pending": "No data yet",
      "settings.holidays.refresh": "Refresh holiday data",
      "settings.holidays.offline": "Fetch failed, using cached data",
      "settings.holidays.updated": "Holiday data updated",
      "settings.holidays.unchanged": "Holiday data already current",
      "settings.holidaySet.cn": "China statutory holidays",
      "settings.holidaySet.cn-makeup": "China make-up workdays",
      "settings.close": "Close",
      "settings.search": "Search…",
      "settings.noMatch": "No matching options",
      "settings.all": "All",
      "settings.field.timeZone": "Billing time zone",
      "settings.field.currency": "Currency",
      "settings.fieldDesc.timeZone":
        "The zone the provider bills in; it decides every band boundary.",
      "settings.fieldDesc.currency": "The label shown beside every amount.",
      "settings.field.compactPrompt": "Compaction prompt",
      "settings.field.compactProvider": "Compaction model provider",
      "settings.field.compactModel": "Compaction model",
      "settings.field.autoCompact": "Automatic compaction",
      "settings.field.autoCompactThreshold": "Trigger threshold",
      "settings.field.splitCompaction": "Segment when over the window",
      "settings.fieldDesc.autoCompact":
        "When on, this plugin checks real usage before every step and compacts automatically at the threshold; no button press needed.",
      "settings.autoCompactThresholdHint":
        "Share of the selected model's input window taken by the real total of system prompt, tool definitions, and conversation messages.",
      "settings.fieldDesc.splitCompaction":
        "Off: history larger than the summarizer's window loses its oldest records and only the newest that fit are summarized. On: the history is cut into segments that are summarized in parallel and merged into one summary, keeping all of it.",
      "settings.splitCompactionHint":
        "Segmenting issues several requests at once, so it is faster but calls the model more often and costs more; turning it off discards the oldest history.",
      "settings.context.title": "Context usage",
      "settings.context.window": "Context window",
      "settings.context.used": "In use",
      "settings.context.ratio": "Share",
      "settings.context.system": "System prompt",
      "settings.context.tools": "Tool definitions",
      "settings.context.messages": "Messages",
      "settings.context.usage":
        "Last usage reported by the provider: {tokens}. That figure is accounted differently from the three-part total above.",
      "settings.context.unavailable":
        "The current session's context usage could not be read.",
      "settings.context.noWindow":
        "The selected model reports no context window, so no share can be computed.",
      "settings.fieldDesc.compactPrompt":
        "The compact-context command and the green button send this instruction, last, after the whole history; the model writes the replacement summary.",
      "settings.fieldDesc.compactProvider":
        "Empty keeps the session's provider.",
      "settings.fieldDesc.compactModel": "Empty keeps the session's model.",
      "settings.field.optimizerPrompt": "Prompt optimization instruction",
      "settings.field.optimizerProvider": "Optimizer model provider",
      "settings.field.optimizerModel": "Optimizer model",
      "settings.fieldDesc.optimizerPrompt":
        "The optimize button in the input box toolbar sends this instruction, then the draft; the model writes the replacement prompt.",
      "settings.fieldDesc.optimizerProvider":
        "Empty keeps the session's provider.",
      "settings.fieldDesc.optimizerModel": "Empty keeps the session's model.",
      "settings.field.optimizerUseContext": "Optimize with context",
      "settings.fieldDesc.optimizerUseContext":
        "When on, the request carries an excerpt of the current session's context so the rewrite fits the ongoing task; the excerpt is sent on every click and costs extra tokens.",
      "settings.placeholder.inherit": "inherit from the session",
      "settings.fieldEmpty": "not set",
      "range.label": "Range",
      "range.from": "Start date",
      "range.to": "End date",
      "range.all": "All",
      "range.today": "Today",
      "range.24h": "Last 24 hours",
      "range.week": "This week",
      "range.7": "Last 7 days",
      "range.month": "This month",
      "range.30": "Last 30 days",
      "range.hint": "Every card below follows this range",
      "range.custom": "Custom",
      "stat.total": "Total tokens",
      "stat.input": "Input (cache miss)",
      "stat.output": "Output",
      "stat.cacheRead": "Cache read",
      "stat.cacheWrite": "Cache write",
      "stat.calls": "Calls",
      "stat.sessions": "Sessions",
      "stat.cost": "Estimated cost",
      "stat.hitRate": "Cache hit rate",
      "stat.hitRateHint": "{hits} hit / {misses} miss",
      "stat.cacheWriteHint": "{tokens} tokens · excluded from hit rate",
      "stat.peak": "Peak hours",
      "stat.offPeak": "Off-peak",
      "stat.peakHint": "{tokens} tokens · {cost}",
      "stat.offPeakHint": "{tokens} tokens · {cost}",
      "cost.rulePeak": "Peak {peak}",
      "cost.ruleOffPeak": "Off-peak {offPeak}",
      "cost.unpriced": "{models} unpriced, billed at the default rate",
      "stat.tokens": "tokens",
      "heat.title": "Usage heatmap",
      "heat.hint":
        "Darker cells mean more tokens on that day. This card always spans the whole history and ignores the range above.",
      "heat.week": "Week",
      "heat.month": "Month",
      "heat.less": "Less",
      "heat.tokens": "Used",
      "heat.cost": "Billed",
      "heat.more": "More",
      "heat.empty": "No records in this range.",
      "heat.weekday.mon": "M",
      "heat.weekday.tue": "T",
      "heat.weekday.wed": "W",
      "heat.weekday.thu": "T",
      "heat.weekday.fri": "F",
      "heat.weekday.sat": "S",
      "heat.weekday.sun": "S",
      "heat.outside": "Outside the selected range",
      "trend.title": "Usage trend",
      "trend.hint": "Hover to read the exact value at each point.",
      "trend.hour": "Hour",
      "trend.day": "Day",
      "trend.week": "Week",
      "trend.month": "Month",
      "trend.year": "Year",
      "trend.empty": "No records in this range.",
      "trend.calls": "calls",
      "trend.hourHint": "A one-day range switches the axis to hours.",
      "model.title": "Models",
      "model.hint":
        "Sorted by total consumption. Click a model to filter the page to it.",
      "model.focused":
        "Filtered to {model}: the figures below cover only it, and the session list shows only sessions that used it.",
      "model.clear": "Show all",
      "model.empty": "No records in this range.",
      "model.unknown": "Unknown model",
      "session.title": "Session usage",
      "session.hint":
        "Token usage per session; select a column header to sort.",
      "session.empty": "No sessions in this range.",
      "session.untitled": "(untitled session)",
      "session.archived": "Archived",
      "session.showArchived": "Show archived",
      "session.count": "{shown} of {total} sessions",
      "session.col.name": "Session",
      "session.col.tokens": "Tokens",
      "session.col.calls": "Calls",
      "session.col.created": "Created",
      "session.col.kind": "Kind",
      "session.kind.main": "Main",
      "session.kind.subagent": "Subagent",
      "session.subagentTag": "Subagent",
      "session.toggle": "Show or hide subagents",
      "session.truncated": "Showing the first {shown} of {total} sessions.",
      "session.export": "Export sessions CSV",
      "session.expand": "Show subagents",
      "session.collapse": "Hide subagents",
      "session.subagents": "{count} subagents",
      "session.noSubagents": "No subagents",
      "session.orphan": "Parent session outside this report",
      "session.page": "Page {page} of {pages}",
      "session.prev": "Previous",
      "session.next": "Next",
      "session.rows": "{shown} / {total}",
      "workspace.title": "Workspaces",
      "workspace.hint": "Grouped by each session's working directory.",
      "workspace.empty": "No records in this range.",
      "workspace.unknown": "(no workspace)",
      "workspace.sessions": "{count} sessions",
      "footer.source":
        "{sessions} sessions in total ({main} main / {subagent} subagent, {archived} archived), {calls} calls.",
      "footer.updated": "Updated {time}",
      "error.routeUnavailable": "token-stats route unavailable",
      "error.routeNonJson": "token-stats route returned a non-JSON response",
      "error.routeStatus": "token-stats route failed with {status}",
      "state.loading": "Reading session logs…",
      "state.error": "Could not read usage: {message}",
      "state.retry": "Retry",
    };

    //#endregion

    //#region formatting

    const GRAINS = ["day", "week", "month", "year"];

    /**
     * The quick ranges the filter bar offers, in the order it shows them.
     *
     * Each entry is a rule rather than a day count: "this week" starts on
     * Monday and "today" is one calendar day, and neither is expressible as
     * "the last N days". `hourly` marks the presets whose span is a day or
     * less — the trend card switches its axis to hours for exactly those, which
     * is why the flag lives here instead of being re-derived from the dates in
     * the chart.
     */
    const PRESETS = [
      { id: "all", label: "range.all", hourly: false },
      { id: "today", label: "range.today", hourly: true },
      { id: "24h", label: "range.24h", hourly: true },
      { id: "week", label: "range.week", hourly: false },
      { id: "7", label: "range.7", hourly: false },
      { id: "month", label: "range.month", hourly: false },
      { id: "30", label: "range.30", hourly: false },
    ];

    /**
     * The `{from, to}` a preset resolves to, in the Host's local day keys.
     *
     * `bounds` is the corpus span, which is what "all" means: an empty bound
     * would make the filter fall back to the same place, but naming the ends
     * lets the preset buttons report which one is active without a second
     * lookup.
     *
     * "Last 24 hours" is the one preset that is not a day range. It is
     * expressed as the pair of hour keys 24 hours apart, ending at the current
     * hour, so the trend card can plot it hour by hour; every day-grained card
     * below reads the same filter's day span and shows the two days it touches.
     * @param id - a {@link PRESETS} id.
     * @param now - the clock the preset is resolved against.
     * @param bounds - the corpus span.
     * @returns the range, with `""` meaning "no bound on that side".
     */
    function presetRange(id, now, bounds) {
      const today = dayKey(now);
      switch (id) {
        case "today":
          // The elapsed part of today, hour by hour. "Today" is a calendar day,
          // so the span starts at midnight rather than 24 hours back, but it
          // still ends at the current hour — plotting the hours that have not
          // happened yet would draw a flat tail that reads as inactivity.
          return {
            from: today,
            to: today,
            hours: { from: `${today}T00`, to: hourKey(now) },
          };
        case "24h": {
          const start = addHours(now, -23);
          return {
            from: dayKey(start),
            to: today,
            // 24 buckets: the current hour and the 23 before it.
            hours: { from: hourKey(start), to: hourKey(now) },
          };
        }
        case "week":
          return {
            from: dayKey(startOfWeek(now)),
            to: today,
            hours: null,
          };
        case "month":
          return {
            from: dayKey(new Date(now.getFullYear(), now.getMonth(), 1)),
            to: today,
            hours: null,
          };
        case "7":
        case "30": {
          const span = Number(id);
          return {
            from: dayKey(addDays(now, -(span - 1))),
            to: today,
            hours: null,
          };
        }
        default:
          return { from: bounds.from, to: bounds.to, hours: null };
      }
    }

    /** Two-digit zero padding. */
    function pad2(value) {
      return value < 10 ? `0${value}` : String(value);
    }

    /** Coerce one usage counter delivered over the wire. */
    function count(value) {
      return typeof value === "number" && Number.isFinite(value) && value > 0
        ? Math.round(value)
        : 0;
    }

    /** Local `YYYY-MM-DD` for one date. */
    function dayKey(date) {
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    }

    /** Local midnight for a `YYYY-MM-DD` key. */
    function parseDay(key) {
      const [year, month, day] = key.split("-").map(Number);
      return new Date(year, month - 1, day);
    }

    /** A new date `offset` days away, at local midnight. */
    function addDays(date, offset) {
      const next = new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
      );
      next.setDate(next.getDate() + offset);
      return next;
    }

    /** Monday of the week containing `date`, at local midnight. */
    function startOfWeek(date) {
      const midnight = new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
      );
      return addDays(midnight, -((midnight.getDay() + 6) % 7));
    }

    /** `YYYY-MM` for one date. */
    function monthKey(date) {
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
    }

    /**
     * Local `YYYY-MM-DDTHH` for one date — the key the Host's hour rows carry.
     *
     * The Host already labels every slot this way, so the Client uses the same
     * string as its filter bound. Re-deriving a Date from it and comparing
     * timestamps would put a daylight-saving shift between the two sides.
     */
    function hourKey(date) {
      return `${dayKey(date)}T${pad2(date.getHours())}`;
    }

    /** Local time for a `YYYY-MM-DDTHH` key, at the top of that hour. */
    function parseHour(key) {
      const [day, hour] = key.split("T");
      const date = parseDay(day);
      date.setHours(Number(hour), 0, 0, 0);
      return date;
    }

    /** A new date `offset` hours away. */
    function addHours(date, offset) {
      const next = new Date(date.getTime());
      next.setHours(next.getHours() + offset, 0, 0, 0);
      return next;
    }

    /** Days between two local midnights. */
    function daysBetween(from, to) {
      return Math.round((to.getTime() - from.getTime()) / 86400000);
    }

    /** Group separator formatting that does not depend on the browser locale. */
    function formatInt(value) {
      return Math.round(value).toLocaleString("en-US");
    }

    /** Short form for cards and axes: 1.2B / 34.5M / 678K. */
    function formatCompact(value) {
      const abs = Math.abs(value);
      if (abs >= 1e9) return `${(value / 1e9).toFixed(abs >= 1e10 ? 1 : 2)}B`;
      if (abs >= 1e6) return `${(value / 1e6).toFixed(abs >= 1e7 ? 1 : 2)}M`;
      if (abs >= 1e4) return `${(value / 1e3).toFixed(0)}K`;
      if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
      return formatInt(value);
    }

    /**
     * A money amount, with enough decimals to stay meaningful for the small
     * sums a short session produces.
     * @param value - the amount in the configured currency.
     * @returns the formatted amount, or a dash when it is not a number.
     */
    function money(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "—";
      const abs = Math.abs(value);
      if (abs === 0) return "0.00";
      if (abs >= 100) return value.toFixed(1);
      if (abs >= 1) return value.toFixed(2);
      return value.toFixed(3);
    }

    /**
     * A cost amount carrying the configured currency label.
     *
     * The symbol is looked up from the code the settings window writes, so
     * switching the currency there relabels every amount on the panel. Three
     * codes share `$`, so they keep the suffix form (`$12.34 HKD`) instead of
     * showing a symbol that would read as the wrong currency; a code Intl does
     * not recognise falls back to the suffix too, so nothing is ever silently
     * dropped.
     * @param value - the cost in the configured currency.
     * @param currency - an ISO 4217 code, as stored in the config.
     * @returns the amount with its currency, or a dash when it is not a number.
     */
    function cost(value, currency) {
      const amount = money(value);
      if (amount === "—") return amount;
      const code =
        typeof currency === "string" && currency !== "" ? currency : "CNY";
      try {
        const parts = new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: code,
          currencyDisplay: "narrowSymbol",
        }).formatToParts(0);
        const found = parts.find((part) => part.type === "currency");
        if (found === undefined) return `${amount} ${code}`;
        // `$` and `¥` are each shared by several ISO codes, so only the code
        // that owns the bare symbol prints without it; the rest keep the code
        // beside the amount so the label never names the wrong currency.
        const owner =
          found.value === "$" ? "USD" : found.value === "¥" ? "CNY" : null;
        const ambiguous = owner !== null && code !== owner;
        return ambiguous
          ? `${found.value}${amount} ${code}`
          : `${found.value}${amount}`;
      } catch {
        return `${amount} ${code}`;
      }
    }

    /** `2026-11-01 11:20` in the host's local time zone. */
    function formatMoment(time) {
      if (typeof time !== "number" || !Number.isFinite(time) || time <= 0)
        return "—";
      const date = new Date(time);
      return `${dayKey(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    }

    /** `2026-11-01` in the host's local time zone, or a dash for a missing stamp. */
    function formatDate(time) {
      if (typeof time !== "number" || !Number.isFinite(time) || time <= 0)
        return "—";
      return dayKey(new Date(time));
    }

    //#endregion

    //#region preferences

    /**
     * The prefix every preference of this plugin is stored under.
     *
     * The shell shares one origin between every plugin and the workspace it
     * runs in, so an unprefixed key would be a namespace collision waiting to
     * happen. The prefix also makes the entries obvious when a user opens the
     * storage inspector to clear them.
     */
    const PREF_PREFIX = "dsh-token-panorama.";

    /**
     * Read a stored preference.
     *
     * Storage can throw rather than return null — a browser with site data
     * blocked, or a privacy mode that keeps the object but rejects writes. A
     * failed read is not worth a broken panel, so it reports the fallback and
     * the caller decides what an absent value means.
     * @param key - the preference name, without the plugin prefix.
     * @param fallback - the value to use when nothing is stored.
     * @returns the stored value, or the fallback.
     */
    function readPref(key, fallback) {
      try {
        const raw = window.localStorage.getItem(PREF_PREFIX + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    }

    /**
     * Store a preference.
     *
     * A write failure is swallowed for the same reason as a read failure: the
     * control still works for this session, it just will not be remembered,
     * and an exception here would be thrown from a click handler.
     * @param key - the preference name, without the plugin prefix.
     * @param value - a JSON-serialisable value.
     */
    function writePref(key, value) {
      try {
        window.localStorage.setItem(PREF_PREFIX + key, JSON.stringify(value));
      } catch {
        /* Storage unavailable; the in-memory state is still correct. */
      }
    }

    //#endregion

    //#region transport

    /**
     * POST one command to the Host route. Document-relative on purpose: the GUI
     * is served with `<base href="./">`, so a root-absolute path escapes a
     * sub-path deployment.
     */
    /**
     * Translate one key through the bound translator.
     *
     * `post` runs in factory scope where the framework's `t` is out of reach,
     * and before the plugin applies there is no translator at all, so the
     * English row stands in.
     */
    const tr = (key) => (boundT ?? ((k) => EN[k] ?? k))(key);

    async function post(path, payload) {
      let response;
      try {
        response = await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch {
        throw new Error(tr("error.routeUnavailable"));
      }
      let envelope;
      try {
        envelope = await response.json();
      } catch {
        throw new Error(tr("error.routeNonJson"));
      }
      if (envelope?.ok === true) return envelope.value;
      throw new Error(
        envelope?.error?.message ??
          tr("error.routeStatus").replace("{status}", String(response.status)),
      );
    }

    const api = {
      summary: (refresh) =>
        post("token-stats/api/summary", { refresh: refresh === true }),
      refresh: () => post("token-stats/api/refresh", {}),
      config: () => post("token-stats/api/config", {}),
      holidays: () => post("token-stats/api/holidays", {}),
      saveConfig: (value) => post("token-stats/api/saveConfig", { value }),
      clearContext: (sessionId) =>
        post("token-stats/api/clearContext", { sessionId }),
      compactContext: (sessionId) =>
        post("token-stats/api/compactContext", { sessionId }),
      optimizePrompt: (sessionId, text) =>
        post("token-stats/api/optimizePrompt", { sessionId, text }),
      contextPressure: (sessionId) =>
        post("token-stats/api/contextPressure", { sessionId }),
    };

    //#endregion

    //#region styles

    // Inlined from icon-prompt-optimize.svg (which ships in the package for
    // reference and packaging): an inline string spares the button a network
    // fetch per render, and the paths carry no fill of their own so the
    // icon follows the button's currentColor across both themes.
    const OPTIMIZE_ICON =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" aria-hidden="true"><path d="M74.377555 949.628015a337.529931 337.529931 0 0 1 22.514995-99.091979l-55.222989-55.222989A419.332914 419.332914 0 0 0 0.12357 987.690007a36.449993 36.449993 0 0 0 36.384993 36.191993 418.299914 418.299914 0 0 0 192.18296-41.674991l-55.028989-55.029989a343.27193 343.27193 0 0 1-99.284979 22.450995z m547.325888-657.061865a109.671978 109.671978 0 1 0 109.671977 109.670978 109.671978 109.671978 0 0 0-109.671977-109.670978z"/><path d="M1021.489361 33.998203a33.933993 33.933993 0 0 0-31.289994-31.223994C967.815372 0.90421 944.848376 0.00021 922.010381 0.00021a865.825822 865.825822 0 0 0-701.897856 358.045927H37.088562a34.126993 34.126993 0 0 0-24.319995 58.060988l111.154978 111.284977A864.469823 864.469823 0 0 0 73.990555 684.99707l264.953945 265.146945a852.858825 852.858825 0 0 0 157.926968-50.06199l111.154977 111.155978a33.417993 33.417993 0 0 0 23.934995 10.063998 34.191993 34.191993 0 0 0 34.190993-33.998993V804.087045a865.889822 865.889822 0 0 0 357.852927-701.833856c0-23.095995-0.904-45.739991-2.515999-68.254986z m-399.979918 551.196887a182.893962 182.893962 0 1 1 183.087962-182.892963 182.957962 182.957962 0 0 1-182.893962 182.892963z"/></svg>';

    const CSS = `
.dts-page{box-sizing:border-box;height:100%;overflow:auto;padding:0 24px 48px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.dts-page>*{width:100%;max-width:1100px;margin:0 auto}
.dts-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:16px;padding-top:28px}
.dts-heading{min-width:0}
.dts-title{margin:0;font-size:20px;font-weight:500;line-height:28px}
.dts-subtitle{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.dts-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.dts-btn{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;transition:background-color .12s,border-color .12s}
.dts-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.dts-btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-brand-primary)}
.dts-btn:disabled{opacity:.55;cursor:not-allowed}
.dts-btn[data-primary=true]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dts-menuWrap{position:relative}
.dts-menu{z-index:20;position:absolute;top:calc(100% + 4px);right:0;min-width:160px;padding:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 8px 24px rgb(0 0 0 / 18%)}
.dts-menu button{display:block;width:100%;padding:7px 10px;border:none;border-radius:7px;background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:left;cursor:pointer}
.dts-menu button:hover{background:var(--dsw-alias-bg-layer-2)}
.dts-modalBackdrop{z-index:60;position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;background:rgb(0 0 0 / 45%)}
.dts-page>.dts-modalBackdrop{width:auto;max-width:none;margin:0}
/* The platform's own dialogs fill with bg-base, not bg-overlay: in dark mode
   bg-overlay resolves to #61666b, a mid grey that reads as "washed out" against
   the near-black page. bg-base is #151517/lighter-dark and matches the shell. */
.dts-modal{z-index:61;display:flex;flex-direction:column;width:min(760px,100%);max-height:min(84vh,860px);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-base);box-shadow:0 24px 64px rgb(0 0 0 / 32%)}
.dts-modalHead{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:18px 20px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.dts-modalTitle{margin:0;font-size:16px;font-weight:500;line-height:24px}
.dts-modalHint{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dts-modalClose{flex:none;width:28px;height:28px;border:none;border-radius:7px;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:16px;line-height:1;cursor:pointer}
.dts-modalClose:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dts-modalBody{flex:1;min-height:0;overflow-y:auto;padding:14px 20px}
.dts-modalFoot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 20px 16px;border-top:.5px solid var(--dsw-alias-border-l1)}
.dts-modalNote{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dts-modalNote[data-tone=error]{color:var(--dsw-alias-state-error-primary)}
.dts-modalNote[data-tone=ok]{color:var(--dsw-alias-state-success-primary)}
.dts-modalNote[data-tone=warn]{color:var(--dsw-alias-state-warn-primary)}
.dts-field{display:flex;flex-direction:column;gap:5px;padding:9px 0;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.dts-field:last-child{border-bottom:0}
.dts-fieldHead{display:flex;align-items:baseline;gap:8px}
.dts-fieldKey{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;font-family:var(--ds-font-family-code)}
.dts-fieldValue{margin-left:auto;color:var(--dsw-alias-label-primary);font-size:12px;font-family:var(--ds-font-family-code)}
.dts-fieldDesc{margin:0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
/* The context fill bar: the same measurement the automatic-compaction switch
   compares against, so it uses the same three tones that switch describes. */
.dts-fill{height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.dts-fillBar{height:100%;border-radius:3px;transition:width .15s ease;background:var(--dsw-alias-brand-primary)}
.dts-fillBar[data-tone=busy]{background:var(--dsw-alias-state-business-primary)}
.dts-fillBar[data-tone=warn]{background:var(--dsw-alias-state-warn-primary)}
.dts-breakdown{display:flex;flex-wrap:wrap;gap:4px 14px}
.dts-breakdownRow{display:inline-flex;align-items:baseline;gap:6px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.dts-breakdownRow span:last-child{color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code)}
.dts-check{accent-color:var(--dsw-alias-brand-primary);margin:0 0 0 auto;cursor:pointer}
.dts-check:disabled{cursor:default;opacity:.45}
.dts-threshold{display:flex;align-items:center;gap:10px}
.dts-range{flex:1;min-width:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.dts-range:disabled{cursor:default;opacity:.45}
.dts-thresholdValue{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px;font-family:var(--ds-font-family-code);white-space:nowrap}
.dts-input{box-sizing:border-box;width:100%;min-height:30px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;font-family:var(--ds-font-family-code);line-height:18px;resize:vertical}
.dts-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dts-input[data-invalid=true]{border-color:var(--dsw-alias-state-error-primary)}
.dts-checkline{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--dsw-alias-label-primary);cursor:pointer}
.dts-checkline input{accent-color:var(--dsw-alias-brand-primary);margin:0;cursor:pointer}
.dts-group{padding:4px 0 2px}
.dts-groupTitle{margin:0 0 2px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;text-transform:uppercase;letter-spacing:.04em}
.dts-subfields{padding-left:12px;border-left:2px solid var(--dsw-alias-border-l1)}
.dts-selectWrap{position:relative}
.dts-select{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;min-height:32px;padding:5px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:left;cursor:pointer}
.dts-select:hover{border-color:var(--dsw-alias-border-l1)}
.dts-select:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent)}
.dts-selectValue{flex:none;font-family:var(--ds-font-family-code);font-size:12px}
.dts-selectDetail{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:12px}
.dts-selectCaret{flex:none;color:var(--dsw-alias-label-secondary);font-size:10px;line-height:1}
/* Rendered into document.body at a measured fixed position so an ancestor's
   overflow never clips it — the modal body scrolls, and a popup inside it was
   cut off at the container edge. */
.dts-pop{position:fixed;z-index:90;display:flex;flex-direction:column;max-height:min(320px,60vh);padding:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 12px 32px rgb(0 0 0 / 28%)}
.dts-popSearch{margin-bottom:6px}
.dts-popList{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:1px}
.dts-popItem{display:flex;align-items:baseline;gap:8px;width:100%;padding:6px 8px;border:none;border-radius:6px;background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;text-align:left;cursor:pointer}
.dts-popItem[data-active=true]{background:var(--dsw-alias-bg-layer-2)}
.dts-popItem[aria-selected=true]{color:var(--dsw-alias-brand-primary)}
.dts-popItem[data-common=true] .dts-popCode{color:var(--dsw-alias-brand-primary)}
.dts-popCode{flex:none;min-width:132px;font-family:var(--ds-font-family-code);font-size:11px}
.dts-popLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11px}
.dts-popEmpty{padding:12px;color:var(--dsw-alias-label-secondary);font-size:12px;text-align:center}
.dts-modalWide{width:min(980px,100%)}
.dts-modalHeadText{min-width:0}
.dts-tabs{display:flex;flex-wrap:wrap;gap:2px;padding:0 20px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.dts-tab{padding:9px 12px;border:none;border-bottom:2px solid transparent;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:18px;cursor:pointer;transition:color .12s,border-color .12s}
.dts-tab:hover{color:var(--dsw-alias-label-primary)}
.dts-tab[aria-selected=true]{color:var(--dsw-alias-brand-primary);border-bottom-color:var(--dsw-alias-brand-primary)}
.dts-tab:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-brand-primary)}
.dts-section{padding:2px 0 8px}
.dts-textarea{box-sizing:border-box;width:100%;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;resize:vertical;min-height:180px;white-space:pre-wrap}
.dts-fieldGrid{display:grid;gap:0 16px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.dts-sectionHead{margin-bottom:10px}
.dts-sectionTitle{margin:0;font-size:14px;font-weight:500;line-height:22px}
.dts-sectionHint{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dts-table{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden}
/* Peak column sits before the action column so the delete button is pinned to
   the right edge of every row. */
.dts-tr{display:grid;grid-template-columns:minmax(0,1.5fr) repeat(4,minmax(0,.75fr)) minmax(112px,1.05fr) 34px;align-items:center;gap:8px;padding:7px 10px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.dts-tr:last-child{border-bottom:0}
.dts-trHead{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.dts-tr:not(.dts-trHead):nth-child(even){background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 42%,transparent)}
.dts-td{min-width:0;font-size:12px}
.dts-tdName{display:flex;flex-direction:column;align-items:flex-start;gap:1px}
.dts-tdPeak{display:flex;flex-direction:column;gap:4px}
.dts-tdAct{display:flex;justify-content:flex-end}
.dts-unit{display:block;font-size:10px;line-height:14px;opacity:.8}
.dts-modelName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code);font-size:11px}
.dts-modelUsage{color:var(--dsw-alias-label-secondary);font-size:10px;line-height:14px;font-variant-numeric:tabular-nums}
.dts-cellInput{box-sizing:border-box;width:100%;height:26px;padding:0 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;font-variant-numeric:tabular-nums}
.dts-cellInput:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dts-cellSelect{box-sizing:border-box;width:100%;height:24px;padding:0 4px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;cursor:pointer}
.dts-switch{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}
.dts-switch input{accent-color:var(--dsw-alias-brand-primary);margin:0;cursor:pointer}
.dts-iconBtn{width:24px;height:24px;border:none;border-radius:6px;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer}
.dts-iconBtn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-error-primary)}
.dts-tableEmpty{padding:18px;color:var(--dsw-alias-label-secondary);font-size:12px;text-align:center}
.dts-addRow{display:flex;align-items:center;gap:8px;margin-top:10px}
.dts-addInput{flex:1}
.dts-btnSmall{height:26px;padding:0 10px;font-size:12px;align-self:flex-start}
.dts-profile{margin-bottom:12px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.dts-profileHead{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.dts-profileName{flex:0 0 180px;height:28px;font-size:12px}
.dts-modeSelect{flex:1;height:28px}
.dts-profileGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.dts-windowList{display:flex;flex-direction:column;gap:6px;margin-bottom:10px}
.dts-windowRow{display:flex;align-items:center;gap:6px}
.dts-windowRow .dts-input{flex:0 0 120px}
.dts-windowDash{color:var(--dsw-alias-label-secondary);font-size:12px}
.dts-labeled{display:flex;flex-direction:column;gap:4px}
.dts-label{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.dts-ratioValue{font-size:12px;line-height:24px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.dts-weekdays{margin-top:10px}
.dts-weekdayRow{display:flex;flex-wrap:wrap;gap:6px;margin-top:5px}
.dts-weekday{display:inline-flex;align-items:center;gap:5px;padding:4px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dts-weekday[data-on=true]{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary)}
.dts-weekday input{margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.dts-holidayRow{display:flex;align-items:center;gap:10px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-size:12px;cursor:pointer}
.dts-holidayRow+.dts-holidayRow{margin-top:8px}
.dts-holidayRow input{margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.dts-holidayName{flex:1;min-width:0}
.dts-holidayYears{display:block;margin-top:2px;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}
.dts-holidayActions{display:flex;justify-content:flex-end;margin-top:10px}
.dts-holidayDays{color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums}
.dts-ctxWrap{display:flex;flex-direction:column;gap:4px;align-items:flex-start;max-width:100%}
.dts-ctxRow{display:flex;flex-wrap:wrap;gap:8px}
.dts-ctxBtn{height:28px;padding:0 12px;border:1px solid transparent;border-radius:8px;color:#fff;font:inherit;font-size:12px;line-height:16px;cursor:pointer;transition:opacity .12s,filter .12s}
.dts-ctxBtn:hover:not(:disabled){filter:brightness(1.08)}
.dts-ctxBtn:disabled{opacity:.55;cursor:default}
.dts-ctxBtn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-brand-primary)}
.dts-ctxClear{background:#d97706}
.dts-ctxCompact{background:#16a34a}
/* The optimize button sits inline in the composer toolbar row (input.left
   slot): real flow layout, so it can never cover the draft text. Chip
   styling matches the platform toolbar buttons — bare icon+label that
   brightens on hover instead of a boxed button. */
.dts-optWrap{display:inline-flex;align-items:center}
.dts-optBtnWrap{position:relative;display:inline-flex}
.dts-optBtn{pointer-events:auto;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 8px;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:16px;cursor:pointer;transition:background-color .12s,color .12s}
.dts-optBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dts-optBtn:disabled{opacity:.45;cursor:default}
.dts-optBtn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-brand-primary)}
.dts-optIcon{width:14px;height:14px;flex:none}
.dts-optIcon svg{width:14px;height:14px;display:block;fill:currentColor}
/* Native title tooltips are slow to appear; a CSS bubble keyed on the same
   locale string is instant and follows the theme through the alias tokens.
   It opens upward above the row, right-aligned, matching the platform's
   own toolbar tooltip placement. */
.dts-optTip{position:absolute;bottom:calc(100% + 6px);right:0;width:max-content;max-width:280px;white-space:normal;padding:4px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);box-shadow:var(--dsw-elevation-soft);color:var(--dsw-alias-label-primary);font-size:11px;line-height:16px;text-align:left;pointer-events:none;opacity:0;transition:opacity .12s;z-index:20}
.dts-optBtnWrap:hover .dts-optTip,.dts-optBtnWrap:focus-within .dts-optTip{opacity:1}
/* The rewrite failure note renders beside the chip in the row, kept short. */
.dts-optError{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#d97706;font-size:11px;line-height:16px}
@media (max-width:820px){.dts-tr{grid-template-columns:minmax(0,1.3fr) repeat(4,minmax(0,.65fr)) 34px}.dts-tdPeak{display:none}}
.dts-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:16px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.dts-toolbarLabel{color:var(--dsw-alias-label-secondary);font-size:12px}
.dts-date{box-sizing:border-box;height:30px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.dts-date:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dts-sep{color:var(--dsw-alias-label-secondary);font-size:12px}
.dts-spacer{flex:1}
/* Seven presets plus two date fields is more than a narrow panel fits on one
   line, so the group wraps and the dates keep their own row rather than the
   buttons shrinking into unreadable stubs. */
.dts-presets{display:flex;flex-wrap:wrap;align-items:center;gap:4px}
.dts-presets .dts-btn{height:30px;padding:0 10px;font-size:12px}
.dts-presets .dts-btn[data-active=true]{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);color:var(--dsw-alias-label-primary)}
.dts-rangeHint{flex-basis:100%;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.dts-seg{display:inline-flex;padding:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base)}
.dts-seg button{min-width:38px;height:26px;padding:0 10px;border:1px solid transparent;border-radius:6px;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;transition:background-color .12s,color .12s}
.dts-seg button:hover{background:var(--dsw-alias-bg-layer-2)}
.dts-seg button[aria-pressed=true]{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);color:var(--dsw-alias-label-primary)}
.dts-seg button:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-brand-primary)}
.dts-stats{display:grid;gap:10px;margin-top:16px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.dts-stat{padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
/* A band-tinted card: the number is the signal, so the value takes the colour
   and the border only hints at it. Tinting the whole surface would make two
   adjacent cards fight, and the label would lose contrast on both. */
.dts-stat-peak .dts-statValue{color:var(--dsw-alias-state-error-primary)}
.dts-stat-peak{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 38%,var(--dsw-alias-border-l1))}
.dts-stat-offPeak .dts-statValue{color:var(--dsw-alias-state-success-primary)}
.dts-stat-offPeak{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 38%,var(--dsw-alias-border-l1))}
.dts-statLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dts-statValue{margin-top:4px;font-size:22px;font-weight:600;line-height:28px;font-variant-numeric:tabular-nums}
.dts-statHint{margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
/* The cost card's rule line prints both bands; each half keeps the colour the
   rest of the panel gives that band. The separator stays secondary so the two
   figures do not read as one long coloured string. */
.dts-hintPeak{color:var(--dsw-alias-state-error-primary)}
.dts-hintOffPeak{color:var(--dsw-alias-state-success-primary)}
.dts-hintSep{color:var(--dsw-alias-label-secondary)}
.dts-card{margin-top:16px;padding:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.dts-cardHead{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px}
.dts-cardTitle{margin:0;font-size:14px;font-weight:500;line-height:22px}
.dts-cardHint{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dts-legend{display:flex;align-items:center;gap:4px;color:var(--dsw-alias-label-secondary);font-size:11px}
.dts-heatScroll{margin-top:14px;overflow-x:auto;padding-bottom:4px}
.dts-heat{display:flex;gap:4px}
.dts-heatCol{display:grid;grid-auto-rows:13px;gap:3px}
.dts-heatMonth{display:grid;gap:6px;margin-top:14px;grid-template-columns:repeat(auto-fill,minmax(180px,1fr))}
.dts-month{padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base)}
.dts-monthLabel{margin-bottom:6px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.dts-monthGrid{display:grid;gap:3px;grid-template-columns:repeat(7,1fr)}
.dts-cell{border-radius:3px;background:var(--dsw-alias-bg-layer-2);transition:outline-color .1s}
.dts-cell[data-outside=false]{cursor:default;outline:1px solid transparent;outline-offset:1px}
.dts-cell[data-outside=false]:hover{outline-color:var(--dsw-alias-brand-primary)}
.dts-cell[data-level="1"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}
.dts-cell[data-level="2"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 34%,transparent)}
.dts-cell[data-level="3"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent)}
.dts-cell[data-level="4"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 76%,transparent)}
.dts-cell[data-level="5"]{background:var(--dsw-alias-brand-primary)}
/* Days outside the selected range stay blank: a faint fill would read as
   "zero usage" when the day is simply not part of the range. */
.dts-cell[data-outside=true]{background:transparent}
.dts-cell[data-outside=muted]{opacity:.4}
.dts-monthWeek{margin-bottom:3px;color:var(--dsw-alias-label-secondary);font-size:10px;line-height:14px;text-align:center}
.dts-chart{position:relative;margin-top:12px}
.dts-chart svg{display:block;width:100%;overflow:visible}
/* The hover card has a fixed width rather than a shrink-to-fit one: its left
   edge is computed from this number, so a card that grew with its content would
   shift under the pointer as the user moved between cells. */
.dts-tip{z-index:10;position:absolute;box-sizing:border-box;width:max-content;min-width:180px;max-width:280px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 8px 20px rgb(0 0 0 / 20%);pointer-events:none;font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;white-space:nowrap}
/* The heatmap wraps its grid in a scroller, so a tip laid out against the grid
   would be clipped by it. Anchoring it to the card keeps it above the scroll
   area and in the same coordinate space the trend chart's tip uses. */
.dts-heatWrap{position:relative}
.dts-tipTitle{margin-bottom:4px;color:var(--dsw-alias-label-secondary);font-size:11px}
.dts-tipRow{display:flex;align-items:center;justify-content:space-between;gap:14px}
.dts-tipRow strong{font-weight:600}
.dts-swatch{display:inline-block;width:8px;height:8px;margin-right:6px;border-radius:2px;background:var(--dsw-alias-brand-primary)}
/* Peak and off-peak carry one colour each everywhere they appear — the tip
   rows, the stat cards, the trend line — so the same two hues mean the same
   thing wherever the eye lands. Red is the expensive band, green the cheap one. */
.dts-swatchPeak{background:var(--dsw-alias-state-error-primary)}
.dts-swatchOffPeak{background:var(--dsw-alias-state-success-primary)}
.dts-tipPeak strong{color:var(--dsw-alias-state-error-primary)}
.dts-tipOffPeak strong{color:var(--dsw-alias-state-success-primary)}
.dts-models{margin-top:12px;display:flex;flex-direction:column;gap:8px}
.dts-model{display:flex;align-items:center;gap:12px;width:100%;box-sizing:border-box;padding:5px 7px;border:none;border-radius:7px;background:none;color:inherit;font:inherit;font-size:12px;text-align:left;cursor:pointer}
.dts-model:hover{background:var(--dsw-alias-bg-layer-1)}
.dts-model[data-focus=true]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent)}
.dts-model[data-focus=true] .dts-modelName{color:var(--dsw-alias-brand-primary)}
.dts-modelName{flex:none;width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.dts-modelBar{flex:1;height:8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.dts-modelFill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary)}
.dts-modelValue{flex:none;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dts-sessions{margin-top:12px;display:flex;flex-direction:column}
.dts-sessionHead{padding:0 8px 6px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
/* Inline-flex, not flex: the sort button has to stay an inline-level box so the
   cell's text-align:right can sit it at the end of a numeric column, which is
   where the numbers below it end. */
.dts-sessionHead button{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:0;padding:0;text-align:left;display:inline-flex;align-items:center;gap:4px;vertical-align:middle;font-size:11px;line-height:16px;white-space:nowrap}
.dts-sessionHead button:hover{color:var(--dsw-alias-label-primary)}
.dts-sessionHead button[data-active=true]{color:var(--dsw-alias-label-primary)}
.dts-sessionArrow{font-size:9px;line-height:1}
.dts-sessionList{max-height:320px;overflow-y:auto;display:flex;flex-direction:column}
/* The header and the rows are one grid, not two flex rows that happen to look
   alike. A flex row sizes its columns from their content, and the header's
   cells hold buttons (which carry their own padding) while the body's hold
   plain text — so the two rows resolved to different widths and the columns
   drifted apart. Declaring the tracks once here makes the header and every row
   below it share the same five widths by construction. */
.dts-sessionHead,.dts-sessionRow{display:grid;grid-template-columns:minmax(0,1fr) 86px 64px 96px 58px;align-items:center;column-gap:12px}
.dts-sessionRow{padding:7px 8px;border-bottom:.5px solid var(--dsw-alias-border-l1);font-size:12px;line-height:18px}
.dts-sessionRow:last-child{border-bottom:0}
.dts-sessionRow:hover{background:var(--dsw-alias-bg-layer-2)}
.dts-sessionName{min-width:0;display:flex;align-items:center;gap:6px}
.dts-sessionTitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.dts-sessionId{flex:none;color:var(--dsw-alias-label-secondary);font-size:10px;font-family:var(--ds-font-family-code);opacity:.7}
.dts-sessionTokens{text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.dts-sessionCalls{text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.dts-sessionCreated{text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.dts-sessionKind{text-align:right;color:var(--dsw-alias-label-secondary)}
.dts-tag{flex:none;align-self:flex-start;padding:0 5px;border-radius:4px;font-size:10px;line-height:16px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dts-tag[data-kind=archived]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 18%,transparent);color:var(--dsw-alias-state-warn-primary)}
.dts-tag[data-kind=subagent]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);color:var(--dsw-alias-brand-primary)}
.dts-sessionFoot{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px 8px 0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.dts-sessionFoot label{cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.dts-sessionFoot input{accent-color:var(--dsw-alias-brand-primary);cursor:pointer;margin:0}
.dts-sessionFootActions{display:flex;align-items:center;gap:14px}
.dts-treeToggle{flex:none;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;margin-right:2px;border:0;border-radius:4px;background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:9px;line-height:1}
.dts-treeToggle:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dts-treeToggle[data-empty=true]{visibility:hidden}
.dts-childRows{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 45%,transparent)}
/* The indent belongs to the name cell, not the row: padding the whole row would
   shift its grid tracks too and pull a child's numbers out from under the ones
   above them. */
.dts-childRow .dts-sessionName{padding-left:22px}
.dts-childRow .dts-sessionTitle{color:var(--dsw-alias-label-secondary)}
.dts-pager{display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:8px 8px 0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.dts-pager button{font:inherit;font-size:11px;line-height:16px;padding:3px 10px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer}
.dts-pager button:disabled{opacity:.4;cursor:default}
.dts-workspaces{margin-top:12px;display:flex;flex-direction:column;gap:8px}
.dts-workspace{display:flex;align-items:center;gap:12px;font-size:12px}
.dts-workspacePath{flex:none;width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);direction:rtl;text-align:left}
.dts-workspaceBar{flex:1;height:8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.dts-workspaceFill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary)}
.dts-workspaceValue{flex:none;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;font-size:11px}
@media (max-width:760px){.dts-sessionCreated,.dts-sessionKind{display:none}}
@media (max-width:760px){.dts-workspacePath{width:130px}}
.dts-state{margin-top:16px;padding:24px;border:1px dashed var(--dsw-alias-border-l1);border-radius:10px;color:var(--dsw-alias-label-secondary);text-align:center;font-size:13px}
.dts-state[data-tone=error]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dts-empty{margin-top:12px;padding:16px;color:var(--dsw-alias-label-secondary);text-align:center;font-size:12px}
.dts-footer{margin-top:16px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px}
@media (max-width:640px){.dts-modelName{width:110px}}
@media (prefers-reduced-motion:reduce){.dts-btn,.dts-seg button{transition:none}}
`;

    //#endregion

    //#region folding

    /**
     * Aggregate day or hour rows into the requested grain.
     *
     * Row layout is `[key, input, output, cacheRead, cacheWrite, total, calls,
     * cost, peakInput, peakOutput, peakCacheRead, peakCacheWrite, peakTotal,
     * peakCalls, peakCost]` — fifteen columns, because the key is the first and
     * the peak band mirrors the seven counters plus the cost. Cost is summed
     * like the counters: dropping it here would make the per-bucket money
     * vanish as soon as the user switched to a coarser grain, and the hover
     * readout would show a cost of zero for a week that spent plenty. The peak
     * block rides along for the same reason: the peak card filters by range,
     * and a grain change must not blank it.
     * @param rows - day or hour rows in the Host's layout.
     * @param grain - `hour`, `day`, `week`, `month` or `year`.
     * @returns the folded rows, sorted by key.
     */
    function foldGrain(rows, grain) {
      if (grain === "day" || grain === "hour") return rows;
      const buckets = new Map();
      for (const row of rows) {
        const key =
          grain === "week"
            ? dayKey(startOfWeek(parseDay(row[0])))
            : grain === "month"
              ? row[0].slice(0, 7)
              : row[0].slice(0, 4);
        let bucket = buckets.get(key);
        if (bucket === undefined) {
          bucket = new Array(15).fill(0);
          bucket[0] = key;
          buckets.set(key, bucket);
        }
        for (let index = 1; index <= 7; index += 1)
          bucket[index] += typeof row[index] === "number" ? row[index] : 0;
        for (let index = 8; index <= 13; index += 1)
          bucket[index] += typeof row[index] === "number" ? row[index] : 0;
        bucket[14] += typeof row[14] === "number" ? row[14] : 0;
      }
      return [...buckets.values()].sort((left, right) =>
        left[0] < right[0] ? -1 : 1,
      );
    }

    /** Every calendar day of the range, filled with its row (or a zero row). */
    function densify(rows, from, to) {
      const byDay = new Map(rows.map((row) => [row[0], row]));
      const out = [];
      for (
        let cursor = parseDay(from);
        dayKey(cursor) <= to;
        cursor = addDays(cursor, 1)
      ) {
        const key = dayKey(cursor);
        // A missing day is a real zero across every column, cost included, so
        // the hover readout reports 0 rather than falling through to a stale
        // value from the row that happens to sit at the same index elsewhere.
        out.push(
          byDay.get(key) ?? [key, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        );
      }
      return out;
    }

    /**
     * Every hour of an hour range, filled with its row (or a zero row).
     *
     * The hour twin of {@link densify}, so the trend chart can plot a "last 24
     * hours" range as 24 points including the quiet ones. Skipping the empty
     * hours would make the line jump straight from 09:00 to 21:00 and read as
     * continuous activity.
     * @param rows - hour rows, `[hour, …counters]`.
     * @param from - the first hour key, inclusive.
     * @param to - the last hour key, inclusive.
     * @returns one row per hour in the span.
     */
    function densifyHours(rows, from, to) {
      const byHour = new Map(rows.map((row) => [row[0], row]));
      const out = [];
      for (
        let cursor = parseHour(from);
        hourKey(cursor) <= to;
        cursor = addHours(cursor, 1)
      ) {
        const key = hourKey(cursor);
        out.push(
          byHour.get(key) ?? [key, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        );
      }
      return out;
    }

    /** Five bucket levels over the range's peak. */
    function levelOf(value, peak) {
      if (value <= 0) return 0;
      if (peak <= 0) return 1;
      const ratio = value / peak;
      if (ratio <= 0.1) return 1;
      if (ratio <= 0.28) return 2;
      if (ratio <= 0.52) return 3;
      if (ratio <= 0.78) return 4;
      return 5;
    }

    //#endregion

    //#region export

    /** Trigger a browser download for generated text. */
    function download(filename, text, mime) {
      const blob = new Blob([text], { type: mime });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    /**
     * Write the per-session table out as CSV.
     *
     * The rows honour the current date range, so what the user exports is what
     * the table shows; the cost column head names the currency so a price is
     * never read as a bare number.
     * @param sessions - the rows the session table holds.
     * @param from - inclusive start day, or "" for no bound.
     * @param to - inclusive end day, or "" for no bound.
     * @param currency - the currency label repeated in the cost column head.
     */
    function exportSessions(sessions, from, to, currency) {
      const head = [
        "session_id",
        "title",
        "kind",
        "archived",
        "parent_session_id",
        "workspace",
        "created_at",
        "tokens",
        "calls",
        `cost_${currency}`,
      ].join(",");
      const lines = sessions.map((row) =>
        [
          row.id,
          csvField(row.title),
          row.subagent ? "subagent" : "main",
          row.archived ? "yes" : "no",
          row.parent,
          csvField(row.cwd),
          row.createdAt === 0 ? "" : dayKey(new Date(row.createdAt)),
          String(row.total),
          String(row.calls),
          row.cost.toFixed(6),
        ].join(","),
      );
      const totals = sessions.reduce(
        (acc, row) => {
          acc.tokens += row.total;
          acc.calls += row.calls;
          acc.cost += row.cost;
          return acc;
        },
        { tokens: 0, calls: 0, cost: 0 },
      );
      lines.push(
        [
          "TOTAL",
          "",
          "",
          "",
          "",
          "",
          "",
          String(totals.tokens),
          String(totals.calls),
          totals.cost.toFixed(6),
        ].join(","),
      );
      const span = `${from === "" ? "start" : from}_${to === "" ? "end" : to}`;
      download(
        `token-stats-sessions-${span}.csv`,
        `\ufeff${head}\r\n${lines.join("\r\n")}\r\n`,
        "text/csv;charset=utf-8",
      );
    }

    /** Quote one CSV field. */
    function csvField(value) {
      const text = String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }

    //#endregion

    //#region atoms

    /** A segmented button group. */
    function Segmented({ options, value, onChange }) {
      return h(
        "div",
        { className: "dts-seg", role: "group" },
        options.map((option) =>
          h(
            "button",
            {
              key: option.id,
              type: "button",
              "aria-pressed": option.id === value,
              onClick: () => onChange(option.id),
            },
            option.label,
          ),
        ),
      );
    }

    /**
     * One headline number.
     *
     * `tone` names a billing band. A peak figure is printed in the same red the
     * trend line uses for peak segments and the same red the hover card's peak
     * row carries, so "expensive" is one colour across the whole panel rather
     * than a word the user has to read each time; off-peak is the matching
     * green. Neutral figures leave it undefined and inherit the normal ink.
     */
    function Stat({ label, value, hint, tone }) {
      return h(
        "div",
        {
          className:
            tone === undefined ? "dts-stat" : `dts-stat dts-stat-${tone}`,
        },
        h("div", { className: "dts-statLabel" }, label),
        h("div", { className: "dts-statValue" }, value),
        hint === undefined
          ? null
          : h("div", { className: "dts-statHint" }, hint),
      );
    }

    /**
     * The hover card both charts show.
     *
     * One component for both keeps the two readouts identical in structure,
     * spacing and typography — the requirement is that hovering a heatmap cell
     * and hovering the trend line feel like the same interaction, and sharing
     * the markup is what makes that true rather than merely similar.
     *
     * The card sizes itself to its content. It used to be a fixed 180px wide
     * with `overflow: hidden`, which silently clipped any number long enough to
     * matter — an uncached-input count of 117,469,xxx was cut to
     * "117,469," — so the width now follows the widest row and `max-width`
     * keeps a pathological one from running off the card. Because the width is
     * no longer known before layout, `bounds` gives the caller's container
     * width and a measured correction keeps the right edge inside it: `left`
     * stays the preferred edge, and the card is nudged left only when its
     * content would overflow.
     * @param props - the title, the rows, and the anchor plus container width.
     */
    const TIP_WIDTH = 180;

    function HoverCard({ title, rows, left, top, bounds }) {
      const ref = useRef(null);
      const [shift, setShift] = useState(0);
      useLayoutEffect(() => {
        const node = ref.current;
        if (node === null) return;
        const overflow = left + node.offsetWidth - (bounds ?? Infinity);
        setShift(overflow > 0 ? Math.ceil(overflow) : 0);
      });
      return h(
        "div",
        {
          className: "dts-tip",
          ref,
          style: { left: left - shift, top },
          role: "tooltip",
          "aria-hidden": "true",
        },
        h("div", { className: "dts-tipTitle" }, title),
        rows.map((row) =>
          h(
            "div",
            {
              key: row.label,
              className:
                row.tone === "peak"
                  ? "dts-tipRow dts-tipPeak"
                  : row.tone === "offPeak"
                    ? "dts-tipRow dts-tipOffPeak"
                    : "dts-tipRow",
            },
            h(
              "span",
              null,
              row.swatch === true
                ? h("span", { className: "dts-swatch" })
                : row.swatch === "peak"
                  ? h("span", { className: "dts-swatch dts-swatchPeak" })
                  : row.swatch === "offPeak"
                    ? h("span", { className: "dts-swatch dts-swatchOffPeak" })
                    : null,
              row.label,
            ),
            h("strong", null, row.value),
          ),
        ),
      );
    }

    /** Five-level legend. */
    function HeatLegend({ t }) {
      const cells = [0, 1, 2, 3, 4, 5].map((level) =>
        h("span", {
          key: level,
          className: "dts-cell",
          "data-level": level,
          style: { width: "11px", height: "11px" },
        }),
      );
      return h(
        "div",
        { className: "dts-legend" },
        h("span", null, t("heat.less")),
        cells,
        h("span", null, t("heat.more")),
      );
    }

    /** Rows rendered per page of session groups. */
    const SESSION_PAGE_SIZE = 40;

    /**
     * The zones and currencies the runtime actually supports, read from the
     * platform's own ICU data rather than a bundled list.
     *
     * A hard-coded table would rot: tzdata gains and renames zones, and a
     * currency that is not in the running `Intl` data would be a value this
     * build cannot format or validate. Asking `Intl` keeps the picker and the
     * validator on the same source of truth.
     */
    const ZONES = (() => {
      try {
        return Intl.supportedValuesOf("timeZone");
      } catch {
        return ["Asia/Shanghai", "UTC"];
      }
    })();

    /** ISO 4217 codes the runtime knows, as a plain list. */
    const CURRENCIES = (() => {
      try {
        return Intl.supportedValuesOf("currency");
      } catch {
        return ["CNY", "USD", "EUR", "JPY"];
      }
    })();

    /**
     * The zones offered above the alphabetical rest, ordered by how likely a
     * DeepSeek profile is to bill in them.
     */
    const COMMON_ZONES = [
      "Asia/Shanghai",
      "Asia/Hong_Kong",
      "Asia/Taipei",
      "Asia/Tokyo",
      "Asia/Seoul",
      "Asia/Singapore",
      "Asia/Bangkok",
      "Asia/Kolkata",
      "Asia/Dubai",
      "Europe/London",
      "Europe/Paris",
      "Europe/Berlin",
      "Europe/Moscow",
      "America/New_York",
      "America/Chicago",
      "America/Denver",
      "America/Los_Angeles",
      "America/Sao_Paulo",
      "Australia/Sydney",
      "Pacific/Auckland",
      "UTC",
    ];

    /** Currencies offered above the alphabetical rest. */
    const COMMON_CURRENCIES = [
      "CNY",
      "USD",
      "EUR",
      "JPY",
      "HKD",
      "TWD",
      "GBP",
      "KRW",
      "SGD",
      "AUD",
      "CAD",
      "CHF",
      "INR",
    ];

    /**
     * A display name for one zone, localized by the runtime.
     * @param zone - the IANA zone id.
     * @returns the long name, or the zone id when ICU has none.
     */
    function zoneLabel(zone) {
      try {
        const parts = new Intl.DateTimeFormat(undefined, {
          timeZone: zone,
          timeZoneName: "long",
        }).formatToParts(new Date());
        const name = parts.find((part) => part.type === "timeZoneName")?.value;
        return typeof name === "string" && name !== "" ? name : zone;
      } catch {
        return zone;
      }
    }

    /**
     * A display name for one currency, localized by the runtime.
     * @param code - the ISO 4217 code.
     * @returns the name, or the code when ICU has none.
     */
    function currencyLabel(code) {
      try {
        const name = new Intl.DisplayNames(undefined, {
          type: "currency",
        }).of(code);
        return typeof name === "string" && name !== "" ? name : code;
      } catch {
        return code;
      }
    }

    /**
     * Build the option list for one of the two pickers.
     *
     * Ordering is deliberate: the common entries come first because that is
     * what a user almost always wants, then everything else alphabetically by
     * code so the list is still scannable when filtered.
     * @param values - every supported value.
     * @param common - the values to promote, in display order.
     * @param labelOf - turns one value into its secondary display text.
     * @returns option records with a stable `value`, `label`, and `detail`.
     */
    function buildOptions(values, common, labelOf) {
      const known = new Set(values);
      const promoted = common.filter((value) => known.has(value));
      const promotedSet = new Set(promoted);
      const rest = values
        .filter((value) => !promotedSet.has(value))
        .sort((left, right) => (left < right ? -1 : 1));
      return [...promoted, ...rest].map((value) => ({
        value,
        label: labelOf(value),
        common: promotedSet.has(value),
      }));
    }

    /** Zone options, common first. */
    const ZONE_OPTIONS = buildOptions(ZONES, COMMON_ZONES, zoneLabel);
    /** Currency options, common first. */
    const CURRENCY_OPTIONS = buildOptions(
      CURRENCIES,
      COMMON_CURRENCIES,
      currencyLabel,
    );

    /**
     * A searchable single-choice picker.
     *
     * The list is a filtered view of the full set, so every option stays
     * reachable — the search box narrows, it never hides. Keyboard support is
     * limited to what a modal needs: Escape closes the popup without closing
     * the dialog, and Enter takes the highlighted row.
     */
    function SearchSelect({ options, value, onChange, t, placeholder }) {
      const [open, setOpen] = useState(false);
      const [query, setQuery] = useState("");
      const [active, setActive] = useState(0);
      const [placement, setPlacement] = useState(null);
      const wrapRef = useRef(null);
      const popRef = useRef(null);
      const inputRef = useRef(null);

      const selected = options.find((option) => option.value === value);

      const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (needle === "") return options;
        return options.filter(
          (option) =>
            option.value.toLowerCase().includes(needle) ||
            option.label.toLowerCase().includes(needle),
        );
      }, [options, query]);

      /**
       * Measure the trigger and choose a side.
       *
       * The list is portalled to document.body, so it must be positioned in
       * viewport coordinates. It also has to flip above the trigger when the
       * space below is too small, or the last options land off-screen — which
       * is exactly what happened inside the scrolled modal body.
       */
      const place = useCallback(() => {
        const trigger = wrapRef.current;
        if (trigger === null) return;
        const box = trigger.getBoundingClientRect();
        const gap = 4;
        const limit = Math.min(320, Math.round(window.innerHeight * 0.6));
        const below = window.innerHeight - box.bottom - gap;
        const above = box.top - gap;
        const flip = below < Math.min(limit, 160) && above > below;
        const height = Math.min(limit, Math.max(120, flip ? above : below));
        setPlacement({
          left: Math.round(box.left),
          width: Math.round(box.width),
          top: flip
            ? Math.max(8, Math.round(box.top - gap - height))
            : Math.round(box.bottom + gap),
          maxHeight: height,
        });
      }, []);

      useEffect(() => {
        if (!open) {
          setPlacement(null);
          return undefined;
        }
        place();
        // The popup is fixed, so any scroll or resize invalidates the measured
        // rectangle; re-measure instead of letting it drift away from the field.
        const onMove = () => place();
        document.addEventListener("scroll", onMove, true);
        window.addEventListener("resize", onMove);
        return () => {
          document.removeEventListener("scroll", onMove, true);
          window.removeEventListener("resize", onMove);
        };
      }, [open, place]);

      useEffect(() => {
        if (!open) return undefined;
        const onDown = (event) => {
          const inTrigger = wrapRef.current?.contains(event.target) === true;
          const inPop = popRef.current?.contains(event.target) === true;
          if (!inTrigger && !inPop) setOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        return () => document.removeEventListener("mousedown", onDown);
      }, [open]);

      useEffect(() => {
        if (open) inputRef.current?.focus();
      }, [open]);

      const take = (option) => {
        if (option === undefined) return;
        onChange(option.value);
        setOpen(false);
        setQuery("");
      };

      const trigger = h(
        "div",
        { className: "dts-selectWrap", ref: wrapRef },
        h(
          "button",
          {
            type: "button",
            className: "dts-select",
            "aria-haspopup": "listbox",
            "aria-expanded": open ? "true" : "false",
            onClick: () => {
              setOpen((current) => !current);
              setActive(0);
            },
          },
          h(
            "span",
            { className: "dts-selectValue" },
            selected === undefined ? value : selected.value,
          ),
          h(
            "span",
            { className: "dts-selectDetail" },
            selected === undefined ? t("settings.fieldEmpty") : selected.label,
          ),
          h("span", { className: "dts-selectCaret" }, "▾"),
        ),
      );

      // The popup lives outside the modal so no ancestor can clip it. A portal
      // to document.body is the only way to escape an overflow container while
      // keeping the field's own stacking and focus behaviour.
      const popup =
        open && placement !== null
          ? ReactDOM.createPortal(
              h(
                "div",
                {
                  ref: popRef,
                  className: "dts-pop",
                  style: {
                    left: placement.left,
                    width: placement.width,
                    top: placement.top,
                    maxHeight: placement.maxHeight,
                  },
                },
                h("input", {
                  ref: inputRef,
                  className: "dts-input dts-popSearch",
                  placeholder: placeholder ?? t("settings.search"),
                  value: query,
                  spellCheck: false,
                  onChange: (event) => {
                    setQuery(event.target.value);
                    setActive(0);
                  },
                  onKeyDown: (event) => {
                    if (event.key === "Escape") {
                      event.stopPropagation();
                      setOpen(false);
                      return;
                    }
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      setActive((current) =>
                        Math.min(current + 1, filtered.length - 1),
                      );
                      return;
                    }
                    if (event.key === "ArrowUp") {
                      event.preventDefault();
                      setActive((current) => Math.max(current - 1, 0));
                      return;
                    }
                    if (event.key === "Enter") {
                      event.preventDefault();
                      take(filtered[active]);
                    }
                  },
                }),
                h(
                  "div",
                  { className: "dts-popList", role: "listbox" },
                  filtered.length === 0
                    ? h(
                        "div",
                        { className: "dts-popEmpty" },
                        t("settings.noMatch"),
                      )
                    : filtered.map((option, index) =>
                        h(
                          "button",
                          {
                            key: option.value,
                            type: "button",
                            role: "option",
                            "aria-selected":
                              option.value === value ? "true" : "false",
                            className: "dts-popItem",
                            "data-common": option.common ? "true" : "false",
                            "data-active": index === active ? "true" : "false",
                            onMouseEnter: () => setActive(index),
                            onClick: () => take(option),
                          },
                          h("span", { className: "dts-popCode" }, option.value),
                          h(
                            "span",
                            { className: "dts-popLabel" },
                            option.label,
                          ),
                        ),
                      ),
                ),
              ),
              document.body,
            )
          : null;

      return h(React.Fragment, null, trigger, popup);
    }

    /**
     * The billing settings modal.
     *
     * It stays a plain overlay rather than a platform dialog because the Client
     * exposes no modal service; keeping it inside this panel also means it can
     * read and write the config through the same document-relative route the
     * rest of the panel already uses, with no new transport.
     *
     * The window edits the config by structure rather than by key: models,
     * peak schedules and holiday calendars each get their own section, because
     * a generic key/value editor cannot express a price row or a weekday set.
     * The draft is the whole config, so saving sends one document and the Host
     * validates it in one pass.
     */
    function SettingsModal({ onClose, onSaved, t, sessionId }) {
      const [doc, setDoc] = useState(null);
      const [draft, setDraft] = useState({});
      const [busy, setBusy] = useState(false);
      const [note, setNote] = useState(null);
      const [section, setSection] = useState("models");
      const [refreshing, setRefreshing] = useState(false);
      // One measurement per open, not per keystroke: the context tab is a
      // settings form, and re-measuring the whole surface on every edit would
      // make typing the prompt cost a session replay per character.
      const [pressure, setPressure] = useState(null);
      useEffect(() => {
        if (typeof sessionId !== "string" || sessionId === "") return undefined;
        let alive = true;
        api
          .contextPressure(sessionId)
          .then((value) => {
            if (alive) setPressure(value);
          })
          .catch(() => {
            if (alive) setPressure({ available: false, reason: "request-failed" });
          });
        return () => {
          alive = false;
        };
      }, [sessionId]);

      /**
       * Re-fetch every cached holiday year from the publishers.
       *
       * The Host owns the fetch and the cache, so this only asks for it and
       * takes the returned catalog: the modal re-renders from that response
       * instead of a second `config` round trip, which would re-read a cache
       * this call just rewrote.
       */
      const refreshHolidays = () => {
        if (refreshing) return;
        setRefreshing(true);
        api
          .holidays()
          .then((value) => {
            setDoc((current) =>
              current === null ? current : { ...current, ...value },
            );
            setNote({
              tone: "ok",
              text: value.changed
                ? t("settings.holidays.updated")
                : t("settings.holidays.unchanged"),
            });
          })
          .catch((error) =>
            setNote({ tone: "error", text: String(error.message) }),
          )
          .finally(() => setRefreshing(false));
      };

      useEffect(() => {
        let alive = true;
        api
          .config()
          .then((value) => {
            if (!alive) return;
            setDoc(value);
            // Start the draft from the normalized view so the form shows the
            // numbers the panel is actually charging, not the raw file.
            setDraft(value.value ?? value.override ?? {});
          })
          .catch((error) => {
            if (alive) setNote({ tone: "error", text: String(error.message) });
          });
        return () => {
          alive = false;
        };
      }, []);

      useEffect(() => {
        const onKey = (event) => {
          if (event.key === "Escape") onClose();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
      }, [onClose]);

      /**
       * The configuration as a shareable file.
       *
       * Only the billing knobs travel: time zone, currency, the per-model
       * prices, the peak schedules and the holiday calendars. Session data and
       * cache paths stay out, so a shared file carries no history.
       */
      const exportConfig = () => {
        const payload = {
          kind: "dsh-token-panorama/billing",
          version: 1,
          exportedAt: new Date().toISOString(),
          timeZone: draft.timeZone ?? doc?.value?.timeZone ?? "Asia/Shanghai",
          currency,
          models,
          defaultPrice: draft.defaultPrice ??
            doc?.value?.defaultPrice ?? {
              input: 2,
              cacheRead: 0.2,
              cacheWrite: 2,
              output: 8,
              peakProfile: "",
            },
          peakProfiles: profiles,
          holidays,
        };
        download(
          `token-stats-billing-${payload.currency}.json`,
          JSON.stringify(payload, null, 2),
          "application/json",
        );
      };

      /**
       * Read a shared configuration file into the draft.
       *
       * Import deliberately stops short of saving: the file came from another
       * machine, so the user gets to look at the prices before they replace
       * their own. A file that is not this plugin's billing document is
       * rejected with the parse error rather than half-applied.
       */
      const importConfig = (file) => {
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const parsed = JSON.parse(String(reader.result));
            if (parsed === null || typeof parsed !== "object")
              throw new Error(t("settings.importInvalid"));
            if (
              parsed.kind !== undefined &&
              parsed.kind !== "dsh-token-panorama/billing"
            )
              throw new Error(t("settings.importInvalid"));
            const next = {
              timeZone:
                typeof parsed.timeZone === "string" && parsed.timeZone !== ""
                  ? parsed.timeZone
                  : (draft.timeZone ?? "Asia/Shanghai"),
              currency:
                typeof parsed.currency === "string" && parsed.currency !== ""
                  ? parsed.currency
                  : currency,
              models:
                parsed.models && typeof parsed.models === "object"
                  ? parsed.models
                  : {},
              defaultPrice:
                parsed.defaultPrice && typeof parsed.defaultPrice === "object"
                  ? parsed.defaultPrice
                  : (draft.defaultPrice ?? {
                      input: 2,
                      cacheRead: 0.2,
                      cacheWrite: 2,
                      output: 8,
                      peakProfile: "",
                    }),
              peakProfiles:
                parsed.peakProfiles && typeof parsed.peakProfiles === "object"
                  ? parsed.peakProfiles
                  : {},
              holidays: Array.isArray(parsed.holidays)
                ? parsed.holidays.filter((key) => typeof key === "string")
                : [],
            };
            setDraft(next);
            setNote({
              tone: "ok",
              text: t("settings.importDone").replace(
                "{models}",
                String(Object.keys(next.models).length),
              ),
            });
          } catch (error) {
            setNote({
              tone: "error",
              text: t("settings.importFailed").replace(
                "{error}",
                String(error.message),
              ),
            });
          }
        };
        reader.onerror = () =>
          setNote({
            tone: "error",
            text: t("settings.importFailed").replace(
              "{error}",
              t("settings.readError"),
            ),
          });
        reader.readAsText(file);
      };

      const save = async () => {
        setBusy(true);
        setNote(null);
        try {
          const result = await api.saveConfig(draft);
          setDoc(result);
          setDraft(result.value ?? result.override ?? {});
          setNote({ tone: "ok", text: t("settings.saved") });
          onSaved();
        } catch (error) {
          setNote({ tone: "error", text: error.message });
        } finally {
          setBusy(false);
        }
      };

      const editable = doc?.editable === true;
      const currency =
        typeof draft.currency === "string" && draft.currency !== ""
          ? draft.currency
          : (doc?.currency ?? "CNY");
      // `doc.value` is the Host's normalized view; it already contains any
      // migrated legacy prices, so reading it first keeps an upgrade from
      // showing empty inputs over the user's real numbers.
      const profiles = draft.peakProfiles ?? doc?.value?.peakProfiles ?? {};
      const models = draft.models ?? doc?.value?.models ?? {};
      const holidays = draft.holidays ?? doc?.value?.holidays ?? [];

      /**
       * The rows the model table shows: every observed model plus every
       * configured one, so a model seen in the logs has a row ready to price
       * and a configured model never disappears just because it went quiet.
       */
      const modelRows = useMemo(() => {
        const seen = new Map();
        for (const entry of doc?.observed ?? []) {
          seen.set(entry.model, {
            model: entry.model,
            total: entry.total,
            calls: entry.calls,
          });
        }
        for (const name of Object.keys(models)) {
          if (!seen.has(name))
            seen.set(name, { model: name, total: 0, calls: 0 });
        }
        return [...seen.values()].sort((left, right) => {
          if (left.total !== right.total) return right.total - left.total;
          return left.model < right.model ? -1 : 1;
        });
      }, [doc, models]);

      // Every draft mutator derives from the state the updater receives. A
      // handler that closed over `models` would drop an edit whenever two
      // changes land in one batch (two ticks, or typing while a rename waits).
      const patchModel = (name, patch) =>
        setDraft((current) => {
          const table = current.models ?? models;
          return {
            ...current,
            models: {
              ...table,
              [name]: { ...(table[name] ?? EMPTY_MODEL_ROW), ...patch },
            },
          };
        });

      const setModels = (next) =>
        setDraft((current) => ({ ...current, models: next }));

      const patchProfile = (name, patch) =>
        setDraft((current) => {
          const table = current.peakProfiles ?? profiles;
          return {
            ...current,
            peakProfiles: {
              ...table,
              [name]: { ...(table[name] ?? EMPTY_PROFILE), ...patch },
            },
          };
        });

      const setProfiles = (next) =>
        setDraft((current) => ({ ...current, peakProfiles: next }));

      const toggleHoliday = (key, on) => {
        // Derive the next list from the state the updater receives, never from
        // the `holidays` this render closed over: two ticks in one batch would
        // otherwise both start from the same stale array and the first one's
        // selection would be dropped.
        setDraft((current) => {
          const list = Array.isArray(current.holidays)
            ? current.holidays
            : holidays;
          const rest = list.filter((entry) => entry !== key);
          return { ...current, holidays: on ? [...rest, key] : rest };
        });
      };

      const profileNames = Object.keys(profiles);

      const tabs = [
        ["models", "settings.tab.models"],
        ["peaks", "settings.tab.peaks"],
        ["holidays", "settings.tab.holidays"],
        ["context", "settings.tab.context"],
        ["optimizer", "settings.tab.optimizer"],
        ["general", "settings.tab.general"],
      ];

      return h(
        "div",
        {
          className: "dts-modalBackdrop",
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onClose();
          },
        },
        h(
          "div",
          {
            className: "dts-modal dts-modalWide",
            role: "dialog",
            "aria-modal": "true",
            "aria-label": t("settings.title"),
          },
          h(
            "div",
            { className: "dts-modalHead" },
            h(
              "div",
              { className: "dts-modalHeadText" },
              h("h2", { className: "dts-modalTitle" }, t("settings.title")),
              h(
                "p",
                { className: "dts-modalHint" },
                editable ? t("settings.hint") : t("settings.readonly"),
              ),
            ),
            h(
              "button",
              {
                type: "button",
                className: "dts-modalClose",
                onClick: onClose,
                title: t("settings.close"),
                "aria-label": t("settings.close"),
              },
              "✕",
            ),
          ),
          doc === null
            ? h("div", { className: "dts-state" }, t("settings.loading"))
            : h(
                React.Fragment,
                null,
                h(
                  "div",
                  { className: "dts-tabs", role: "tablist" },
                  tabs.map(([id, key]) =>
                    h(
                      "button",
                      {
                        key: id,
                        type: "button",
                        role: "tab",
                        "aria-selected": section === id ? "true" : "false",
                        className: "dts-tab",
                        onClick: () => setSection(id),
                      },
                      t(key),
                    ),
                  ),
                ),
                h(
                  "div",
                  { className: "dts-modalBody" },
                  section === "models"
                    ? h(ModelTable, {
                        rows: modelRows,
                        models,
                        profiles,
                        currency,
                        editable,
                        t,
                        onPatch: patchModel,
                        onRemove: (name) => {
                          const next = { ...models };
                          delete next[name];
                          setModels(next);
                        },
                        onAdd: (name) => patchModel(name, EMPTY_MODEL_ROW),
                      })
                    : null,
                  section === "peaks"
                    ? h(PeakEditor, {
                        profiles,
                        profileNames,
                        editable,
                        t,
                        onPatch: patchProfile,
                        onAdd: () => {
                          let name = "profile";
                          let index = 1;
                          while (profiles[name] !== undefined) {
                            index += 1;
                            name = `profile${index}`;
                          }
                          setProfiles({
                            ...profiles,
                            [name]: EMPTY_PROFILE,
                          });
                        },
                        onRemove: (name) => {
                          const next = { ...profiles };
                          delete next[name];
                          setProfiles(next);
                        },
                        onRename: (from, to) => {
                          if (to === "" || to === from) return;
                          if (profiles[to] !== undefined) return;
                          const next = {};
                          for (const [key, value] of Object.entries(profiles))
                            next[key === from ? to : key] = value;
                          setProfiles(next);
                          // Models pointing at the old name follow the rename,
                          // otherwise renaming would silently unpair them.
                          const nextModels = {};
                          for (const [name, row] of Object.entries(models)) {
                            nextModels[name] =
                              row.peakProfile === from
                                ? { ...row, peakProfile: to }
                                : row;
                          }
                          setModels(nextModels);
                        },
                      })
                    : null,
                  section === "holidays"
                    ? h(HolidayPicker, {
                        sets: doc.holidaySets ?? [],
                        years: doc.holidayYears ?? [],
                        enabled: holidays,
                        editable,
                        t,
                        onToggle: toggleHoliday,
                        onRefresh: refreshHolidays,
                        refreshing,
                      })
                    : null,
                  section === "optimizer"
                    ? h(OptimizerTab, {
                        draft,
                        doc,
                        editable,
                        t,
                        onPatch: (patch) =>
                          setDraft((current) => ({ ...current, ...patch })),
                      })
                    : null,
                  section === "general"
                    ? h(GeneralTab, {
                        draft,
                        doc,
                        editable,
                        t,
                        onCurrency: (next) =>
                          setDraft((current) => ({
                            ...current,
                            currency: next,
                          })),
                        onZone: (next) =>
                          setDraft((current) => ({
                            ...current,
                            timeZone: next,
                          })),
                        onPatch: (patch) =>
                          setDraft((current) => ({ ...current, ...patch })),
                      })
                    : null,
                  section === "context"
                    ? h(ContextTab, {
                        draft,
                        doc,
                        editable,
                        t,
                        pressure,
                        onPatch: (patch) =>
                          setDraft((current) => ({ ...current, ...patch })),
                      })
                    : null,
                ),
              ),
          h(
            "div",
            { className: "dts-modalFoot" },
            h(
              "span",
              {
                className: "dts-modalNote",
                "data-tone": note?.tone ?? "",
              },
              note?.text ?? t("settings.inherited"),
            ),
            h(
              "div",
              { className: "dts-actions" },
              // Import and export live next to Reset because they also act on
              // the whole form rather than on one tab.
              h(
                "button",
                {
                  type: "button",
                  className: "dts-btn",
                  disabled: busy,
                  title: t("settings.exportHint"),
                  onClick: exportConfig,
                },
                t("settings.export"),
              ),
              h(
                "label",
                {
                  className: "dts-btn",
                  title: t("settings.importHint"),
                  "data-disabled": busy ? "true" : "false",
                  style: {
                    display: "inline-flex",
                    alignItems: "center",
                    cursor: busy ? "not-allowed" : "pointer",
                  },
                },
                t("settings.import"),
                h("input", {
                  type: "file",
                  accept: "application/json,.json",
                  style: { display: "none" },
                  disabled: busy,
                  onChange: (event) => {
                    const file = event.target.files?.[0];
                    if (file !== undefined) importConfig(file);
                    // Clear the value so picking the same file twice re-runs.
                    event.target.value = "";
                  },
                }),
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "dts-btn",
                  disabled: !editable || busy,
                  onClick: () => {
                    // "Reset" clears the override, so the form falls back to
                    // the defaults the Host ships rather than to an empty form.
                    setDraft({
                      timeZone: "Asia/Shanghai",
                      currency: "CNY",
                      models: {},
                      defaultPrice: {
                        input: 2,
                        cacheRead: 0.2,
                        cacheWrite: 2,
                        output: 8,
                        peakProfile: "",
                      },
                      peakProfiles: {},
                      holidays: ["cn-2026"],
                    });
                    setNote(null);
                  },
                },
                t("settings.reset"),
              ),
              h(
                "button",
                { type: "button", className: "dts-btn", onClick: onClose },
                t("settings.cancel"),
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "dts-btn",
                  "data-primary": "true",
                  disabled: !editable || busy,
                  onClick: save,
                },
                busy ? t("settings.saving") : t("settings.save"),
              ),
            ),
          ),
        ),
      );
    }

    /**
     * A blank model row, used when a row is created from the table.
     *
     * Four rates rather than three: a provider charges separately for input it
     * reads from its cache, input it has to read fresh, and input it has to
     * write into that cache, and collapsing any two of them into one number
     * misprices exactly the sessions that are cheap (or expensive) because of
     * caching. A zero rate means the provider does not bill that item.
     */
    const EMPTY_MODEL_ROW = {
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      peakProfile: "",
    };

    /** A blank peak schedule. */
    const EMPTY_PROFILE = {
      mode: "weekdays",
      windows: [{ start: "09:00", end: "18:00" }],
      weekdays: [1, 2, 3, 4, 5],
      offPeakRatio: 0.5,
    };

    /**
     * The model price table.
     *
     * Each row is one model with three editable prices, then a delete button,
     * then the peak toggle in the last column — matching the requirement that
     * the toggle sits at the end of the row. A model the logs show but the
     * config does not price yet gets an "add price" button in the first price
     * cell rather than a disabled row, so the table doubles as a discovery
     * list of what is actually being billed.
     */
    function ModelTable({
      rows,
      models,
      profiles,
      currency,
      editable,
      t,
      onPatch,
      onRemove,
      onAdd,
    }) {
      const [adding, setAdding] = useState("");
      const profileNames = Object.keys(profiles);

      const priceInput = (model, row, field) =>
        h("input", {
          className: "dts-cellInput",
          type: "number",
          min: "0",
          step: "0.0001",
          // The four rates mean different things to a provider's bill, and a
          // bare column heading is not enough to tell "input" from "cache
          // read". The description rides on the control itself so it is
          // readable while the cursor is in the field.
          title: t(`settings.models.${field}Hint`),
          value:
            row?.[field] === undefined || row?.[field] === null
              ? ""
              : String(row[field]),
          disabled: !editable,
          "aria-label": `${model} ${t("settings.models." + field)}`,
          onChange: (event) => {
            const raw = event.target.value;
            if (raw === "") {
              onPatch(model, { [field]: 0 });
              return;
            }
            const parsed = Number(raw);
            onPatch(model, { [field]: Number.isFinite(parsed) ? parsed : 0 });
          },
        });

      return h(
        "div",
        { className: "dts-section" },
        h(
          "div",
          { className: "dts-sectionHead" },
          h(
            "h3",
            { className: "dts-sectionTitle" },
            t("settings.models.title"),
          ),
          h("p", { className: "dts-sectionHint" }, t("settings.models.hint")),
        ),
        h(
          "div",
          { className: "dts-table" },
          h(
            "div",
            { className: "dts-tr dts-trHead" },
            h(
              "div",
              { className: "dts-td dts-tdName" },
              t("settings.models.model"),
            ),
            h(
              "div",
              { className: "dts-td" },
              t("settings.models.input"),
              h("span", { className: "dts-unit" }, `/1M ${currency}`),
            ),
            h(
              "div",
              { className: "dts-td" },
              t("settings.models.cacheRead"),
              h("span", { className: "dts-unit" }, `/1M ${currency}`),
            ),
            h(
              "div",
              { className: "dts-td" },
              t("settings.models.cacheWrite"),
              h("span", { className: "dts-unit" }, `/1M ${currency}`),
            ),
            h(
              "div",
              { className: "dts-td" },
              t("settings.models.output"),
              h("span", { className: "dts-unit" }, `/1M ${currency}`),
            ),
            h(
              "div",
              { className: "dts-td dts-tdPeak" },
              t("settings.models.peak"),
            ),
            h("div", { className: "dts-td dts-tdAct" }),
          ),
          rows.length === 0
            ? h(
                "div",
                { className: "dts-tableEmpty" },
                t("settings.models.empty"),
              )
            : rows.map((entry) => {
                const row = models[entry.model];
                // A model can name a schedule that no longer exists — deleting
                // one leaves its references behind. Showing the toggle as "on"
                // for such a row would claim a discount the Host is not
                // applying, so a dangling reference reads as off.
                const dangling =
                  typeof row?.peakProfile === "string" &&
                  row.peakProfile !== "" &&
                  profiles[row.peakProfile] === undefined;
                const enabled =
                  typeof row?.peakProfile === "string" &&
                  row.peakProfile !== "" &&
                  !dangling;
                return h(
                  "div",
                  { key: entry.model, className: "dts-tr" },
                  h(
                    "div",
                    { className: "dts-td dts-tdName" },
                    h("span", { className: "dts-modelName" }, entry.model),
                    row === undefined
                      ? h(
                          "span",
                          { className: "dts-tag", "data-kind": "subagent" },
                          t("settings.models.unpriced"),
                        )
                      : null,
                    h(
                      "span",
                      { className: "dts-modelUsage" },
                      formatCompact(entry.total),
                    ),
                  ),
                  h(
                    "div",
                    { className: "dts-td" },
                    row === undefined
                      ? h(
                          "button",
                          {
                            type: "button",
                            className: "dts-btn dts-btnSmall",
                            disabled: !editable,
                            onClick: () => onAdd(entry.model),
                          },
                          t("settings.models.addRow"),
                        )
                      : priceInput(entry.model, row, "input"),
                  ),
                  h(
                    "div",
                    { className: "dts-td" },
                    row === undefined
                      ? null
                      : priceInput(entry.model, row, "cacheRead"),
                  ),
                  h(
                    "div",
                    { className: "dts-td" },
                    row === undefined
                      ? null
                      : priceInput(entry.model, row, "cacheWrite"),
                  ),
                  h(
                    "div",
                    { className: "dts-td" },
                    row === undefined
                      ? null
                      : priceInput(entry.model, row, "output"),
                  ),
                  h(
                    "div",
                    { className: "dts-td dts-tdPeak" },
                    row === undefined
                      ? null
                      : h(
                          "label",
                          { className: "dts-switch" },
                          h("input", {
                            type: "checkbox",
                            checked: enabled,
                            disabled: !editable || profileNames.length === 0,
                            onChange: (event) => {
                              // Turning the toggle on must pick a schedule that
                              // exists, else the row would look enabled while
                              // the Host keeps billing it flat.
                              const next = event.target.checked
                                ? row.peakProfile !== "" &&
                                  profiles[row.peakProfile] !== undefined
                                  ? row.peakProfile
                                  : (profileNames[0] ?? "")
                                : "";
                              onPatch(entry.model, { peakProfile: next });
                            },
                          }),
                          h(
                            "span",
                            null,
                            enabled ? t("settings.on") : t("settings.off"),
                          ),
                        ),
                    row !== undefined && enabled && profileNames.length > 0
                      ? h(
                          "select",
                          {
                            className: "dts-cellSelect",
                            value: row.peakProfile,
                            disabled: !editable,
                            "aria-label": `${entry.model} ${t("settings.peaks.aria")}`,
                            onChange: (event) =>
                              onPatch(entry.model, {
                                peakProfile: event.target.value,
                              }),
                          },
                          profileNames.map((name) =>
                            h("option", { key: name, value: name }, name),
                          ),
                        )
                      : // An off row still offers the picker when it names a
                        // deleted schedule: without it the user cannot re-point
                        // the model, and the row would stay un-billable.
                        row !== undefined && dangling && profileNames.length > 0
                        ? h(
                            "select",
                            {
                              className: "dts-cellSelect",
                              value: "",
                              disabled: !editable,
                              "aria-label": `${entry.model} ${t("settings.peaks.aria")}`,
                              onChange: (event) => {
                                if (event.target.value === "") return;
                                onPatch(entry.model, {
                                  peakProfile: event.target.value,
                                });
                              },
                            },
                            h(
                              "option",
                              { value: "" },
                              t("settings.models.missingSchedule"),
                            ),
                            profileNames.map((name) =>
                              h("option", { key: name, value: name }, name),
                            ),
                          )
                        : null,
                  ),
                  h(
                    "div",
                    { className: "dts-td dts-tdAct" },
                    row === undefined
                      ? null
                      : h(
                          "button",
                          {
                            type: "button",
                            className: "dts-iconBtn",
                            title: t("settings.remove"),
                            disabled: !editable,
                            onClick: () => onRemove(entry.model),
                          },
                          "✕",
                        ),
                  ),
                );
              }),
        ),
        h(
          "div",
          { className: "dts-addRow" },
          h("input", {
            className: "dts-input dts-addInput",
            placeholder: t("settings.models.addPlaceholder"),
            value: adding,
            disabled: !editable,
            onChange: (event) => setAdding(event.target.value),
          }),
          h(
            "button",
            {
              type: "button",
              className: "dts-btn dts-btnSmall",
              disabled: !editable || adding.trim() === "",
              onClick: () => {
                onAdd(adding.trim());
                setAdding("");
              },
            },
            t("settings.models.add"),
          ),
        ),
      );
    }

    /**
     * A peak schedule's name field.
     *
     * The typed text is held locally and committed on blur or Enter. Committing
     * on every keystroke would rename the profile — and therefore rebuild the
     * schedule table — mid-word, which is what made the field lose focus after
     * each character. Keeping the buffer here lets the user type a whole name
     * and have the rename happen once, when they are done.
     */
    function ProfileNameInput({ name, disabled, label, onCommit }) {
      const [text, setText] = useState(name);
      const [focused, setFocused] = useState(false);

      // Follow an external rename (a save reload, or the row being reused for
      // a different schedule) unless the user is mid-edit.
      useEffect(() => {
        if (!focused) setText(name);
      }, [name, focused]);

      const commit = () => {
        const next = text.trim();
        if (next === "" || next === name) {
          setText(name);
          return;
        }
        onCommit(next);
      };

      return h("input", {
        className: "dts-input dts-profileName",
        value: text,
        disabled,
        "aria-label": label,
        onFocus: () => setFocused(true),
        onChange: (event) => setText(event.target.value),
        onBlur: () => {
          setFocused(false);
          commit();
        },
        onKeyDown: (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            setText(name);
            event.currentTarget.blur();
          }
        },
      });
    }

    /**
     * One peak schedule's editor: a mode picker plus the fields that mode needs.
     *
     * Showing only the relevant fields keeps the form honest — a `workdays`
     * schedule has no weekday list to edit, and a `custom` one does.
     */
    function PeakEditor({
      profiles,
      profileNames,
      editable,
      t,
      onPatch,
      onAdd,
      onRemove,
      onRename,
    }) {
      const modes = [
        ["everyday", "settings.mode.everyday"],
        ["workday", "settings.mode.workday"],
        ["holiday", "settings.mode.holiday"],
        ["weekdays", "settings.mode.weekdays"],
        ["custom", "settings.mode.custom"],
      ];
      return h(
        "div",
        { className: "dts-section" },
        h(
          "div",
          { className: "dts-sectionHead" },
          h("h3", { className: "dts-sectionTitle" }, t("settings.peaks.title")),
          h("p", { className: "dts-sectionHint" }, t("settings.peaks.hint")),
        ),
        profileNames.length === 0
          ? h("p", { className: "dts-empty" }, t("settings.peaks.empty"))
          : profileNames.map((name, rowIndex) => {
              const profile = profiles[name] ?? EMPTY_PROFILE;
              const custom = profile.mode === "custom";
              // Keyed by position, not by name: renaming a schedule must not
              // remount this row, which would drop focus after every keystroke.
              return h(
                "div",
                { key: rowIndex, className: "dts-profile" },
                h(
                  "div",
                  { className: "dts-profileHead" },
                  h(ProfileNameInput, {
                    name,
                    disabled: !editable,
                    label: t("settings.peaks.name"),
                    onCommit: (next) => onRename(name, next),
                  }),
                  h(
                    "select",
                    {
                      className: "dts-cellSelect dts-modeSelect",
                      value: profile.mode,
                      disabled: !editable,
                      onChange: (event) =>
                        onPatch(name, { mode: event.target.value }),
                    },
                    modes.map(([value, key]) =>
                      h("option", { key: value, value }, t(key)),
                    ),
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      className: "dts-iconBtn",
                      title: t("settings.remove"),
                      disabled: !editable,
                      onClick: () => onRemove(name),
                    },
                    "✕",
                  ),
                ),
                // One row per peak window. A provider may split its peak band
                // (DeepSeek bills 09-12 and 14-18 with a cheaper lunch break),
                // so the schedule holds a list and each row edits one entry.
                h(
                  "div",
                  { className: "dts-windowList" },
                  h(
                    "span",
                    { className: "dts-label" },
                    t("settings.peaks.windows"),
                  ),
                  (profile.windows ?? []).map((window, index) =>
                    h(
                      "div",
                      { key: index, className: "dts-windowRow" },
                      h("input", {
                        className: "dts-input",
                        type: "time",
                        value: window.start,
                        disabled: !editable,
                        "aria-label": t("settings.peaks.start"),
                        onChange: (event) => {
                          const next = (profile.windows ?? []).map(
                            (entry, i) =>
                              i === index
                                ? { ...entry, start: event.target.value }
                                : entry,
                          );
                          onPatch(name, { windows: next });
                        },
                      }),
                      h("span", { className: "dts-windowDash" }, "–"),
                      h("input", {
                        className: "dts-input",
                        type: "time",
                        value: window.end,
                        disabled: !editable,
                        "aria-label": t("settings.peaks.end"),
                        onChange: (event) => {
                          const next = (profile.windows ?? []).map(
                            (entry, i) =>
                              i === index
                                ? { ...entry, end: event.target.value }
                                : entry,
                          );
                          onPatch(name, { windows: next });
                        },
                      }),
                      h(
                        "button",
                        {
                          type: "button",
                          className: "dts-iconBtn",
                          title: t("settings.remove"),
                          disabled: !editable,
                          onClick: () =>
                            onPatch(name, {
                              windows: (profile.windows ?? []).filter(
                                (_, i) => i !== index,
                              ),
                            }),
                        },
                        "✕",
                      ),
                    ),
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      className: "dts-btn dts-btnSmall",
                      disabled: !editable,
                      onClick: () =>
                        onPatch(name, {
                          windows: [
                            ...(profile.windows ?? []),
                            { start: "09:00", end: "18:00" },
                          ],
                        }),
                    },
                    t("settings.peaks.addWindow"),
                  ),
                ),
                h(
                  "div",
                  { className: "dts-profileGrid" },
                  h(
                    "label",
                    { className: "dts-labeled" },
                    h(
                      "span",
                      { className: "dts-label" },
                      t("settings.peaks.ratio"),
                    ),
                    h("input", {
                      className: "dts-input",
                      type: "number",
                      min: "0.01",
                      max: "1",
                      step: "0.05",
                      value: String(profile.offPeakRatio ?? 0.5),
                      disabled: !editable,
                      onChange: (event) => {
                        const parsed = Number(event.target.value);
                        onPatch(name, {
                          offPeakRatio: Number.isFinite(parsed) ? parsed : 0.5,
                        });
                      },
                    }),
                  ),
                  h(
                    "label",
                    { className: "dts-labeled" },
                    h(
                      "span",
                      { className: "dts-label" },
                      t("settings.peaks.ratioHint"),
                    ),
                    h(
                      "span",
                      { className: "dts-ratioValue" },
                      `${Math.round((profile.offPeakRatio ?? 0.5) * 100 * 100) / 100}%`,
                    ),
                  ),
                ),
                custom
                  ? h(
                      "div",
                      { className: "dts-weekdays" },
                      h(
                        "span",
                        { className: "dts-label" },
                        t("settings.peaks.weekdays"),
                      ),
                      h(
                        "div",
                        { className: "dts-weekdayRow" },
                        ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map(
                          (key, index) => {
                            const day = index + 1;
                            const on = (profile.weekdays ?? []).includes(day);
                            return h(
                              "label",
                              {
                                key,
                                className: "dts-weekday",
                                "data-on": on ? "true" : "false",
                              },
                              h("input", {
                                type: "checkbox",
                                checked: on,
                                disabled: !editable,
                                onChange: (event) => {
                                  const rest = (profile.weekdays ?? []).filter(
                                    (entry) => entry !== day,
                                  );
                                  onPatch(name, {
                                    weekdays: event.target.checked
                                      ? [...rest, day].sort((a, b) => a - b)
                                      : rest,
                                  });
                                },
                              }),
                              t(`heat.weekday.${key}`),
                            );
                          },
                        ),
                      ),
                    )
                  : null,
              );
            }),
        h(
          "button",
          {
            type: "button",
            className: "dts-btn dts-btnSmall",
            disabled: !editable,
            onClick: onAdd,
          },
          t("settings.peaks.add"),
        ),
      );
    }

    /**
     * The holiday categories as checkboxes, with the years behind each one.
     *
     * A category spans every year the Host has fetched, so enabling it once
     * keeps applying as the next year's dates arrive. The per-year counts are
     * shown rather than asserted: a category reading "0 days" is a year the
     * publisher has not released yet, not a broken calendar, and saying so
     * stops the user ticking a box that cannot bill anything today.
     */
    function HolidayPicker({
      sets,
      years,
      enabled,
      editable,
      t,
      onToggle,
      onRefresh,
      refreshing,
    }) {
      const loaded = (years ?? []).filter((year) => year.published).length;
      return h(
        "div",
        { className: "dts-section" },
        h(
          "div",
          { className: "dts-sectionHead" },
          h(
            "h3",
            { className: "dts-sectionTitle" },
            t("settings.holidays.title"),
          ),
          h("p", { className: "dts-sectionHint" }, t("settings.holidays.hint")),
        ),
        h(
          "p",
          { className: "dts-sectionHint" },
          loaded > 0
            ? t("settings.holidays.years").replace("{years}", String(loaded))
            : t("settings.holidays.pending"),
        ),
        sets.map((set) => {
          const on = enabled.includes(set.key);
          const detail = (set.years ?? [])
            .map((entry) => `${entry.year}: ${formatInt(entry.days)}`)
            .join(" · ");
          return h(
            "label",
            { key: set.key, className: "dts-holidayRow" },
            h("input", {
              type: "checkbox",
              checked: on,
              disabled: !editable,
              onChange: (event) => onToggle(set.key, event.target.checked),
            }),
            h(
              "span",
              { className: "dts-holidayName" },
              t(`settings.holidaySet.${set.key}`),
              detail === ""
                ? null
                : h("span", { className: "dts-holidayYears" }, detail),
            ),
            h(
              "span",
              { className: "dts-holidayDays" },
              t("settings.holidays.days").replace(
                "{count}",
                formatInt(set.days),
              ),
            ),
          );
        }),
        h(
          "div",
          { className: "dts-holidayActions" },
          h(
            "button",
            {
              type: "button",
              className: "dts-btn",
              disabled: refreshing === true,
              onClick: onRefresh,
            },
            refreshing === true ? "…" : t("settings.holidays.refresh"),
          ),
        ),
      );
    }

    /**
     * The general tab: the two enumerable settings that decide the cost
     * estimate. The prompt-optimizer fields moved to their own tab, which
     * mirrors the context tab's shape — one instruction textarea, two catalog
     * pickers — because the two features share one mental model ("what the
     * plugin sends to a model on your behalf"); only the config keys differ.
     */
    function GeneralTab({ draft, doc, editable, t, onCurrency, onZone }) {
      const zone =
        typeof draft.timeZone === "string" && draft.timeZone !== ""
          ? draft.timeZone
          : (doc?.timeZone ?? "Asia/Shanghai");
      const currency =
        typeof draft.currency === "string" && draft.currency !== ""
          ? draft.currency
          : (doc?.currency ?? "CNY");
      return h(
        "div",
        { className: "dts-section" },
        h(
          "div",
          { className: "dts-field" },
          h(
            "div",
            { className: "dts-fieldHead" },
            h(
              "span",
              { className: "dts-fieldKey" },
              t("settings.field.timeZone"),
            ),
          ),
          h(
            "p",
            { className: "dts-fieldDesc" },
            t("settings.fieldDesc.timeZone"),
          ),
          h(SearchSelect, {
            options: ZONE_OPTIONS,
            value: zone,
            onChange: onZone,
            t,
          }),
        ),
        h(
          "div",
          { className: "dts-field" },
          h(
            "div",
            { className: "dts-fieldHead" },
            h(
              "span",
              { className: "dts-fieldKey" },
              t("settings.field.currency"),
            ),
          ),
          h(
            "p",
            { className: "dts-fieldDesc" },
            t("settings.fieldDesc.currency"),
          ),
          h(SearchSelect, {
            options: CURRENCY_OPTIONS,
            value: currency,
            onChange: onCurrency,
            t,
          }),
        ),
      );
    }

    /**
     * The prompt-optimizer tab: the instruction the optimizer model reads,
     * the route it runs on, and whether the request also carries an excerpt
     * of the session's context. Same shape as the context tab — prompt, the
     * provider/model grid, then the toggle — because the two features share
     * one mental model ("what the plugin sends to a model on your behalf");
     * only the config keys and the toggle's meaning differ.
     */
    function OptimizerTab({ draft, doc, editable, t, onPatch }) {
      const fallback = doc?.value ?? {};
      const prompt =
        typeof draft.optimizerPrompt === "string"
          ? draft.optimizerPrompt
          : (fallback.optimizerPrompt ?? "");
      const provider =
        typeof draft.optimizerProvider === "string"
          ? draft.optimizerProvider
          : (fallback.optimizerProvider ?? "");
      const model =
        typeof draft.optimizerModel === "string"
          ? draft.optimizerModel
          : (fallback.optimizerModel ?? "");
      const useContext =
        typeof draft.optimizerUseContext === "boolean"
          ? draft.optimizerUseContext
          : (fallback.optimizerUseContext ?? false);
      const groups = Array.isArray(doc?.models?.groups)
        ? doc.models.groups
        : [];
      const providerOptions = useMemo(() => {
        const rows = groups.map((group) => ({
          value: group.id,
          label: group.name ?? group.id,
        }));
        return [{ value: "", label: t("settings.placeholder.inherit") }, ...rows];
      }, [groups, t]);
      const modelOptions = useMemo(() => {
        const source =
          provider === ""
            ? groups
            : groups.filter((group) => group.id === provider);
        const rows = [];
        for (const group of source)
          for (const item of Array.isArray(group.models) ? group.models : [])
            rows.push({
              value: item.id,
              label:
                item.contextWindow === null || item.contextWindow === undefined
                  ? item.id
                  : `${item.name ?? item.id} · ${formatCompact(item.contextWindow)}`,
            });
        return [{ value: "", label: t("settings.placeholder.inherit") }, ...rows];
      }, [groups, provider, t]);

      return h(
        "div",
        { className: "dts-section" },
        h(
          "div",
          { className: "dts-field" },
          h(
            "div",
            { className: "dts-fieldHead" },
            h(
              "span",
              { className: "dts-fieldKey" },
              t("settings.field.optimizerPrompt"),
            ),
          ),
          h(
            "p",
            { className: "dts-fieldDesc" },
            t("settings.fieldDesc.optimizerPrompt"),
          ),
          h("textarea", {
            className: "dts-textarea",
            rows: 10,
            value: prompt,
            disabled: !editable,
            spellCheck: false,
            onChange: (event) => onPatch({ optimizerPrompt: event.target.value }),
          }),
        ),
        h(
          "div",
          { className: "dts-field" },
          h(
            "div",
            { className: "dts-fieldHead" },
            h(
              "span",
              { className: "dts-fieldKey" },
              t("settings.field.optimizerUseContext"),
            ),
            h("input", {
              type: "checkbox",
              className: "dts-check",
              checked: useContext,
              disabled: !editable,
              onChange: (event) =>
                onPatch({ optimizerUseContext: event.target.checked }),
            }),
          ),
          h(
            "p",
            { className: "dts-fieldDesc" },
            t("settings.fieldDesc.optimizerUseContext"),
          ),
        ),
        h(
          "div",
          { className: "dts-fieldGrid" },
          h(
            "div",
            { className: "dts-field" },
            h(
              "div",
              { className: "dts-fieldHead" },
              h(
                "span",
                { className: "dts-fieldKey" },
                t("settings.field.optimizerProvider"),
              ),
            ),
            h(
              "p",
              { className: "dts-fieldDesc" },
              t("settings.fieldDesc.optimizerProvider"),
            ),
            h(SearchSelect, {
              options: providerOptions,
              value: provider,
              // Same routability rule as the compact pickers: a provider that
              // does not serve the chosen model would only fail when the
              // button runs, so switching providers clears the model first.
              onChange: (next) => {
                const stillServed =
                  next === "" ||
                  model === "" ||
                  groups
                    .find((group) => group.id === next)
                    ?.models?.some((item) => item.id === model) === true;
                onPatch(
                  stillServed
                    ? { optimizerProvider: next }
                    : { optimizerProvider: next, optimizerModel: "" },
                );
              },
              t,
            }),
          ),
          h(
            "div",
            { className: "dts-field" },
            h(
              "div",
              { className: "dts-fieldHead" },
              h(
                "span",
                { className: "dts-fieldKey" },
                t("settings.field.optimizerModel"),
              ),
            ),
            h(
              "p",
              { className: "dts-fieldDesc" },
              t("settings.fieldDesc.optimizerModel"),
            ),
            h(SearchSelect, {
              options: modelOptions,
              value: model,
              onChange: (next) => onPatch({ optimizerModel: next }),
              t,
            }),
          ),
        ),
      );
    }

    /**
     * The context tab: the instruction, the model it runs on, automatic
     * compaction, and how full the window currently is.
     *
     * The prompt is a textarea rather than the single-line input the generated
     * field list would give it — it is a multi-paragraph instruction, and
     * editing a paragraph inside one line is not workable.
     *
     * The provider and model are pickers over the Host's live catalog rather
     * than free-text fields: a typed model name that no adapter serves fails
     * only when compaction runs, which is the worst possible moment to find
     * out. The empty choice sits first and means "inherit", so it is a real
     * option, not a blank the user has to know the meaning of.
     */
    function ContextTab({ draft, doc, editable, t, onPatch, pressure }) {
      const fallback = doc?.value ?? {};
      const prompt =
        typeof draft.compactPrompt === "string"
          ? draft.compactPrompt
          : (fallback.compactPrompt ?? "");
      const provider =
        typeof draft.compactProvider === "string"
          ? draft.compactProvider
          : (fallback.compactProvider ?? "");
      const model =
        typeof draft.compactModel === "string"
          ? draft.compactModel
          : (fallback.compactModel ?? "");
      const autoCompact =
        typeof draft.autoCompact === "boolean"
          ? draft.autoCompact
          : (fallback.autoCompact ?? false);
      const threshold =
        typeof draft.autoCompactThreshold === "number"
          ? draft.autoCompactThreshold
          : (fallback.autoCompactThreshold ?? 0.75);
      const splitCompaction =
        typeof draft.splitCompaction === "boolean"
          ? draft.splitCompaction
          : (fallback.splitCompaction ?? false);

      /**
       * The catalog the Host reported, flattened to picker options.
       *
       * `doc.models` is the Host's own resolution, so every row here is a
       * model that adapter actually answers for; a provider whose listing
       * failed is simply absent instead of being offered and then rejected.
       */
      const catalog = doc?.models;
      const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
      const providerOptions = useMemo(() => {
        const rows = groups.map((group) => ({
          value: group.id,
          label: group.name ?? group.id,
        }));
        return [{ value: "", label: t("settings.placeholder.inherit") }, ...rows];
      }, [groups, t]);
      const modelOptions = useMemo(() => {
        const source =
          provider === ""
            ? groups
            : groups.filter((group) => group.id === provider);
        const rows = [];
        for (const group of source)
          for (const item of Array.isArray(group.models) ? group.models : [])
            rows.push({
              value: item.id,
              // The group name repeats the provider, which the picker above
              // already shows; the row carries just the model and its window.
              label:
                item.contextWindow === null || item.contextWindow === undefined
                  ? item.id
                  : `${item.name ?? item.id} · ${formatCompact(item.contextWindow)}`,
            });
        return [{ value: "", label: t("settings.placeholder.inherit") }, ...rows];
      }, [groups, provider, t]);

      const percent = Math.round(threshold * 100);
      const ratio =
        pressure?.available === true && typeof pressure.ratio === "number"
          ? pressure.ratio
          : null;
      const breakdown = pressure?.available === true ? pressure.breakdown : null;
      // The bar stops at a full track, but the label does not: a session over
      // the window reads "230%", not a reassuring "100%".
      const percentUsed = ratio === null ? null : Math.round(ratio * 100);
      const fill = ratio === null ? null : Math.min(100, percentUsed);
      return h(
        "div",
        { className: "dts-section" },
        h(
          "div",
          { className: "dts-field" },
          h(
            "div",
            { className: "dts-fieldHead" },
            h(
              "span",
              { className: "dts-fieldKey" },
              t("settings.field.compactPrompt"),
            ),
          ),
          h(
            "p",
            { className: "dts-fieldDesc" },
            t("settings.fieldDesc.compactPrompt"),
          ),
          h("textarea", {
            className: "dts-textarea",
            rows: 12,
            value: prompt,
            disabled: !editable,
            spellCheck: false,
            onChange: (event) => onPatch({ compactPrompt: event.target.value }),
          }),
        ),
        // The live pressure readout sits above the switch that acts on it, so
        // the number the slider is set against is visible while it is set.
        h(
          "div",
          { className: "dts-field" },
          h(
            "div",
            { className: "dts-fieldHead" },
            h(
              "span",
              { className: "dts-fieldKey" },
              t("settings.context.title"),
            ),
            ratio === null
              ? null
              : h(
                  "span",
                  { className: "dts-fieldValue" },
                  `${percentUsed}%`,
                ),
          ),
          pressure?.available !== true
            ? h(
                "p",
                { className: "dts-fieldDesc" },
                t("settings.context.unavailable"),
              )
            : h(
                React.Fragment,
                null,
                h(
                  "p",
                  { className: "dts-fieldDesc" },
                  h(
                    "span",
                    null,
                    `${t("settings.context.used")} ${formatInt(pressure.totalTokens)}`,
                  ),
                  pressure.contextWindow === null
                    ? ` · ${t("settings.context.noWindow")}`
                    : ` / ${formatInt(pressure.contextWindow)}`,
                ),
                // The total above is the real request size; the provider's own
                // accounting is a different question and can read an order of
                // magnitude lower on a long cached session. Showing it beside
                // the real one explains the difference instead of hiding it.
                typeof pressure.usageTokens === "number" &&
                pressure.usageTokens > 0
                  ? h(
                      "p",
                      { className: "dts-fieldDesc" },
                      t("settings.context.usage", {
                        tokens: formatInt(pressure.usageTokens),
                      }),
                    )
                  : null,
                ratio === null
                  ? null
                  : h(
                      "div",
                      { className: "dts-fill" },
                      h("div", {
                        className: "dts-fillBar",
                        "data-tone":
                          ratio >= threshold
                            ? "warn"
                            : ratio >= 0.5
                              ? "busy"
                              : "idle",
                        style: { width: `${fill}%` },
                      }),
                    ),
                breakdown === null
                  ? null
                  : h(
                      "div",
                      { className: "dts-breakdown" },
                      ...[
                        ["settings.context.system", breakdown.systemTokens],
                        ["settings.context.tools", breakdown.toolsTokens],
                        ["settings.context.messages", breakdown.messageTokens],
                      ].map(([key, value]) =>
                        h(
                          "span",
                          { className: "dts-breakdownRow", key },
                          h("span", null, t(key)),
                          h("span", null, formatInt(value)),
                        ),
                      ),
                    ),
              ),
        ),
        h(
          "div",
          { className: "dts-fieldGrid" },
          h(
            "div",
            { className: "dts-field" },
            h(
              "div",
              { className: "dts-fieldHead" },
              h(
                "span",
                { className: "dts-fieldKey" },
                t("settings.field.compactProvider"),
              ),
            ),
            h(
              "p",
              { className: "dts-fieldDesc" },
              t("settings.fieldDesc.compactProvider"),
            ),
            h(SearchSelect, {
              options: providerOptions,
              value: provider,
              // Picking a provider that does not serve the chosen model would
              // leave an unroutable pair, and the failure would only surface
              // when compaction runs. Clear the model instead: the empty value
              // means "inherit", which is always valid.
              onChange: (next) => {
                const stillServed =
                  next === "" ||
                  model === "" ||
                  groups
                    .find((group) => group.id === next)
                    ?.models?.some((item) => item.id === model) === true;
                onPatch(
                  stillServed
                    ? { compactProvider: next }
                    : { compactProvider: next, compactModel: "" },
                );
              },
              t,
            }),
          ),
          h(
            "div",
            { className: "dts-field" },
            h(
              "div",
              { className: "dts-fieldHead" },
              h(
                "span",
                { className: "dts-fieldKey" },
                t("settings.field.compactModel"),
              ),
            ),
            h(
              "p",
              { className: "dts-fieldDesc" },
              t("settings.fieldDesc.compactModel"),
            ),
            h(SearchSelect, {
              options: modelOptions,
              value: model,
              onChange: (next) => onPatch({ compactModel: next }),
              t,
            }),
          ),
        ),
        h(
          "div",
          { className: "dts-field" },
          h(
            "div",
            { className: "dts-fieldHead" },
            h(
              "span",
              { className: "dts-fieldKey" },
              t("settings.field.autoCompact"),
            ),
            h("input", {
              type: "checkbox",
              className: "dts-check",
              checked: autoCompact,
              disabled: !editable,
              onChange: (event) =>
                onPatch({ autoCompact: event.target.checked }),
            }),
          ),
          h(
            "p",
            { className: "dts-fieldDesc" },
            t("settings.fieldDesc.autoCompact"),
          ),
          h(
            "div",
            { className: "dts-threshold" },
            h("input", {
              type: "range",
              className: "dts-range",
              min: 5,
              max: 95,
              step: 1,
              value: percent,
              disabled: !editable || !autoCompact,
              onChange: (event) =>
                onPatch({ autoCompactThreshold: Number(event.target.value) / 100 }),
            }),
            h(
              "span",
              { className: "dts-thresholdValue" },
              t("settings.field.autoCompactThreshold"),
              ` ${percent}%`,
            ),
          ),
          h(
            "p",
            { className: "dts-fieldDesc" },
            t("settings.autoCompactThresholdHint"),
          ),
        ),
        h(
          "div",
          { className: "dts-field" },
          h(
            "div",
            { className: "dts-fieldHead" },
            h(
              "span",
              { className: "dts-fieldKey" },
              t("settings.field.splitCompaction"),
            ),
            h("input", {
              type: "checkbox",
              className: "dts-check",
              checked: splitCompaction,
              disabled: !editable,
              onChange: (event) =>
                onPatch({ splitCompaction: event.target.checked }),
            }),
          ),
          h(
            "p",
            { className: "dts-fieldDesc" },
            t("settings.fieldDesc.splitCompaction"),
          ),
          h(
            "p",
            { className: "dts-fieldDesc" },
            t("settings.splitCompactionHint"),
          ),
        ),
      );
    }

    /**
     * The part of a session id worth showing.
     *
     * Ids look like `session-a78f1057…`; the first eight characters of that
     * are the constant prefix, which identifies nothing. The tail is the random
     * part, so that is what a person can use to tell two rows apart.
     */
    function shortId(id) {
      const text = String(id).replace(/^session-/, "");
      return text.length <= 8 ? text : text.slice(0, 8);
    }

    /**
     * A sortable column head.
     *
     * The arrow is part of the button, not a decoration beside it, so the hit
     * area covers the whole label and the current direction is readable without
     * hovering.
     */
    function SortHead({ id, label, sort, onSort }) {
      const active = sort.key === id;
      const arrow = active ? (sort.desc ? "▼" : "▲") : "";
      return h(
        "button",
        {
          type: "button",
          "data-active": active ? "true" : "false",
          onClick: () => onSort(id),
        },
        label,
        arrow === ""
          ? null
          : h("span", { className: "dts-sessionArrow" }, arrow),
      );
    }

    /**
     * The per-session table: one row per session, with its subagents nested
     * under it.
     *
     * Sessions are grouped by parent rather than listed flat because a subagent
     * is an implementation detail of the session that spawned it; showing forty
     * of them next to their creator hides the creator. A row with no children
     * still renders the toggle, hidden, so every title stays aligned.
     */
    function SessionList({ sessions, t, onExport }) {
      const [sort, setSort] = useState({ key: "total", desc: true });
      // The checkbox remembers what the user last chose. Defaulting it to
      // checked on every mount is what made the archived rows reappear after
      // the user had already hidden them, so the stored value wins and a first
      // visit still starts with them shown.
      const [showArchived, setShowArchived] = useState(() =>
        readPref("session.showArchived", true),
      );
      const [expanded, setExpanded] = useState(() => new Set());
      const [page, setPage] = useState(0);

      const visible = useMemo(
        () =>
          showArchived ? sessions : sessions.filter((row) => !row.archived),
        [sessions, showArchived],
      );

      /** Parents with their own children, in the order the sort produced. */
      const groups = useMemo(() => {
        const byParent = new Map();
        for (const row of visible) {
          if (row.parent === "") continue;
          const list = byParent.get(row.parent);
          if (list === undefined) byParent.set(row.parent, [row]);
          else list.push(row);
        }
        const roots = visible.filter(
          (row) =>
            row.parent === "" ||
            !visible.some((other) => other.id === row.parent),
        );
        const compare = (left, right) => {
          let result;
          if (sort.key === "title")
            result = left.title.localeCompare(right.title, "zh-Hans-CN");
          else if (sort.key === "created")
            result = left.createdAt - right.createdAt;
          else if (sort.key === "calls") result = left.calls - right.calls;
          else result = left.total - right.total;
          if (sort.desc) result = -result;
          if (result !== 0) return result;
          return left.id < right.id ? -1 : 1;
        };
        // A root sinks below its last child, so a collapsed group still sorts
        // near the sessions it represents.
        const weight = (row) => {
          const children = byParent.get(row.id) ?? [];
          return children.reduce(
            (sum, child) =>
              sum +
              (sort.key === "calls"
                ? child.calls
                : sort.key === "created"
                  ? 0
                  : child.total),
            sort.key === "calls"
              ? row.calls
              : sort.key === "created"
                ? row.createdAt
                : row.total,
          );
        };
        roots.sort((left, right) => {
          if (sort.key === "title") return compare(left, right);
          const delta = weight(right) - weight(left);
          if (delta !== 0) return sort.desc ? delta : -delta;
          return left.id < right.id ? -1 : 1;
        });
        return roots.map((row) => ({
          row,
          children: (byParent.get(row.id) ?? []).sort(compare),
        }));
      }, [visible, sort]);

      const pageCount = Math.max(
        1,
        Math.ceil(groups.length / SESSION_PAGE_SIZE),
      );
      const current = Math.min(page, pageCount - 1);
      const slice = groups.slice(
        current * SESSION_PAGE_SIZE,
        current * SESSION_PAGE_SIZE + SESSION_PAGE_SIZE,
      );

      const onSort = (key) =>
        setSort((prior) =>
          prior.key === key
            ? { key, desc: !prior.desc }
            : { key, desc: key !== "title" },
        );

      const toggle = (id) =>
        setExpanded((prior) => {
          const next = new Set(prior);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });

      const renderRow = (row, children, depth) => {
        const open = expanded.has(row.id);
        const canExpand = children.length > 0;
        return h(
          React.Fragment,
          { key: row.id },
          h(
            "div",
            {
              className:
                depth === 0 ? "dts-sessionRow" : "dts-sessionRow dts-childRow",
            },
            h(
              "div",
              { className: "dts-sessionName" },
              h(
                "button",
                {
                  type: "button",
                  className: "dts-treeToggle",
                  "data-empty": canExpand ? "false" : "true",
                  "aria-expanded": open ? "true" : "false",
                  "aria-label": t("session.toggle"),
                  onClick: () => toggle(row.id),
                  tabIndex: canExpand ? 0 : -1,
                },
                open ? "▼" : "▶",
              ),
              h(
                "span",
                { className: "dts-sessionTitle", title: row.title },
                row.title === "" ? t("session.untitled") : row.title,
              ),
              h("span", { className: "dts-sessionId" }, shortId(row.id)),
              row.archived
                ? h(
                    "span",
                    { className: "dts-tag", "data-kind": "archived" },
                    t("session.archived"),
                  )
                : null,
              row.subagent
                ? h(
                    "span",
                    { className: "dts-tag", "data-kind": "subagent" },
                    t("session.subagentTag"),
                  )
                : null,
            ),
            h(
              "span",
              { className: "dts-sessionTokens" },
              formatCompact(row.total),
            ),
            h("span", { className: "dts-sessionCalls" }, formatInt(row.calls)),
            h(
              "span",
              { className: "dts-sessionCreated" },
              formatDate(row.createdAt),
            ),
            h(
              "span",
              { className: "dts-sessionKind" },
              row.subagent
                ? t("session.kind.subagent")
                : t("session.kind.main"),
            ),
          ),
          open
            ? children.map((child) =>
                h(
                  "div",
                  {
                    key: child.id,
                    className: "dts-sessionRow dts-childRow dts-childRows",
                  },
                  h(
                    "div",
                    { className: "dts-sessionName" },
                    h("span", {
                      className: "dts-treeToggle",
                      "data-empty": "true",
                    }),
                    h(
                      "span",
                      { className: "dts-sessionTitle", title: child.title },
                      child.title === "" ? t("session.untitled") : child.title,
                    ),
                    h(
                      "span",
                      { className: "dts-sessionId" },
                      shortId(child.id),
                    ),
                    child.archived
                      ? h(
                          "span",
                          { className: "dts-tag", "data-kind": "archived" },
                          t("session.archived"),
                        )
                      : null,
                  ),
                  h(
                    "span",
                    { className: "dts-sessionTokens" },
                    formatCompact(child.total),
                  ),
                  h(
                    "span",
                    { className: "dts-sessionCalls" },
                    formatInt(child.calls),
                  ),
                  h(
                    "span",
                    { className: "dts-sessionCreated" },
                    formatDate(child.createdAt),
                  ),
                  h(
                    "span",
                    { className: "dts-sessionKind" },
                    t("session.kind.subagent"),
                  ),
                ),
              )
            : null,
        );
      };

      return h(
        "div",
        { className: "dts-sessions" },
        h(
          "div",
          { className: "dts-sessionHead" },
          h(
            "span",
            { className: "dts-sessionName" },
            h(SortHead, {
              id: "title",
              label: t("session.col.name"),
              sort,
              onSort,
            }),
          ),
          h(
            "span",
            { className: "dts-sessionTokens" },
            h(SortHead, {
              id: "total",
              label: t("session.col.tokens"),
              sort,
              onSort,
            }),
          ),
          h(
            "span",
            { className: "dts-sessionCalls" },
            h(SortHead, {
              id: "calls",
              label: t("session.col.calls"),
              sort,
              onSort,
            }),
          ),
          h(
            "span",
            { className: "dts-sessionCreated" },
            h(SortHead, {
              id: "created",
              label: t("session.col.created"),
              sort,
              onSort,
            }),
          ),
          h("span", { className: "dts-sessionKind" }, t("session.col.kind")),
        ),
        groups.length === 0
          ? h("div", { className: "dts-empty" }, t("session.empty"))
          : h(
              "div",
              { className: "dts-sessionList" },
              slice.map((entry) => renderRow(entry.row, entry.children, 0)),
            ),
        pageCount > 1
          ? h(
              "div",
              { className: "dts-pager" },
              h("span", null, `${current + 1} / ${pageCount}`),
              h(
                "button",
                {
                  type: "button",
                  disabled: current === 0,
                  onClick: () => setPage(Math.max(0, current - 1)),
                },
                t("session.prev"),
              ),
              h(
                "button",
                {
                  type: "button",
                  disabled: current >= pageCount - 1,
                  onClick: () => setPage(Math.min(pageCount - 1, current + 1)),
                },
                t("session.next"),
              ),
            )
          : null,
        h(
          "div",
          { className: "dts-sessionFoot" },
          h(
            "span",
            null,
            t("session.count")
              .replace("{shown}", formatInt(visible.length))
              .replace("{total}", formatInt(sessions.length)),
          ),
          h(
            "div",
            { className: "dts-sessionFootActions" },
            h(
              "label",
              null,
              h("input", {
                type: "checkbox",
                checked: showArchived,
                onChange: (event) => {
                  const next = event.target.checked;
                  setShowArchived(next);
                  writePref("session.showArchived", next);
                  setPage(0);
                },
              }),
              t("session.showArchived"),
            ),
            h(
              "button",
              {
                type: "button",
                className: "dts-btn",
                style: { height: "24px", fontSize: "11px" },
                onClick: onExport,
              },
              t("session.export"),
            ),
          ),
        ),
      );
    }

    /**
     * Workspaces by usage. The path is the one the session header carries, so
     * the grouping says where the work happened rather than which profile it
     * belonged to.
     */
    function WorkspaceList({ workspaces, peak, t }) {
      if (workspaces.length === 0)
        return h(
          "div",
          { className: "dts-card" },
          h(
            "div",
            { className: "dts-cardHead" },
            h("h2", { className: "dts-cardTitle" }, t("workspace.title")),
            h("p", { className: "dts-cardHint" }, t("workspace.hint")),
          ),
          h("p", { className: "dts-empty" }, t("workspace.empty")),
        );
      return h(
        "div",
        { className: "dts-card" },
        h(
          "div",
          { className: "dts-cardHead" },
          h("h2", { className: "dts-cardTitle" }, t("workspace.title")),
          h("p", { className: "dts-cardHint" }, t("workspace.hint")),
        ),
        h(
          "div",
          { className: "dts-workspaces" },
          workspaces.map((entry) =>
            h(
              "div",
              { key: entry.cwd, className: "dts-workspace" },
              h(
                "span",
                { className: "dts-workspacePath", title: entry.cwd },
                entry.cwd === "" ? t("workspace.unknown") : entry.cwd,
              ),
              h(
                "div",
                { className: "dts-workspaceBar" },
                h("div", {
                  className: "dts-workspaceFill",
                  style: {
                    width: `${peak === 0 ? 0 : Math.round((entry.total / peak) * 100)}%`,
                  },
                }),
              ),
              h(
                "span",
                { className: "dts-workspaceValue" },
                formatCompact(entry.total),
                " · ",
                t("workspace.sessions").replace(
                  "{count}",
                  formatInt(entry.sessions),
                ),
              ),
            ),
          ),
        ),
      );
    }

    //#endregion

    //#region heatmap

    /**
     * The hover state a heatmap card keeps for its tip.
     *
     * Placement is measured from the card rather than from the cell: the week
     * grid scrolls horizontally and the month grid reflows, so cell-relative
     * coordinates would drift or be clipped. The hook returns the measured
     * anchor plus the handlers that feed it, which keeps both views on one
     * implementation of "where does the tip go".
     */
    function useCellTip() {
      const wrapRef = useRef(null);
      const [tip, setTip] = useState(null);

      const show = (event, key, row) => {
        const wrap = wrapRef.current;
        if (wrap === null) return;
        const box = wrap.getBoundingClientRect();
        const cell = event.currentTarget.getBoundingClientRect();
        // Centre the card on the cell, then let it run to whichever edge has
        // room. The width is decided by the content, so the only clamp that can
        // be applied here is the one that keeps the left edge inside the
        // wrapper; `HoverCard` nudges itself back from the right edge once it
        // has been laid out and knows how wide it actually is.
        const left = Math.max(
          0,
          Math.round(cell.left - box.left + cell.width / 2 - TIP_WIDTH / 2),
        );
        // Below the cell by default; above it when the cell sits close to the
        // bottom of the card, or the card would spill onto the next one. The
        // height is a floor estimate (one title plus two rows), which is enough
        // to choose a side — the exact pixel height only affects a few pixels of
        // overlap, not whether it fits.
        const estimated = 78;
        const below = box.height - (cell.bottom - box.top);
        const top =
          below < estimated + 12
            ? Math.max(0, Math.round(cell.top - box.top - estimated - 8))
            : Math.round(cell.bottom - box.top + 8);
        setTip({ key, row, left, top, bounds: box.width });
      };

      return { wrapRef, tip, show, hide: () => setTip(null) };
    }

    /** GitHub-style week columns over the range. */
    function WeekHeatmap({ rows, byDay, peak, t, currency }) {
      const { wrapRef, tip, show, hide } = useCellTip();
      const weekdayKeys = [
        "heat.weekday.mon",
        "heat.weekday.tue",
        "heat.weekday.wed",
        "heat.weekday.thu",
        "heat.weekday.fri",
        "heat.weekday.sat",
        "heat.weekday.sun",
      ];
      if (rows.length === 0)
        return h("div", { className: "dts-empty" }, t("heat.empty"));
      const first = startOfWeek(parseDay(rows[0][0]));
      const last = addDays(startOfWeek(parseDay(rows[rows.length - 1][0])), 6);
      const weeks = Math.round(daysBetween(first, last) / 7) + 1;
      const columns = [];
      for (let index = 0; index < weeks; index += 1) {
        const cells = [];
        for (let weekday = 0; weekday < 7; weekday += 1) {
          const key = dayKey(addDays(first, index * 7 + weekday));
          const row = byDay.get(key);
          const value = row === undefined ? 0 : row[5];
          cells.push(
            h("div", {
              key,
              className: "dts-cell",
              "data-level": levelOf(value, peak),
              "data-outside": row === undefined ? "true" : "false",
              style: { width: "13px", height: "13px" },
              onMouseEnter:
                row === undefined
                  ? undefined
                  : (event) => show(event, key, row),
              onMouseLeave: hide,
            }),
          );
        }
        columns.push(h("div", { key: index, className: "dts-heatCol" }, cells));
      }
      const gutter = h(
        "div",
        {
          className: "dts-heatCol",
          style: {
            color: "var(--dsw-alias-label-secondary)",
            fontSize: "10px",
          },
        },
        weekdayKeys.map((key, index) =>
          h(
            "div",
            {
              key,
              style: {
                height: "13px",
                lineHeight: "13px",
                textAlign: "right",
                paddingRight: "4px",
                visibility: index % 2 === 0 ? "visible" : "hidden",
              },
            },
            t(key),
          ),
        ),
      );
      return h(
        "div",
        { className: "dts-heatWrap", ref: wrapRef },
        h(
          "div",
          { className: "dts-heatScroll" },
          h("div", { className: "dts-heat" }, gutter, columns),
        ),
        tip === null
          ? null
          : h(HoverCard, {
              title: tip.key,
              left: tip.left,
              top: tip.top,
              bounds: tip.bounds,
              rows: [
                { label: t("heat.tokens"), value: formatInt(tip.row[5]) },
                { label: t("heat.cost"), value: cost(tip.row[7], currency) },
              ],
            }),
      );
    }

    /** One mini calendar per month in the range. */
    function MonthHeatmap({ rows, byDay, peak, t, currency }) {
      const { wrapRef, tip, show, hide } = useCellTip();
      if (rows.length === 0)
        return h("div", { className: "dts-empty" }, t("heat.empty"));
      const months = [];
      for (
        let cursor = new Date(
          parseDay(rows[0][0]).getFullYear(),
          parseDay(rows[0][0]).getMonth(),
          1,
        );
        monthKey(cursor) <= monthKey(parseDay(rows[rows.length - 1][0]));
        cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
      ) {
        months.push(new Date(cursor));
      }
      const grid = h(
        "div",
        { className: "dts-heatMonth" },
        months.map((month) => {
          const lead = (month.getDay() + 6) % 7;
          const length = new Date(
            month.getFullYear(),
            month.getMonth() + 1,
            0,
          ).getDate();
          const cells = [];
          for (let index = 0; index < lead; index += 1) {
            cells.push(
              h("div", {
                key: `lead-${index}`,
                className: "dts-cell",
                "data-outside": "true",
                style: { height: "15px" },
              }),
            );
          }
          for (let day = 1; day <= length; day += 1) {
            const key = dayKey(
              new Date(month.getFullYear(), month.getMonth(), day),
            );
            const row = byDay.get(key);
            const value = row === undefined ? 0 : row[5];
            cells.push(
              h("div", {
                key,
                className: "dts-cell",
                "data-level": levelOf(value, peak),
                "data-outside": row === undefined ? "muted" : "false",
                style: { height: "15px" },
                onMouseEnter:
                  row === undefined
                    ? undefined
                    : (event) => show(event, key, row),
                onMouseLeave: hide,
              }),
            );
          }
          return h(
            "div",
            { key: monthKey(month), className: "dts-month" },
            h("div", { className: "dts-monthLabel" }, monthKey(month)),
            h(
              "div",
              { className: "dts-monthGrid" },
              ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) =>
                h(
                  "div",
                  { key: `w-${day}`, className: "dts-monthWeek" },
                  t(`heat.weekday.${day}`),
                ),
              ),
            ),
            h("div", { className: "dts-monthGrid" }, cells),
          );
        }),
      );

      return h(
        "div",
        { className: "dts-heatWrap", ref: wrapRef },
        grid,
        tip === null
          ? null
          : h(HoverCard, {
              title: tip.key,
              left: tip.left,
              top: tip.top,
              bounds: tip.bounds,
              rows: [
                { label: t("heat.tokens"), value: formatInt(tip.row[5]) },
                { label: t("heat.cost"), value: cost(tip.row[7], currency) },
              ],
            }),
      );
    }

    //#endregion

    //#region trend

    /**
     * The axis label for one trend bucket.
     *
     * The label carries exactly as much as the bucket does: a year needs only
     * the year, a month the month, a day the date, and an hour has to name the
     * hour or two points a day apart would read the same.
     *
     * Every clock-shaped answer is padded to `HH:00`. The key is `YYYY-MM-DDTHH`
     * with no minutes, and printing it bare left the axis reading `06`, `07`,
     * `08` — which looks like a count rather than a time, and is why the trend
     * card's hour axis looked different from the "24h" and "today" ones that
     * carried the same keys. `09` and `09:00` are the same instant; only one of
     * them reads as a clock.
     * @param key - the bucket key.
     * @param grain - the grain the row was folded to.
     * @returns the text under the axis.
     */
    function trendLabel(key, grain) {
      // An hour key is `YYYY-MM-DDTHH`, so the hour is the tail. A day or week
      // key is a date, so dropping the year keeps the label short. A month or
      // year key is already as short as it can be without losing meaning.
      if (grain === "hour") return `${key.slice(11, 13)}:00`;
      if (grain === "day" || grain === "week") return key.slice(5);
      return key;
    }

    /**
     * The heading the hover card shows for one bucket.
     *
     * It is the axis label with the date restored: the axis drops the year and,
     * on a coarse grain, the day, because a row of those under one chart is
     * read together; a tooltip is read alone, so it says the whole date. The
     * hour is padded the same way the axis is — `2026-11-02 09` leaves the
     * reader wondering whether the number is an hour or a count, and a range
     * that crosses midnight has two `09` points whose only difference is the
     * date in front of them.
     * @param key - the bucket key.
     * @param grain - the grain the row was folded to.
     * @returns the tooltip title.
     */
    function trendTitle(key, grain) {
      if (grain === "hour") return `${key.slice(0, 10)} ${key.slice(11, 13)}:00`;
      return key;
    }

    /**
     * Which billing band one trend bucket falls in.
     *
     * A bucket is peak when it billed anything at the peak rate, off-peak when
     * it billed anything at the off-peak rate, and neutral when the schedule
     * did not apply at all (no peak profile on any model in the range). The
     * chart only colours a bucket it can actually name: a mixed bucket is a
     * peak one, because the expensive half is what the user is looking for.
     * @param row - one fifteen-column trend row.
     * @returns `peak`, `off` or `null`.
     */
    function bandOf(row) {
      const peak = typeof row[12] === "number" ? row[12] : 0;
      const all = typeof row[5] === "number" ? row[5] : 0;
      if (peak > 0) return "peak";
      if (all > 0) return "off";
      return null;
    }

    /** Line chart with a hover readout. */
    function TrendChart({ rows, grain, t, currency }) {
      const boxRef = useRef(null);
      const [width, setWidth] = useState(720);
      const [hover, setHover] = useState(-1);

      useEffect(() => {
        const node = boxRef.current;
        if (node === null) return undefined;
        const measure = () =>
          setWidth(
            Math.max(280, Math.round(node.getBoundingClientRect().width)),
          );
        measure();
        if (typeof ResizeObserver === "undefined") return undefined;
        const observer = new ResizeObserver(measure);
        observer.observe(node);
        return () => observer.disconnect();
      }, []);

      const height = 240;
      const pad = { top: 16, right: 16, bottom: 30, left: 56 };
      const plotWidth = Math.max(1, width - pad.left - pad.right);
      const plotHeight = Math.max(1, height - pad.top - pad.bottom);
      const peak = rows.reduce((max, row) => Math.max(max, row[5]), 0);
      const yPeak = peak > 0 ? peak : 1;
      const stepX = rows.length > 1 ? plotWidth / (rows.length - 1) : 0;
      const xAt = (index) =>
        rows.length > 1 ? pad.left + index * stepX : pad.left + plotWidth / 2;
      const yAt = (value) =>
        pad.top + plotHeight - (value / yPeak) * plotHeight;

      // One sub-path per band instead of one path for the series. A bucket
      // belongs to the band that billed it, and drawing the segment that
      // leaves that bucket in its colour is what makes a glance at the line
      // answer "when was this expensive" without reading the axis. `bandOf`
      // returns null when no peak schedule applied, in which case every
      // segment falls back to the brand colour and the line looks as it did.
      const segments = [];
      for (let index = 0; index < rows.length - 1; index += 1) {
        const band = bandOf(rows[index]);
        const from = `${xAt(index).toFixed(2)},${yAt(rows[index][5]).toFixed(2)}`;
        const to = `${xAt(index + 1).toFixed(2)},${yAt(rows[index + 1][5]).toFixed(2)}`;
        const last = segments[segments.length - 1];
        // Consecutive buckets in the same band extend one path, so a long
        // stretch is one stroke with one join rather than a chain of dashes.
        if (last !== undefined && last.band === band) last.d += ` L${to}`;
        else segments.push({ band, d: `M${from} L${to}` });
      }
      const strokeOf = (band) =>
        band === "peak"
          ? "var(--dsw-alias-state-error-primary)"
          : band === "off"
            ? "var(--dsw-alias-state-success-primary)"
            : "var(--dsw-alias-brand-primary)";
      const area =
        rows.length === 0
          ? ""
          : `${rows
              .map(
                (row, index) =>
                  `${index === 0 ? "M" : "L"}${xAt(index).toFixed(2)},${yAt(row[5]).toFixed(2)}`,
              )
              .join(" ")} L${xAt(rows.length - 1).toFixed(2)},${pad.top + plotHeight} L${xAt(0).toFixed(2)},${pad.top + plotHeight} Z`;

      const ticks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
        value: yPeak * ratio,
        y: pad.top + plotHeight - plotHeight * ratio,
      }));

      const labelEvery = Math.max(
        1,
        Math.ceil(rows.length / Math.max(3, Math.floor(plotWidth / 76))),
      );
      const xLabels = rows.map((row, index) => {
        if (index % labelEvery !== 0 && index !== rows.length - 1) return null;
        return h(
          "text",
          {
            key: row[0],
            x: xAt(index),
            y: pad.top + plotHeight + 18,
            textAnchor: "middle",
            fill: "var(--dsw-alias-label-secondary)",
            fontSize: "10px",
          },
          trendLabel(row[0], grain),
        );
      });

      const active = hover >= 0 && hover < rows.length ? rows[hover] : null;

      const onMove = (event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const x = event.clientX - rect.left;
        if (rows.length <= 1) {
          setHover(x >= pad.left && x <= pad.left + plotWidth ? 0 : -1);
          return;
        }
        const index = Math.round((x - pad.left) / stepX);
        setHover(index >= 0 && index < rows.length ? index : -1);
      };

      if (rows.length === 0)
        return h("div", { className: "dts-empty" }, t("trend.empty"));

      // The card is centred on the hovered point and only pulled back from the
      // left edge here; the right edge is handled by `HoverCard` itself, which
      // measures its own width and nudges left by the overflow. Clamping to a
      // guessed width at this point would move a wide card in before it needed
      // to, which is exactly the bug the fixed-width card used to hide.
      const tipLeft = active === null ? 0 : Math.max(xAt(hover) - TIP_WIDTH / 2, 0);

      return h(
        "div",
        { className: "dts-chart", ref: boxRef },
        h(
          "svg",
          {
            width,
            height,
            role: "img",
            "aria-label": `${t("trend.title")} · ${rows.length}`,
            onMouseMove: onMove,
            onMouseLeave: () => setHover(-1),
          },
          h(
            "defs",
            null,
            h(
              "linearGradient",
              { id: "dts-area", x1: "0", y1: "0", x2: "0", y2: "1" },
              h("stop", {
                offset: "0%",
                stopColor: "var(--dsw-alias-brand-primary)",
                stopOpacity: "0.28",
              }),
              h("stop", {
                offset: "100%",
                stopColor: "var(--dsw-alias-brand-primary)",
                stopOpacity: "0",
              }),
            ),
          ),
          ticks.map((tick) =>
            h(
              "g",
              { key: tick.y },
              h("line", {
                x1: pad.left,
                x2: pad.left + plotWidth,
                y1: tick.y,
                y2: tick.y,
                stroke: "var(--dsw-alias-border-l1)",
                strokeWidth: "1",
              }),
              h(
                "text",
                {
                  x: pad.left - 8,
                  y: tick.y + 3,
                  textAnchor: "end",
                  fill: "var(--dsw-alias-label-secondary)",
                  fontSize: "10px",
                },
                formatCompact(tick.value),
              ),
            ),
          ),
          xLabels,
          h("path", { d: area, fill: "url(#dts-area)" }),
          segments.map((segment, index) =>
            h("path", {
              key: `${segment.band ?? "none"}-${index}`,
              d: segment.d,
              fill: "none",
              stroke: strokeOf(segment.band),
              strokeWidth: "2",
              strokeLinejoin: "round",
              strokeLinecap: "round",
            }),
          ),
          rows.length <= 80
            ? rows.map((row, index) =>
                h("circle", {
                  key: row[0],
                  cx: xAt(index),
                  cy: yAt(row[5]),
                  r: index === hover ? 4 : 2.5,
                  fill: strokeOf(bandOf(row)),
                  stroke: "var(--dsw-alias-bg-layer-1)",
                  strokeWidth: "1.5",
                }),
              )
            : null,
          hover >= 0
            ? h("line", {
                x1: xAt(hover),
                x2: xAt(hover),
                y1: pad.top,
                y2: pad.top + plotHeight,
                stroke: "var(--dsw-alias-brand-primary)",
                strokeWidth: "1",
                strokeDasharray: "3 3",
                opacity: "0.7",
              })
            : null,
        ),
        active === null
          ? null
          : h(HoverCard, {
              // The bucket key is the whole title, hour key included: a range
              // that spans midnight has two `09` points and the tooltip has to
              // say which day it is reporting.
              title: trendTitle(active[0], grain),
              left: tipLeft,
              top: 8,
              bounds: width,
              rows: [
                {
                  label: t("heat.tokens"),
                  value: formatInt(active[5]),
                  swatch: true,
                },
                { label: t("heat.cost"), value: cost(active[7], currency) },
                // The two bands are the cost row's split, so they sit directly
                // under it rather than at the bottom of the card. Index 14 is
                // the bucket's peak cost and 7 its cost overall — 9 would be
                // peak *output tokens*, a number of the right shape that would
                // report money never spent. A bucket with no peak schedule on
                // its model omits both rather than printing zeroes that would
                // read as free usage.
                ...(bandOf(active) === null
                  ? []
                  : [
                      {
                        label: t("stat.peak"),
                        value: cost(active[14] ?? 0, currency),
                        swatch: "peak",
                        tone: "peak",
                      },
                      {
                        label: t("stat.offPeak"),
                        value: cost(
                          (active[7] ?? 0) - (active[14] ?? 0),
                          currency,
                        ),
                        swatch: "offPeak",
                        tone: "offPeak",
                      },
                    ]),
                { label: t("stat.input"), value: formatInt(active[1]) },
                { label: t("stat.output"), value: formatInt(active[2]) },
                { label: t("stat.cacheRead"), value: formatInt(active[3]) },
                { label: t("stat.cacheWrite"), value: formatInt(active[4]) },
                { label: t("trend.calls"), value: formatInt(active[6]) },
              ],
            }),
      );
    }

    //#endregion

    //#region panel

    /** The main panel: toolbar, headline numbers, heatmap, trend, models. */
    function MainPanel(props) {
      const t = props.t;
      /**
       * The conversation this panel is open beside.
       *
       * The panel lives in the `main` slot, which is not session-scoped, so no
       * `sessionId` arrives as a prop. The root `sessions` hook exposes the
       * roster, and the entry the framework currently retains for its main
       * view is the conversation on screen — the same rule `uiSession` uses
       * when it decides which session to publish.
       *
       * An absent id is a normal state rather than an error: the panel opens
       * with no conversation on screen too, and only the context tab's live
       * readout needs one.
       */
      // The root standard kit always carries `useSessions` — `ui-session`
      // provides it on the root binding and the renderer materializes it for
      // every entry — so this is called unconditionally. Guarding the call
      // would change the hook count between renders, which React forbids.
      const sessionId = props.useSessions((state) => {
        const byId = state?.byId ?? {};
        for (const id of Object.keys(byId))
          if ((byId[id]?.retainedBy?.mainView ?? 0) > 0) return id;
        return undefined;
      });
      const [doc, setDoc] = useState(null);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(false);
      const [grain, setGrain] = useState("day");
      const [heatMode, setHeatMode] = useState("week");
      /**
       * The one range every card reads.
       *
       * `preset` is what the filter bar shows as selected and `range` is what
       * it resolves to; they are kept apart because a preset has to be
       * re-resolved as the clock moves ("today" is a different day tomorrow)
       * while an explicitly picked pair of dates must not move under the user.
       * `range.hours` is non-null only for "last 24 hours", which is the one
       * preset that is finer than a day.
       */
      const [preset, setPreset] = useState("all");
      const [range, setRange] = useState({
        from: "",
        to: "",
        hours: null,
      });
      const [menuOpen, setMenuOpen] = useState(false);
      const [settingsOpen, setSettingsOpen] = useState(false);
      /** The model every card is narrowed to; null means "all models". */
      const [focusModel, setFocusModel] = useState(null);
      const menuRef = useRef(null);

      const load = useCallback(async (refresh) => {
        setBusy(true);
        try {
          setDoc(
            refresh === true ? await api.refresh() : await api.summary(false),
          );
          setError(null);
        } catch (failure) {
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
        } finally {
          setBusy(false);
        }
      }, []);

      useEffect(() => {
        load(false);
      }, [load]);

      useEffect(() => {
        if (!menuOpen) return undefined;
        const close = (event) => {
          if (
            menuRef.current !== null &&
            !menuRef.current.contains(event.target)
          )
            setMenuOpen(false);
        };
        document.addEventListener("mousedown", close);
        return () => document.removeEventListener("mousedown", close);
      }, [menuOpen]);

      const allRows = doc?.days ?? [];
      const allHours = doc?.hours ?? [];
      const bounds = useMemo(
        () => ({
          from: doc?.firstDay ?? "",
          to: doc?.lastDay ?? "",
        }),
        [doc],
      );
      const from = range.from === "" ? bounds.from : range.from;
      const to = range.to === "" ? bounds.to : range.to;
      /** The hour bounds, present only when the filter is finer than a day. */
      const hourSpan = range.hours;

      /**
       * The day rows every card aggregates.
       *
       * With no model focused this is the Host's global day list. With one
       * focused it is that model's own daily rows, filtered to the same range,
       * so the heatmap, the trend, the cost figures and the session list all
       * describe one model instead of the whole account.
       */
      const rows = useMemo(() => {
        if (from === "" || to === "") return [];
        // A model's own daily rows are what the range filter narrows; a
        // focused model with no row on a day must contribute zero there, not
        // the whole account's figure, so the fallback stays on the model list.
        const base =
          focusModel === null
            ? allRows
            : ((doc?.modelDays ?? []).find(
                (entry) => entry[0] === focusModel,
              )?.[1] ?? []);
        if (base.length === 0) return [];
        return base.filter((row) => row[0] >= from && row[0] <= to);
      }, [allRows, doc, focusModel, from, to]);

      /**
       * The hour rows the trend card plots when the filter is hour-grained.
       *
       * A day filter still uses {@link rows} — an hour series over 30 days is
       * 720 points, which is noise on a 700px-wide chart, and the user asked
       * for days by picking a day range.
       */
      const hourRows = useMemo(() => {
        if (hourSpan === null) return [];
        const base =
          focusModel === null
            ? allHours
            : ((doc?.modelHours ?? []).find(
                (entry) => entry[0] === focusModel,
              )?.[1] ?? []);
        return base.filter(
          (row) => row[0] >= hourSpan.from && row[0] <= hourSpan.to,
        );
      }, [allHours, doc, focusModel, hourSpan]);

      const totals = useMemo(() => {
        const sum = [0, 0, 0, 0, 0, 0];
        for (const row of rows)
          for (let index = 1; index <= 6; index += 1)
            sum[index - 1] += row[index];
        return sum;
      }, [rows]);

      /**
       * The heatmap's own series, deliberately outside the range filter.
       *
       * A calendar is read as a calendar: narrowing it to "today" leaves a
       * single lit cell and no shape to compare against. So this one card
       * always spans the whole corpus — or the whole history of the focused
       * model — while the trend, the figures and the lists below it stay on
       * the filter. Only the model focus still applies, because that is a
       * different axis from the time range and the model table promises that
       * every figure covers the focused model alone.
       */
      const heatRows = useMemo(() => {
        const base =
          focusModel === null
            ? allRows
            : ((doc?.modelDays ?? []).find(
                (entry) => entry[0] === focusModel,
              )?.[1] ?? []);
        if (base.length === 0) return [];
        const low = focusModel === null ? bounds.from : base[0][0];
        const high =
          focusModel === null ? bounds.to : base[base.length - 1][0];
        if (low === "" || high === "") return [];
        return densify(base, low, high);
      }, [allRows, doc, focusModel, bounds]);
      const heatByDay = useMemo(
        () => new Map(heatRows.map((row) => [row[0], row])),
        [heatRows],
      );
      const heatPeak = useMemo(
        () => heatRows.reduce((max, row) => Math.max(max, row[5]), 0),
        [heatRows],
      );
      /** The series the trend card draws at its current grain. */
      const trendRows = useMemo(() => {
        if (grain === "hour")
          return hourSpan === null
            ? []
            : densifyHours(hourRows, hourSpan.from, hourSpan.to);
        return foldGrain(rows, grain);
      }, [rows, hourRows, hourSpan, grain]);
      /**
       * The models in the selected span, not in the whole corpus.
       *
       * Reading the Host's global model list would leave a model in the picker
       * — and its bar sized against a peak from another month — after the user
       * narrowed to today and that model contributed nothing. The rows come
       * from the same per-model daily list every other card reads, so the
       * picker and the cards it filters can never disagree.
       */
      const models = useMemo(() => {
        const list = [];
        for (const [name, perModel] of doc?.modelDays ?? []) {
          let total = 0;
          let calls = 0;
          for (const row of perModel) {
            if (from !== "" && row[0] < from) continue;
            if (to !== "" && row[0] > to) continue;
            total += count(row[5]);
            calls += count(row[6]);
          }
          if (total === 0 && calls === 0) continue;
          list.push({ name, total, calls });
        }
        return list.sort((left, right) => right.total - left.total);
      }, [doc, from, to]);
      const modelPeak = models.length === 0 ? 1 : models[0].total;
      /**
       * The billing figures for the selected span.
       *
       * Every number is derived here from the day rows the cards already show,
       * so the cost card, the peak card and the hit-rate card all describe the
       * same slice as everything below them. The Host's `billing` block covers
       * the whole corpus and is kept only for the currency label and for the
       * list of unpriced models, which are properties of the config rather
       * than of the range.
       */
      const billing = useMemo(() => {
        const unpricedList = doc?.billing?.unpriced ?? [];
        let cost = 0;
        let peakCost = 0;
        let peakTokens = 0;
        let hits = 0;
        let misses = 0;
        for (const row of rows) {
          cost += typeof row[7] === "number" ? row[7] : 0;
          // Fifteen-column layout: the peak total is index 12 and the peak
          // cost is 14, with the peak call count sitting at 13 between them.
          peakCost += typeof row[14] === "number" ? row[14] : 0;
          peakTokens += count(row[12]);
          hits += count(row[3]);
          misses += count(row[1]);
        }
        const billed = hits + misses;
        return {
          currency: doc?.billing?.currency ?? "CNY",
          cost,
          peakCost,
          offPeakCost: cost - peakCost,
          peakTokens,
          offPeakTokens: Math.max(0, count(totals[4]) - peakTokens),
          hits,
          misses,
          hitRate: billed === 0 ? 0 : hits / billed,
          unpriced:
            focusModel === null
              ? unpricedList
              : unpricedList.includes(focusModel)
                ? [focusModel]
                : [],
        };
      }, [doc, rows, totals, focusModel]);
      /**
       * Session rows follow the selected window and the focused model.
       *
       * Each row is summed from the session's own slots, so a session that
       * used two models reports only its share of the focused one, and a
       * session that used the focused model outside the range drops out
       * entirely — which is what makes the model picker a filter over the
       * list rather than only over the cards above it.
       */
      const sessions = useMemo(() => {
        const report = doc?.sessionRows ?? [];
        const list = [];
        for (const row of report) {
          const [
            id,
            title,
            createdAt,
            isSubagent,
            isArchived,
            ,
            ,
            parent,
            ,
            ,
            cwd,
            slots,
            ,
          ] = row;
          let total = 0;
          let calls = 0;
          let cost = 0;
          if (Array.isArray(slots)) {
            for (const slot of slots) {
              const key = slot[0];
              if (from !== "" && key.slice(0, 10) < from) continue;
              if (to !== "" && key.slice(0, 10) > to) continue;
              if (hourSpan !== null && (key < hourSpan.from || key > hourSpan.to))
                continue;
              if (focusModel !== null && slot[1] !== focusModel) continue;
              total += count(slot[6]);
              calls += count(slot[7]);
              cost += typeof slot[8] === "number" ? slot[8] : 0;
            }
          }
          if (total === 0 && calls === 0) continue;
          list.push({
            id: String(id),
            title: typeof title === "string" ? title : "",
            createdAt: count(createdAt),
            subagent: isSubagent === 1,
            archived: isArchived === 1,
            parent: typeof parent === "string" ? parent : "",
            cwd: typeof cwd === "string" ? cwd : "",
            total,
            calls,
            cost,
          });
        }
        return list;
      }, [doc, from, to, hourSpan, focusModel]);

      /** Sessions rolled up by their working directory. */
      const workspaces = useMemo(() => {
        const byCwd = new Map();
        for (const row of sessions) {
          const entry = byCwd.get(row.cwd);
          if (entry === undefined)
            byCwd.set(row.cwd, {
              cwd: row.cwd,
              total: row.total,
              calls: row.calls,
              sessions: 1,
            });
          else {
            entry.total += row.total;
            entry.calls += row.calls;
            entry.sessions += 1;
          }
        }
        return [...byCwd.values()].sort(
          (left, right) => right.total - left.total,
        );
      }, [sessions]);
      const workspacePeak = workspaces.length === 0 ? 1 : workspaces[0].total;

      /**
       * Switch the shared filter to a preset.
       *
       * Every card reads `range`, so this is the only place a quick range is
       * turned into dates; a card that resolved "this week" on its own would
       * disagree with its neighbours by a day as soon as the clock crossed
       * midnight.
       * @param id - a {@link PRESETS} id.
       */
      const applyPreset = (id) => {
        const next = presetRange(id, new Date(), bounds);
        setPreset(id);
        setRange({ from: next.from, to: next.to, hours: next.hours });
        // The grain is a property of the span, not a preference: a 24-hour
        // window plotted by day is one point, so the chart follows the filter
        // instead of forcing the user to change both controls.
        if (next.hours !== null) setGrain("hour");
        else if (grain === "hour") setGrain("day");
      };

      /**
       * Apply a hand-picked pair of dates, which no preset describes.
       *
       * A span of one day is plotted by hour, exactly like the "today" and
       * "24h" presets. The reason is the same one that makes those presets
       * hour-grained: a single day folded by date is one point on the chart,
       * and one point says nothing about a day's shape. So picking the same
       * date twice is read as "this day, hour by hour" rather than as a range
       * that happens to be one pixel wide.
       *
       * The hour span covers midnight to 23:00 of the picked day, except when
       * that day is today — then it stops at the current hour, because the
       * hours that have not happened yet would draw a flat tail that reads as
       * inactivity rather than as absence of data.
       */
      const applyCustom = (nextFrom, nextTo) => {
        setPreset("");
        if (nextFrom !== "" && nextFrom === nextTo) {
          const now = new Date();
          const end = nextTo === dayKey(now) ? hourKey(now) : `${nextTo}T23`;
          setRange({
            from: nextFrom,
            to: nextTo,
            hours: { from: `${nextFrom}T00`, to: end },
          });
          setGrain("hour");
          return;
        }
        setRange({ from: nextFrom, to: nextTo, hours: null });
        if (grain === "hour") setGrain("day");
      };

      // The export follows the chart rather than the day list: it is the same
      // series, folded the same way, so the file a user opens describes the
      // picture they were looking at. Reading `rows` here wrote one line per
      // day even under an hour grain, because `rows` is always day rows.
      const exportRows = () => trendRows;

      const exportJson = () => {
        const payload = {
          exportedAt: new Date().toISOString(),
          range: { from, to },
          grain,
          totals: {
            input: totals[0],
            output: totals[1],
            cacheRead: totals[2],
            cacheWrite: totals[3],
            total: totals[4],
            calls: totals[5],
          },
          sessions: doc?.sessions ?? null,
          buckets: exportRows().map((row) => ({
            bucket: row[0],
            input: row[1],
            output: row[2],
            cacheRead: row[3],
            cacheWrite: row[4],
            total: row[5],
            calls: row[6],
          })),
          models: models.map((entry) => ({
            model: entry.name,
            total: entry.total,
            calls: entry.calls,
          })),
        };
        download(
          `token-stats-${from}_${to}-${grain}.json`,
          `${JSON.stringify(payload, null, 2)}\n`,
          "application/json",
        );
        setMenuOpen(false);
      };

      const exportCsv = () => {
        // The row arrays carry fifteen columns now, so each one is picked by
        // index rather than joined whole: a `map` over the row would emit the
        // peak block too and leave the file with more values per line than the
        // header names.
        const header = [
          "bucket",
          "input",
          "output",
          "cache_read",
          "cache_write",
          "total",
          "calls",
        ];
        const lines = [header.join(",")];
        for (const row of exportRows())
          lines.push(
            [row[0], row[1], row[2], row[3], row[4], row[5], row[6]]
              .map(csvField)
              .join(","),
          );
        lines.push(
          [
            "TOTAL",
            totals[0],
            totals[1],
            totals[2],
            totals[3],
            totals[4],
            totals[5],
          ].join(","),
        );
        download(
          `token-stats-${from}_${to}-${grain}.csv`,
          `\ufeff${lines.join("\r\n")}\r\n`,
          "text/csv;charset=utf-8",
        );
        setMenuOpen(false);
      };

      const head = h(
        "div",
        { className: "dts-head" },
        h(
          "div",
          { className: "dts-heading" },
          h("h1", { className: "dts-title" }, t("page.title")),
          h("p", { className: "dts-subtitle" }, t("page.subtitle")),
        ),
        h(
          "div",
          { className: "dts-actions" },
          h(
            "button",
            {
              type: "button",
              className: "dts-btn",
              onClick: () => setSettingsOpen(true),
            },
            t("action.settings"),
          ),
          h(
            "button",
            {
              type: "button",
              className: "dts-btn",
              "data-primary": "true",
              disabled: busy,
              onClick: () => load(true),
            },
            busy ? t("action.refreshing") : t("action.refresh"),
          ),
          h(
            "div",
            { className: "dts-menuWrap", ref: menuRef },
            h(
              "button",
              {
                type: "button",
                className: "dts-btn",
                disabled: rows.length === 0,
                onClick: () => setMenuOpen((open) => !open),
              },
              t("action.export"),
            ),
            menuOpen
              ? h(
                  "div",
                  { className: "dts-menu", role: "menu" },
                  h(
                    "button",
                    { type: "button", role: "menuitem", onClick: exportCsv },
                    t("action.exportCsv"),
                  ),
                  h(
                    "button",
                    { type: "button", role: "menuitem", onClick: exportJson },
                    t("action.exportJson"),
                  ),
                )
              : null,
          ),
        ),
      );

      const toolbar = h(
        "div",
        { className: "dts-toolbar" },
        h("span", { className: "dts-toolbarLabel" }, t("range.label")),
        h("input", {
          type: "date",
          className: "dts-date",
          "aria-label": t("range.from"),
          min: bounds.from === "" ? undefined : bounds.from,
          max: to === "" ? undefined : to,
          value: from,
          onChange: (event) => applyCustom(event.target.value, to),
        }),
        h("span", { className: "dts-sep" }, "–"),
        h("input", {
          type: "date",
          className: "dts-date",
          "aria-label": t("range.to"),
          min: from === "" ? undefined : from,
          max: bounds.to === "" ? undefined : bounds.to,
          value: to,
          onChange: (event) => applyCustom(from, event.target.value),
        }),
        // One button per preset, all reading the same `preset` state, so the
        // bar can only ever show one active range — including a hand-picked
        // pair of dates, which clears the selection instead of leaving the
        // last preset lit over a range it no longer describes.
        h(
          "div",
          { className: "dts-presets", role: "group", "aria-label": t("range.label") },
          PRESETS.map((entry) =>
            h(
              "button",
              {
                key: entry.id,
                type: "button",
                className: "dts-btn",
                "data-active": preset === entry.id ? "true" : "false",
                "aria-pressed": preset === entry.id,
                onClick: () => applyPreset(entry.id),
              },
              t(entry.label),
            ),
          ),
        ),
        h("span", { className: "dts-spacer" }),
        // Says out loud that the bar is not a per-card setting. Without it the
        // seven buttons read as a chart shortcut rather than as the control
        // every card below shares.
        h("span", { className: "dts-rangeHint" }, t("range.hint")),
      );

      const stats = h(
        "div",
        { className: "dts-stats" },
        h(Stat, {
          label: t("stat.total"),
          value: formatCompact(totals[4]),
          hint: `${formatInt(totals[4])} ${t("stat.tokens")}`,
        }),
        h(Stat, {
          label: t("stat.cost"),
          value: cost(billing.cost, billing.currency),
          hint:
            billing.unpriced.length === 0
              ? [
                  // The rule line is the one place both bands are printed side
                  // by side, so each share takes its band colour here too —
                  // otherwise the summary reads as one undifferentiated number
                  // and the red/green figures elsewhere have no counterpart.
                  h(
                    "span",
                    { key: "peak", className: "dts-hintPeak" },
                    t("cost.rulePeak").replace(
                      "{peak}",
                      cost(billing.peakCost, billing.currency),
                    ),
                  ),
                  h("span", { key: "sep", className: "dts-hintSep" }, " · "),
                  h(
                    "span",
                    { key: "offPeak", className: "dts-hintOffPeak" },
                    t("cost.ruleOffPeak").replace(
                      "{offPeak}",
                      cost(billing.offPeakCost, billing.currency),
                    ),
                  ),
                ]
              : t("cost.unpriced").replace(
                  "{models}",
                  billing.unpriced.join(", "),
                ),
        }),
        h(Stat, {
          label: t("stat.hitRate"),
          value: `${(billing.hitRate * 100).toFixed(2)}%`,
          hint: t("stat.hitRateHint")
            .replace("{hits}", formatCompact(billing.hits))
            .replace("{misses}", formatCompact(billing.misses)),
        }),
        h(Stat, {
          label: t("stat.peak"),
          value: formatCompact(billing.peakTokens),
          hint: t("stat.peakHint")
            .replace("{tokens}", formatCompact(billing.peakTokens))
            .replace("{cost}", cost(billing.peakCost, billing.currency)),
          tone: "peak",
        }),
        h(Stat, {
          label: t("stat.offPeak"),
          value: formatCompact(billing.offPeakTokens),
          hint: t("stat.offPeakHint")
            .replace("{tokens}", formatCompact(billing.offPeakTokens))
            .replace("{cost}", cost(billing.offPeakCost, billing.currency)),
          tone: "offPeak",
        }),
        h(Stat, {
          label: t("stat.input"),
          value: formatCompact(totals[0]),
          hint: formatInt(totals[0]),
        }),
        h(Stat, {
          label: t("stat.output"),
          value: formatCompact(totals[1]),
          hint: formatInt(totals[1]),
        }),
        h(Stat, {
          label: t("stat.cacheRead"),
          value: formatCompact(totals[2]),
          hint: formatInt(totals[2]),
        }),
        // Cache writes get their own card because they bill on their own rate
        // now; folding them into the input card would hide the item the price
        // table has a column for.
        h(Stat, {
          label: t("stat.cacheWrite"),
          value: formatCompact(totals[3]),
          hint: t("stat.cacheWriteHint").replace(
            "{tokens}",
            formatInt(totals[3]),
          ),
        }),
        h(Stat, { label: t("stat.calls"), value: formatInt(totals[5]) }),
        h(Stat, {
          label: t("stat.sessions"),
          value: formatInt(doc?.sessions?.total ?? 0),
        }),
      );

      const heatCard = h(
        "div",
        { className: "dts-card" },
        h(
          "div",
          { className: "dts-cardHead" },
          h(
            "div",
            null,
            h("h2", { className: "dts-cardTitle" }, t("heat.title")),
            h("p", { className: "dts-cardHint" }, t("heat.hint")),
          ),
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: "12px" } },
            h(HeatLegend, { t }),
            h(Segmented, {
              options: [
                { id: "week", label: t("heat.week") },
                { id: "month", label: t("heat.month") },
              ],
              value: heatMode,
              onChange: setHeatMode,
            }),
          ),
        ),
        heatMode === "week"
          ? h(WeekHeatmap, {
              rows: heatRows,
              byDay: heatByDay,
              peak: heatPeak,
              t,
              currency: billing.currency,
            })
          : h(MonthHeatmap, {
              rows: heatRows,
              byDay: heatByDay,
              peak: heatPeak,
              t,
              currency: billing.currency,
            }),
      );

      const trendCard = h(
        "div",
        { className: "dts-card" },
        h(
          "div",
          { className: "dts-cardHead" },
          h(
            "div",
            null,
            h("h2", { className: "dts-cardTitle" }, t("trend.title")),
            h(
              "p",
              { className: "dts-cardHint" },
              grain === "hour" ? t("trend.hourHint") : t("trend.hint"),
            ),
          ),
          h(Segmented, {
            // The hour grain is only offered while the range is hour-grained:
            // a day-styled series over a 24-hour window is a single point, and
            // offering it would let the user flatten the card into something
            // that says nothing.
            options: (hourSpan === null
              ? GRAINS
              : ["hour", ...GRAINS]
            ).map((id) => ({ id, label: t(`trend.${id}`) })),
            value: grain,
            onChange: setGrain,
          }),
        ),
        h(TrendChart, {
          rows: trendRows,
          grain,
          t,
          currency: billing.currency,
        }),
      );

      const modelCard =
        models.length === 0
          ? null
          : h(
              "div",
              { className: "dts-card" },
              h(
                "div",
                { className: "dts-cardHead" },
                h(
                  "div",
                  null,
                  h("h2", { className: "dts-cardTitle" }, t("model.title")),
                  // One line per state. The focused sentence names both things
                  // the filter actually does — the cards' numbers and the
                  // session list — so the reader gets the full effect without
                  // two near-identical sentences stacked up.
                  h(
                    "p",
                    { className: "dts-cardHint" },
                    focusModel === null
                      ? t("model.hint")
                      : t("model.focused").replace("{model}", focusModel),
                  ),
                ),
                focusModel === null
                  ? null
                  : h(
                      "button",
                      {
                        type: "button",
                        className: "dts-btn",
                        style: { height: "28px", fontSize: "12px" },
                        onClick: () => setFocusModel(null),
                      },
                      t("model.clear"),
                    ),
              ),
              h(
                "div",
                { className: "dts-models" },
                models.map((entry) =>
                  h(
                    "button",
                    {
                      key: entry.name,
                      type: "button",
                      className: "dts-model",
                      "data-focus":
                        focusModel === entry.name ? "true" : "false",
                      "aria-pressed":
                        focusModel === entry.name ? "true" : "false",
                      onClick: () =>
                        setFocusModel((current) =>
                          current === entry.name ? null : entry.name,
                        ),
                    },
                    h(
                      "div",
                      { className: "dts-modelName", title: entry.name },
                      entry.name === "unknown"
                        ? t("model.unknown")
                        : entry.name,
                    ),
                    h(
                      "div",
                      { className: "dts-modelBar" },
                      h("div", {
                        className: "dts-modelFill",
                        style: {
                          width: `${Math.max(1, (entry.total / modelPeak) * 100)}%`,
                        },
                      }),
                    ),
                    h(
                      "div",
                      { className: "dts-modelValue" },
                      `${formatCompact(entry.total)} · ${formatInt(entry.calls)}`,
                    ),
                  ),
                ),
              ),
            );

      const footer =
        doc === null
          ? null
          : h(
              "div",
              { className: "dts-footer" },
              h(
                "div",
                null,
                t("footer.source")
                  .replace("{sessions}", formatInt(doc.sessions.total))
                  .replace("{main}", formatInt(doc.sessions.main))
                  .replace("{subagent}", formatInt(doc.sessions.subagent))
                  .replace("{archived}", formatInt(doc.sessions.archived ?? 0))
                  .replace("{calls}", formatInt(doc.totals.calls)),
              ),
              h(
                "div",
                null,
                t("footer.updated").replace(
                  "{time}",
                  formatMoment(doc.generatedAt),
                ),
              ),
            );

      const notice =
        error === null
          ? null
          : h(
              "div",
              {
                className: "dts-state",
                "data-tone": "error",
              },
              h("div", null, t("state.error").replace("{message}", error)),
              h(
                "button",
                {
                  type: "button",
                  className: "dts-btn",
                  style: { marginTop: "10px" },
                  onClick: () => load(true),
                },
                t("state.retry"),
              ),
            );

      return h(
        "div",
        { className: "dts-page" },
        head,
        notice,
        doc === null
          ? h("div", { className: "dts-state" }, t("state.loading"))
          : h(
              React.Fragment,
              null,
              toolbar,
              // The model card sits directly under the range card because its
              // models are the filter for everything below it.
              modelCard,
              stats,
              heatCard,
              trendCard,
              h(SessionList, {
                sessions,
                t,
                onExport: () =>
                  exportSessions(sessions, from, to, billing.currency),
              }),
              h(WorkspaceList, { workspaces, peak: workspacePeak, t }),
              footer,
              settingsOpen
                ? h(SettingsModal, {
                    t,
                    sessionId,
                    onClose: () => setSettingsOpen(false),
                    onSaved: () => load(false),
                  })
                : null,
            ),
      );
    }

    /**
     * The sidebar row icon: the same artwork as the package `icon.svg`, drawn inline so it can inherit
     * `currentColor` and follow the row's active/idle coloring, which an `<img src>` cannot do.
     */
    const ICON_PATH =
      "M93.090909 930.909091h930.909091v93.090909H0V0h93.090909v930.909091z m93.090909-442.181818h93.090909v372.363636H186.181818V488.727273z m209.454546-139.636364h93.090909v512h-93.090909V349.090909z m209.454545 139.636364h93.090909v372.363636h-93.090909V488.727273z m209.454546-186.181818h93.090909v558.545454h-93.090909V302.545455z m-555.985455 15.45309l-51.665455-77.451636L442.181818 83.688727l205.381818 136.936728 182.597819-162.327273 61.858909 69.585454-236.311273 210.036364L442.181818 195.584l-183.621818 122.414545z";

    /** The sidebar row icon. */
    function SidebarIcon({ size }) {
      const edge = typeof size === "number" && size > 0 ? size : 20;
      return h(
        "span",
        {
          "data-dsh-plugin": PANEL_ID,
          "data-dsh-part": "sidebar-icon",
          style: { display: "inline-flex" },
        },
        h(
          "svg",
          {
            width: edge,
            height: edge,
            viewBox: "0 0 1024 1024",
            fill: "currentColor",
            role: "presentation",
            "aria-hidden": "true",
          },
          h("path", { d: ICON_PATH }),
        ),
      );
    }

    /**
     * The two context buttons the dock carries: clear on the left in orange,
     * compact on the right in green.
     *
     * They live in `conversation.composer.dock` rather than inside the context
     * meter's panel because that panel is drawn by the platform with no slot of
     * its own; the dock sits directly beneath the meter and survives platform
     * upgrades. The session comes from the slot's own inject, so a button can
     * never act on a session other than the one it is rendered for.
     */
    function ContextActions({ sessionId, t: translate }) {
      const [busy, setBusy] = useState(null);
      // The slot injects `t` through its locale namespace; the captured bind
      // is only a fallback for a render path that does not carry it.
      const t = translate ?? boundT;

      /**
       * Fire one operation and let the session log carry the report.
       *
       * There is deliberately no local note: the outcome is appended to this
       * session as a `command/done` event, which the chat renders as a command
       * row. Reporting it twice — once under the buttons, once in the
       * transcript — would put the same sentence on screen in two places and
       * leave the button copy out of the session log. The local `busy` flag
       * stays because a button must not be pressable twice while the request
       * is in flight, and that is a property of this button, not of the
       * session.
       */
      const run = (op) => {
        if (busy !== null) return;
        setBusy(op);
        const call = op === "clear" ? api.clearContext : api.compactContext;
        call(sessionId)
          // A refused request still answers through the command row; the one
          // case that has no row is a transport failure, and that one is worth
          // surfacing here because nothing else will show it.
          .catch(() => undefined)
          .finally(() => setBusy(null));
      };

      if (typeof sessionId !== "string" || sessionId === "") return null;
      return h(
        "div",
        { className: "dts-ctxWrap", "data-dsh-plugin": PANEL_ID },
        h(
          "div",
          { className: "dts-ctxRow" },
          h(
            "button",
            {
              type: "button",
              className: "dts-ctxBtn dts-ctxClear",
              disabled: busy !== null,
              onClick: () => run("clear"),
              title: t("context.clear.hint"),
            },
            busy === "clear" ? "…" : t("context.clear"),
          ),
          h(
            "button",
            {
              type: "button",
              className: "dts-ctxBtn dts-ctxCompact",
              disabled: busy !== null,
              onClick: () => run("compact"),
              title: t("context.compact.hint"),
            },
            busy === "compact" ? "…" : t("context.compact"),
          ),
        ),
      );
    }

    /**
     * The optimize button, inlined in the composer toolbar row.
     *
     * The draft is read straight off the session input shell — the same
     * published store the composer itself renders from — and the rewrite is
     * written back through `actions.setDraft`, the same face the platform's
     * own editing commands use, so persistence and the editor's internal
     * state stay consistent with no DOM poking. Attachments are left alone
     * on purpose: only the prompt text travels, and only the prompt text is
     * replaced.
     *
     * The shell arrives through the slot's inject, resolved the same way the
     * queue dock resolves its conversation service; the overlay slot passes
     * no props of its own, so nothing here relies on hook injection.
     */
    function OptimizeButton({ sessionId, input, t: translate }) {
      const t = translate ?? boundT;
      // The published InputState store: subscribe for re-renders, snapshot
      // for the value. A shell that has not published yet degrades to a
      // hidden button rather than a broken composer.
      const snapshot = useSyncExternalStore(
        input === undefined ? subscribeNoop : input.state.subscribe.bind(input.state),
        input === undefined ? snapshotNoop : input.state.getSnapshot.bind(input.state),
      );
      const draft = typeof snapshot?.draft === "string" ? snapshot.draft : "";
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      if (typeof sessionId !== "string" || sessionId === "") return null;
      // No shell, no button: writing the rewrite back would be impossible.
      // The button itself stays resident — the user asked for a permanent
      // affordance — and is merely disabled while the draft is empty, which
      // keeps the hover explanation discoverable at all times.
      if (input === undefined) return null;

      const run = async () => {
        if (busy || draft.trim() === "") return;
        setBusy(true);
        setError(null);
        try {
          const result = await api.optimizePrompt(sessionId, draft);
          const text = typeof result?.text === "string" ? result.text : "";
          if (text !== "") input.actions.setDraft(text);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      };

      return h(
        "div",
        { className: "dts-optWrap", "data-dsh-plugin": PANEL_ID },
        h(
          "div",
          { className: "dts-optBtnWrap" },
          h(
            "button",
            {
              type: "button",
              className: "dts-optBtn",
              disabled: busy || draft.trim() === "",
              onClick: run,
            },
            h("span", { className: "dts-optIcon", dangerouslySetInnerHTML: { __html: OPTIMIZE_ICON } }),
            busy ? t("optimize.working") : t("optimize.button"),
          ),
          h(
            "span",
            { className: "dts-optTip", role: "tooltip" },
            t("optimize.hint"),
          ),
        ),
        error === null
          ? null
          : h("span", { className: "dts-optError" }, error),
      );
    }

    //#endregion

    return {
      inject: ["slots", "locale"],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, { zh: ZH, en: EN }),
          "dsh-token-panorama: locale dictionaries",
        );
        const t = ctx.locale.bind(NS);
        boundT = t;
        // The stylesheet normally rides along inside the panel, but the dock
        // buttons render outside it, so it is mounted once on the document
        // instead; the panel's own copy is harmless and keeps the panel
        // self-contained if it is ever mounted alone.
        ctx.effect(() => {
          const style = document.createElement("style");
          style.dataset.dshPlugin = PANEL_ID;
          style.textContent = CSS;
          document.head.appendChild(style);
          return () => style.remove();
        }, "dsh-token-panorama: stylesheet");
        ctx.effect(
          () =>
            ctx.slots.inject("main", () =>
              ctx.slots.inject("sidebar.panellist", () => {
                const stopMain = ctx.slots.register(
                  {
                    name: "main",
                    key: PANEL_ID,
                    inject: () => ({}),
                    locale: NS,
                  },
                  MainPanel,
                );
                let stopIcon;
                try {
                  stopIcon = ctx.slots.register(
                    {
                      name: "sidebar.panellist",
                      id: PANEL_ID,
                      order: 31,
                      label: () => t("nav.label"),
                      locale: NS,
                    },
                    SidebarIcon,
                  );
                } catch (error) {
                  stopMain();
                  throw error;
                }
                return () => {
                  stopIcon?.();
                  stopMain();
                };
              }),
            ),
          "dsh-token-panorama: panels",
        );
        ctx.effect(
          () =>
            ctx.slots.inject("conversation.composer.dock", () =>
              ctx.slots.register(
                {
                  name: "conversation.composer.dock",
                  // Namespaced so the id cannot collide with a shipped entry;
                  // a fresh id is added beside them rather than replacing one.
                  id: "dsh-token-panorama.context-actions",
                  order: 100,
                  locale: NS,
                  // Session-scoped slot: the framework passes the session the
                  // entry is rendered for, which is the one it acts on.
                  inject: (sessionId) => ({ sessionId }),
                },
                ContextActions,
              ),
            ),
          "dsh-token-panorama: context actions",
        );
        // The optimize button lives in the composer's toolbar row — the same
        // row as the attach button and the mode chips — via the
        // conversation.input.left slot. A floating overlay above the draft
        // was tried first and rejected: long text wrapped under it and the
        // chip covered what the user was typing. The toolbar row is real
        // flow layout, so it can never cover the draft, and the slot passes
        // no props of its own, so the inject resolves the session's input
        // shell through the conversation service, exactly the way the queue
        // dock reaches conversation.input: the button reads the published
        // draft store and writes the rewrite back through actions.setDraft
        // like any platform editing command would.
        ctx.effect(
          () =>
            ctx.slots.inject("conversation.input.left", () =>
              ctx.slots.register(
                {
                  name: "conversation.input.left",
                  id: "dsh-token-panorama.optimize-prompt",
                  order: 50,
                  locale: NS,
                  inject: (sessionId) => {
                    const sessions = ctx.get("sessions");
                    if (sessions === undefined)
                      return { sessionId, input: undefined };
                    try {
                      const actx = sessions.scope(sessionId);
                      // The conversation service lives on the session scope,
                      // and its input face resolves only for a retained
                      // binding; a session being torn down simply renders
                      // without the button.
                      const conversation = actx?.get("conversation");
                      if (conversation === undefined)
                        return { sessionId, input: undefined };
                      return {
                        sessionId,
                        input: conversation.input.for(actx),
                      };
                    } catch {
                      return { sessionId, input: undefined };
                    }
                  },
                },
                OptimizeButton,
              ),
            ),
          "dsh-token-panorama: optimize prompt button",
        );
      },
    };
  },
});

/**
 * Answering an `ask_user_question` batch on the user's behalf.
 *
 * The platform asks its user through a cordis waterfall: every listener on
 * `user-questions/request` may answer, and the first one that returns a batch
 * wins. This module is such a listener. It is registered with `prepend`, so it
 * sees the request before the Client's own answerer does — otherwise the human
 * card would already be on screen and the automatic answer could never land.
 *
 * Three rules shape everything below.
 *
 * Fail open. Any reason not to answer — the switch is off, the batch asks for
 * something this must never decide, the model returned nothing usable, the call
 * failed or ran out of time — returns *no batch* rather than an answer. The
 * caller then continues down the waterfall and the human still gets the card.
 * A wrong automatic answer to a real question is worse than a slower one.
 *
 * One request, one user message. Like the compaction summarizer this is a
 * direct `llm.stream` call, not a subagent: there is no child session, no tool
 * set and no permission preset, so the only thing this call can produce is
 * text. No tools are passed, because a model holding a tool list will use it.
 *
 * Attribution travels in `custom`. The question service copies only
 * `{id, selected, custom}` out of an answer batch, so an extra field carrying
 * provenance would be dropped before the card renders. The client draws
 * `custom` after the selected labels, which is exactly where "answered by
 * <provider>/<model>" belongs.
 */

import { appendLedger, usageFromChunk } from "./ledger.js";
import { translatorFor } from "./i18n.js";
import { instructionMessage, resolveRoute } from "./contextops.js";

/**
 * The default instruction the answering model reads.
 *
 * Written as a closing constraint, like the other two instructions in this
 * plugin: the question batch sits above it, so the last thing the model reads
 * is what it may and may not do. The "escalate instead of guessing" section is
 * the load-bearing part — a model asked to answer a question about the user's
 * own environment will invent an answer unless told that an empty batch is a
 * valid reply.
 */
export const DEFAULT_ASK_PROMPT = [
  "# 角色定义",
  "",
  "你是一个运行在编码智能体内部的受限问答引擎. 该智能体已暂停, 通过 ask_user_question 工具向用户批量提问, 而用户当前不在场. 你的职责范围被刻意收窄: 只回答那些正确答案可由问题本身判定, 且后果可逆, 不涉及授权的提问, 使智能体得以继续推进, 同时绝不代替用户做判断. 其余一切问题必须留给用户. 你绝不执行动作, 绝不在问题文本之外假设用户意图, 绝不写得像某个工具已经运行或某个结果已经被观察到.",
  "",
  "## 核心能力",
  "",
  "- **标签保真选择**: 逐字符复现提供的选项标签, 保持大小写, 标点, 空格与符号原样.",
  "- **上下文受控推理**: 仅依据问题自身的措辞与智能体在问题中陈述的上下文作答, 绝不引入外部假设.",
  "- **安全默认裁决**: 当问题中没有任何指向时, 按下述优先级选择最保守的选项: 只读 > 可逆 > 最小权限 > 本地 > 无副作用.",
  "- **升级识别**: 识别出需要用户专属信息, 明确授权, 凭据, 支出, 发布, 部署或破坏性动作的问题, 并拒绝作答.",
  "- **Schema 精确输出**: 产出单个可机器解析的 JSON 对象, 不含散文, 不含代码围栏, 不含尾随文本.",
  "",
  "## 核心红线",
  "",
  "1. **绝不改动标签**: 不得凭空创造, 翻译, 缩写, 改写大小写, 合并或拆分任何提供的标签; 绝不把用户可能自己输入的句子放进 `selected`.",
  "2. **绝不代行用户授权**: 任何要求批准, 许可, 授权, 计划确认或决定权限提示如何处置的问题都超出范围; 涉及凭据, 密钥, 密码, 钱包, 支付, 购买, 发布或对生产环境部署的问题同样超出范围.",
  "3. **绝不编造事实**: 不得虚构用户偏好, 机器状态, 文件内容, URL, 版本号或执行结果; 不得暗示任何工具已运行或任何输出已被观察到.",
  "4. **绝不污染输出**: 只输出一个 JSON 对象, 别无他物; 无代码围栏, 无解释, 无多余键, 无注释, 对象前后无任何文本.",
  "",
  "## 工作流程",
  "",
  "1. **解析批次**: 按给定顺序读取每一个问题, 记录其精确 `id` 与 `multiSelect` 标记. 若不存在任何问题, 输出 `{\"answers\":[]}` 并终止.",
  "2. **逐题分类**: 仅当正确答案可由问题自身措辞或智能体在其中陈述的上下文推出, 且后果可逆, 不涉及授权时, 才将该题标记为可作答.",
  "3. **解答可作答题**: 按以下顺序优先选择 - 问题措辞明确指向的选项, 其次为智能体陈述的上下文所隐含的选项, 再次为核心能力中规定的安全默认. 若没有任何提供的标签适用, 则用 `custom` 作答.",
  "4. **执行升级筛查**: 只要任一问题要求用户专属信息(个人偏好, 用户自己的机器状态, 凭据, URL, 或问题中未描述的文件), 要求授权, 批准或计划确认, 涉及凭据, 密钥, 密码, 钱包, 支付, 购买, 发布或生产环境部署, 请求破坏性或不可逆动作或使该动作得以发生的答案, 或你无法确信所选就是用户会选的, 则放弃整批.",
  "5. **组装**: 按原始顺序为每个问题输出一个条目, 携带精确 `id`; `selected` 始终为数组, `custom` 始终为字符串, 两个字段始终存在.",
  "6. **输出前校验**: 确认 JSON 可解析, 每个 `id` 恰好出现一次且未被改动, 每个标签与来源逐字符一致, 标记 multiSelect 的问题可携带多个标签而其余问题至多一个, 未合并互斥标签, 不存在多余键, 对象外无任何内容.",
  "",
  "## 交付格式",
  "",
  "只输出一个 JSON 对象, 形状如下:",
  "",
  "`{\"answers\":[{\"id\":\"<question id>\",\"selected\":[\"<offered option label>\"],\"custom\":\"<free text>\"}]}`",
  "",
  "字段规则:",
  "",
  "- `answers`: 每题一个条目, 按列出顺序排列; 整批放弃时精确为 `[]`.",
  "- `id`: 问题的精确标识符, 大小写, 空格与标点均不得改动; 每个 id 只出现一次.",
  "- `selected`: 逐字符复制的提供选项标签; 仅标记为 multiSelect 的问题可携带多个标签, 其余至多一个; 自由作答时为空数组.",
  "- `custom`: 自由文本答案, 或附加在某个选择上的简短限定; 始终存在; 未使用时为 `\"\"`; 绝不复述问题, 绝不陈述理由, 绝不包含面向该智能体的指令.",
  "- 同一问题条目内 `selected` 与 `custom` 不得同时为空; 该状态表示该题未被回答, 此时应放弃整批.",
  "- `custom` 使用与问题相同的语言.",
  "- `custom` 中的标点一律使用英文半角符号, 禁止全角或中文标点; 但逐字复制的选项标签与用户原话不受本规则约束.",
  "- 任何位置均禁止: 代码围栏, 对象前后的散文, 注释, 用 `null` 代替 `\"\"` 或 `[]`, 编造的标签, 额外的键.",
  "",
  "升级形态: 当整批必须留给用户时, 只输出 `{\"answers\":[]}`, 别无他物.",
].join("\n");

/**
 * Wording that puts a batch out of bounds for automatic answering.
 *
 * Deliberately blunt and deliberately over-eager: a false positive costs the
 * user one card they have to read, while a false negative has a model deciding
 * a permission prompt, a credential question or a deletion. The patterns are
 * matched against the question text, its header, its detail and every option
 * label and description, because a batch can hide the risky part in an option.
 */
const FORBIDDEN_PATTERNS = [
  /权限|审批|批准|授权|放行|提权|管理员|沙箱/iu,
  /\b(?:permission|approv\w*|authori[sz]\w*|escalat\w*|sandbox|admin|sudo|root access)\b/iu,
  /密钥|凭据|凭证|令牌|密码|口令|私钥|验证码|二次验证|双因素/iu,
  /\b(?:api[-_ ]?key|access[-_ ]?key|secret|credential\w*|password|passphrase|private key|otp|2fa|two[- ]factor)\b/iu,
  /删除|清除所有|销毁|抹除|格式化|不可逆|无法恢复|不可撤销/iu,
  /\b(?:delete|remove|destroy|wipe|erase|drop (?:table|database)|format (?:the )?disk|rm -rf|irreversible|unrecoverable)\b/iu,
  /付费|支付|购买|付款|订阅|充值|退款|发票|钱包/iu,
  /\b(?:purchase|payment|pay for|subscri\w*|refund|invoice|wallet|credit card)\b/iu,
  /发布到|上线|生产环境|推送到主干|正式发布/iu,
  /\b(?:publish|release to|deploy(?:ment)? to|production|go live)\b/iu,
];

/**
 * Whether a batch must be left to the human.
 *
 * Two independent reasons: the batch declares an `intent` (approval and
 * plan-review batches are the platform's way of asking for authorisation, which
 * is never this plugin's to give), or the wording lands in a forbidden zone.
 * @param request - the `user-questions/request` payload.
 * @returns whether the batch must not be answered automatically.
 */
export function shouldDefer(request) {
  const questions = Array.isArray(request?.questions) ? request.questions : [];
  if (questions.length === 0) return true;
  for (const question of questions) {
    if (question?.intent !== undefined) return true;
    const parts = [
      question?.question,
      question?.header,
      question?.detail,
      ...(Array.isArray(question?.options)
        ? question.options.flatMap((option) => [option?.label, option?.description])
        : []),
    ];
    const text = parts
      .filter((part) => typeof part === "string")
      .join("\n");
    if (text === "") continue;
    if (FORBIDDEN_PATTERNS.some((pattern) => pattern.test(text))) return true;
  }
  return false;
}

/** Strip a code fence a model wrapped its whole answer in. */
function stripFence(text) {
  return text
    .replace(/^\s*`{3}(?:json|JSON)?\s*/u, "")
    .replace(/\s*`{3}\s*$/u, "");
}

/**
 * Turn the model's answer text into the batch the question service accepts.
 *
 * Validation is strict on purpose, and a partially usable batch is rejected
 * whole: the service requires one answer per question, and an answer batch that
 * silently dropped a question would leave the agent waiting for one it thinks
 * the user answered. A label the model invented is not "close enough" — it is
 * an option the question never offered, so the batch is refused rather than
 * trimmed into something that looks right.
 * @param text - the model's answer.
 * @param questions - the batch that was asked.
 * @param attribution - the note naming the model that answered.
 * @returns the answer batch, or null when it must be left to the user.
 */
export function parseAnswerBatch(text, questions, attribution) {
  if (typeof text !== "string" || text.trim() === "") return null;
  let value;
  try {
    value = JSON.parse(stripFence(text).trim());
  } catch {
    return null;
  }
  const raw = Array.isArray(value)
    ? value
    : Array.isArray(value?.answers)
      ? value.answers
      : null;
  if (raw === null || raw.length !== questions.length) return null;
  const byId = new Map();
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") return null;
    if (typeof entry.id !== "string") return null;
    byId.set(entry.id, entry);
  }

  const answers = [];
  for (const question of questions) {
    const entry = byId.get(question.id);
    if (entry === undefined) return null;
    const offered = new Set(
      (Array.isArray(question.options) ? question.options : [])
        .map((option) => option?.label)
        .filter((label) => typeof label === "string"),
    );
    const picked = [];
    for (const label of Array.isArray(entry.selected) ? entry.selected : []) {
      if (typeof label !== "string") continue;
      if (!offered.has(label)) return null;
      if (!picked.includes(label)) picked.push(label);
    }
    if (question.multiSelect !== true && picked.length > 1) return null;
    const custom = typeof entry.custom === "string" ? entry.custom.trim() : "";
    if (picked.length === 0 && custom === "") return null;
    const answer = { id: question.id, selected: picked };
    const note = attribution === "" ? custom : custom === "" ? attribution : `${custom} ${attribution}`;
    if (note !== "") answer.custom = note;
    answers.push(answer);
  }
  return { answers };
}

/**
 * Ask the answering model one batch and return its answer batch.
 *
 * Every failure mode returns null instead of throwing: the caller's only sane
 * reaction to any of them is to let the human answer, and a question that
 * vanished because a model call failed would stall the agent forever.
 * @param ctx - the Host context.
 * @param request - the `user-questions/request` payload.
 * @param options - the answer prompt, route override and wait budget.
 * @returns `{answers}`, or null when the batch stays with the user.
 */
export async function answerQuestions(ctx, request, options) {
  const t = translatorFor(ctx);
  const llm = ctx.get("llm");
  const agent = request?.agent;
  if (llm === undefined || agent === undefined) return null;
  const questions = Array.isArray(request.questions) ? request.questions : [];
  if (questions.length === 0) return null;

  const route = await resolveRoute(
    ctx,
    agent,
    typeof options?.provider === "string" ? options.provider : "",
    typeof options?.model === "string" ? options.model : "",
  );
  if (route.provider === "" || route.model === "") return null;

  const prompt =
    typeof options?.prompt === "string" && options.prompt.trim() !== ""
      ? options.prompt
      : DEFAULT_ASK_PROMPT;
  const payload = questions.map((question) => ({
    id: question.id,
    ...(typeof question.header === "string" ? { header: question.header } : {}),
    question: question.question,
    ...(typeof question.detail === "string" ? { detail: question.detail } : {}),
    ...(typeof question.multiSelect === "boolean"
      ? { multiSelect: question.multiSelect }
      : {}),
    ...(Array.isArray(question.options)
      ? {
          options: question.options.map((option) => ({
            label: option?.label,
            ...(typeof option?.description === "string"
              ? { description: option.description }
              : {}),
          })),
        }
      : {}),
  }));
  const body = [
    prompt,
    "## Questions",
    JSON.stringify(payload, null, 2),
  ].join("\n\n");

  // The wait budget is this plugin's own: the platform's timed tool already
  // carries a deadline of its own, and whichever comes first must hand the
  // batch back to the human rather than leave the agent waiting on a model.
  const seconds = Number.isInteger(options?.timeout) ? options.timeout : 120;
  const deadline =
    seconds === -1 ? undefined : AbortSignal.timeout(seconds * 1_000);
  const signal =
    deadline === undefined
      ? request.signal
      : request.signal === undefined
        ? deadline
        : AbortSignal.any([request.signal, deadline]);

  let text = "";
  let usage = null;
  const stream = llm.stream({
    provider: route.provider,
    model: route.model,
    messages: [instructionMessage(body)],
    sessionId: agent.session.id,
    purpose: "ask-answer",
    ...(signal === undefined ? {} : { signal }),
  });
  try {
    for await (const chunk of stream) {
      if (chunk.type === "text-delta") text += chunk.text;
      else if (chunk.type === "usage") usage = usageFromChunk(chunk);
    }
  } catch (error) {
    // A timeout or an aborted turn is the ordinary way this ends early; the
    // remaining possibility is an adapter failure. Both hand the batch back.
    return null;
  } finally {
    // The spend is real whichever way the stream ended, and this call's tokens
    // never reach a session log, so the ledger is the only place they appear.
    await appendLedger(ctx, {
      kind: "usage",
      purpose: "ask-answer",
      provider: route.provider,
      model: route.model,
      sessionId: agent.session.id,
      ...(usage ?? {
        input: Math.ceil(JSON.stringify(body).length / 4),
        output: Math.ceil(text.length / 4),
        cacheRead: 0,
        cacheWrite: 0,
      }),
      estimated: usage === null,
      chars: text.length,
    });
  }

  const attribution = t("ask.attribution", {
    route: `${route.provider}/${route.model}`,
  });
  return parseAnswerBatch(text, questions, attribution);
}

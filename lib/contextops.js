/**
 * Clearing and compacting a session's context.
 *
 * Both operations are the same transaction with a different summary: pick the
 * whole surface (skipping a system head, which only a `system/message` may
 * rewrite), measure it, then replace it with one checkpoint `user/message`
 * carrying a `compact-checkpoint` source. The platform's own chat reads that
 * shape, so the "context was compacted" marker, its disclosure and its token
 * count all light up without any Client work.
 *
 * The events are written directly rather than through `ctx.compaction`:
 * `compactRegion` only runs while a turn is open and `compactNow` always keeps
 * the newest node, and neither can carry a summary produced elsewhere.
 */

import { randomUUID } from "node:crypto";

import { translatorFor } from "./i18n.js";

const SUMMARY_OPEN_TAG = "<compacted-summary>";
const SUMMARY_CLOSE_TAG = "</compacted-summary>";

/**
 * The `source.kind` every checkpoint this module writes carries.
 *
 * The platform recognizes a checkpoint by this value plus a `compactionId`,
 * so it has to stay exactly this string: the chat UI's compaction marker, the
 * counts it shows and the expandable summary all key off it. What differs
 * between the two operations is `source.origin`, below.
 */
const COMPACT_KIND = "compact-checkpoint";

/**
 * Which operation wrote a checkpoint: `compact` summarized the history,
 * `clear` discarded it.
 *
 * This distinction is what makes clearing after compacting work at all. Both
 * operations leave exactly one surface node, so "already a single checkpoint"
 * cannot by itself mean "nothing to clear" — that reading would treat the
 * summary a compaction just wrote as an empty conversation and refuse to
 * clear it. Only a checkpoint `clear` wrote is nothing-to-clear.
 */
const CLEAR_ORIGIN = "clear";

/**
 * The placeholder text a cleared session keeps.
 *
 * Also the marker that identifies a checkpoint as a clear: sessions cleared
 * before `source.origin` existed carry no such field, and their placeholder is
 * this exact sentence, so matching on it keeps "clear twice" a no-op for old
 * logs too.
 */
const CLEAR_PLACEHOLDER =
  "The user cleared this session's context. Nothing before the messages that follow is retained; continue from them alone.";


/**
 * The framing the platform puts around every checkpoint.
 *
 * Reusing it verbatim keeps a checkpoint written here indistinguishable from
 * one the built-in engine writes, which is what lets the same rendering and
 * the same "do not acknowledge this" instruction hold.
 */
const CHECKPOINT_PREAMBLE =
  "This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.";

/** The instruction the compaction subagent receives. Configurable in settings. */
export const DEFAULT_COMPACT_PROMPT = [
  "Compress the conversation you are given into a checkpoint that lets the assistant continue without re-reading the original.",
  "",
  "Output ONLY the checkpoint text, in Markdown:",
  "- Keep the current goal and constraints, decisions and the reasons behind them, exact file paths with line numbers, function/class/type signatures, verbatim error messages, versions and key numbers, and every still-open objective.",
  "- Drop exploration steps, failed attempts, repeated back-and-forth, and anything already resolved.",
  "- Order the sections by how much the next turn needs them; be concrete, never vague.",
  "- Do NOT mention this request, and do NOT say the context was compacted.",
  "- Do NOT call any tool and do NOT ask questions.",
].join("\n");

/**
 * Scan backwards for the compaction lock, the open turn and the last seed.
 *
 * A `compaction/start` with no later `compaction/end` means a compaction is
 * in flight; a later `session/end-seed` supersedes it. Copied from the
 * platform's own entry-state walk so the two agree on what "busy" means.
 * @param session - the session to inspect.
 * @returns the open turn event, the unmatched start event, and the seed seq.
 */
function inspectEntryState(session) {
  let openTurn = null;
  let openTurnKnown = false;
  let unmatched;
  let compactionKnown = false;
  let latestEndSeed;
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq);
    if (latestEndSeed === undefined && event.type === "session/end-seed")
      latestEndSeed = event.seq;
    if (!compactionKnown) {
      if (event.type === "compaction/start") {
        unmatched = event;
        compactionKnown = true;
      } else if (event.type === "compaction/end") compactionKnown = true;
    }
    if (!openTurnKnown) {
      if (event.type === "turn/start") {
        openTurn = event.data.turn;
        openTurnKnown = true;
      } else if (event.type === "turn/end") openTurnKnown = true;
    }
    if (openTurnKnown && compactionKnown && latestEndSeed !== undefined) break;
  }
  return { openTurn, unmatched, latestEndSeed };
}

/**
 * Resolve the live agent behind a session id.
 *
 * The dock buttons only know the session they were rendered for, and an agent
 * is keyed by that same id for roots as well as children.
 * @param ctx - the Host context.
 * @param sessionId - the session the buttons were rendered for.
 * @returns the live agent, or undefined when the session has none.
 */
export function agentForSession(ctx, sessionId) {
  if (typeof sessionId !== "string" || sessionId === "") return undefined;
  const agents = ctx.get("agents");
  const direct = agents?.get?.(sessionId);
  if (direct !== undefined && direct !== null) return direct;
  for (const agent of agents?.list?.() ?? []) {
    if (agent?.session?.id === sessionId) return agent;
  }
  return undefined;
}

/**
 * Run `job` while the agent is guaranteed idle.
 *
 * The platform's own manual compaction uses this guard, so a prompt arriving
 * mid-operation waits instead of racing the surface rewrite.
 * @param agent - the agent to guard.
 * @param job - the work; receives the maintenance abort signal.
 * @param t - translator for the one refusal this guard can report.
 * @returns whatever the job returned.
 */
async function whileIdle(agent, job, t) {
  let outcome;
  try {
    await agent.runMaintenance(async (agentSignal) => {
      outcome = await job(agentSignal);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("already has active work"))
      throw new Error(t("error.busy"));
    throw error instanceof Error ? error : new Error(message);
  }
  return outcome;
}

/**
 * Format the quantified line the disclosure shows above the summary.
 * @param stats - the measured counts.
 * @returns a compact, language-neutral statistics line.
 */
function statsLine(stats) {
  const group = (value) => value.toLocaleString("en-US");
  return [
    `${group(stats.beforeTokens)} → ${group(stats.afterTokens)} tokens`,
    `${group(stats.chars)} chars`,
    `${group(stats.items)} items`,
  ].join(" · ");
}

/**
 * Whether a checkpoint is a placeholder `clear` wrote rather than a summary
 * `compact` wrote.
 *
 * Two ways to know, because the field is younger than the plugin: checkpoints
 * written since it was added carry `source.origin`, and older ones are
 * recognized by their placeholder text. Both are needed for a session cleared
 * before the update — without the second check, clearing it again would try to
 * rewrite one placeholder with an identical one and fail the size test.
 * @param data - the checkpoint's `data`.
 * @returns true when the checkpoint holds no history worth clearing.
 */
function isClearCheckpoint(data) {
  if (data?.source?.origin === CLEAR_ORIGIN) return true;
  const parts = Array.isArray(data?.content) ? data.content : [];
  return parts.some(
    (part) => part?.type === "text" && part.text === CLEAR_PLACEHOLDER,
  );
}

/**
 * Replace a session's whole surface with one checkpoint.
 *
 * Everything up to the appends is synchronous, so no turn can interleave
 * between the idle check and the rewrite; only the flush that hands the new
 * surface to the client is awaited.
 * @param ctx - the Host context.
 * @param agent - the agent owning the session.
 * @param input - the summary blocks and their provenance.
 * @returns the applied counts, or null when there was nothing to replace.
 */
async function replaceSurface(ctx, agent, input) {
  const t = translatorFor(ctx);
  const session = agent.session;
  const nodes = session.surface.nodes;
  if (nodes.length === 0) return null;
  const firstIdx = session.eventAt(nodes[0])?.type === "system/message" ? 1 : 0;
  if (firstIdx >= nodes.length) return null;

  const state = inspectEntryState(session);
  if (
    state.unmatched !== undefined &&
    !(
      state.latestEndSeed !== undefined &&
      state.latestEndSeed > state.unmatched.seq
    )
  )
    throw new Error(t("error.inFlight"));
  if (state.openTurn !== null) throw new Error(t("error.busy"));

  const start = nodes[firstIdx];
  const end = nodes[nodes.length - 1];
  const shadowedSeqs = nodes.slice(firstIdx);

  // Already cleared: rewriting one placeholder with another identical one
  // would only trip the "must be smaller" check below, and nothing to do is a
  // success rather than an error. A checkpoint left by `compact` is *not*
  // this case — it holds a summary, and clearing it after compacting is a
  // real request that must go through.
  if (shadowedSeqs.length === 1) {
    const only = session.eventAt(shadowedSeqs[0]);
    if (
      only?.type === "user/message" &&
      only.data?.source?.kind === COMPACT_KIND &&
      isClearCheckpoint(only.data)
    )
      return null;
  }

  const measurement = ctx.tokenMeter.measure(session);
  const priced = new Map(measurement.nodes.map((node) => [node.seq, node]));
  let beforeTokens = 0;
  let routeTokens = 0;
  let aligned = true;
  for (const seq of shadowedSeqs) {
    const node = priced.get(seq);
    if (node === undefined) {
      aligned = false;
      continue;
    }
    beforeTokens += node.heuristicTokens;
    routeTokens += node.tokens;
  }

  const compactionId = randomUUID();
  // No `sourceCommandId` on any of these events, deliberately. The chat UI
  // routes a checkpoint that names a command into its command Definition,
  // which only renders the compaction marker when that command is literally
  // named "compact". Our names are not, so the events would collapse into a
  // plain command row and lose the "context compacted" marker, the counts,
  // and the expandable summary. Leaving it off lands them in the automatic
  // compaction Definition, which renders all of that.
  const source = { kind: COMPACT_KIND, compactionId };
  // Round-trips through the log, so only the two values this module writes
  // are accepted; an older checkpoint written before this field existed has
  // no `origin` and is therefore treated as a compaction, which is right for
  // every log this plugin ever produced.
  if (input.origin === CLEAR_ORIGIN) source.origin = CLEAR_ORIGIN;
  const checkpoint = {
    id: randomUUID(),
    role: "user",
    content: [
      { type: "text", text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
      ...input.summary,
      { type: "text", text: SUMMARY_CLOSE_TAG },
    ],
    source,
  };
  const afterTokens = ctx.tokenMeter.estimateMessage(checkpoint);
  // A compaction must leave the session smaller — that is its whole purpose,
  // and the platform refuses a checkpoint that is not. Clearing is a
  // different promise: it discards the history and leaves one line saying so,
  // and that line can legitimately measure larger than a checkpoint that is
  // already a short summary. Refusing the clear there would leave the user
  // unable to throw away a summary they no longer want, so the size test
  // applies to compact only. A misaligned measurement still cannot prove
  // anything and is skipped either way.
  const shrinking = input.origin !== CLEAR_ORIGIN;
  if (shrinking && aligned && afterTokens >= routeTokens)
    throw new Error(
      t("error.notSmaller", {
        after: afterTokens,
        before: routeTokens,
      }),
    );

  const lifecycle = { compactionId, turn: null };
  const startEvent = session.append("compaction/start", lifecycle);
  let closing = false;
  try {
    const summaryEvent = session.append("compaction/summary", {
      compactionId,
      summary: input.summary,
      shadowedRange: { start, end },
      shadowedSeqs: [...shadowedSeqs],
      shadowedTokenCount: beforeTokens,
      ...(input.provider === undefined ? {} : { provider: input.provider }),
      ...(input.model === undefined ? {} : { model: input.model }),
    });
    session.append("user/message", checkpoint, {
      surfaceOp: { op: "replace", startSeq: start, endSeq: end },
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
    });
    closing = true;
    session.append("compaction/end", lifecycle);
    // The platform's own manual compaction flushes after the pair closes, and
    // without it the client keeps the surface it had: the events are on disk
    // but nothing tells the open view to re-read them.
    const sessions = ctx.get?.("sessions");
    if (typeof sessions?.flush === "function") await sessions.flush(session);
  } catch (error) {
    if (!closing) {
      // Leave the lock released: an unmatched start would block every later
      // compaction on this session.
      try {
        session.append("compaction/end", {
          ...lifecycle,
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        /* the original error is the one worth reporting */
      }
    }
    throw error;
  }

  const chars = input.summary.reduce(
    (total, block) =>
      total + (typeof block.text === "string" ? block.text.length : 0),
    0,
  );
  return {
    items: shadowedSeqs.length,
    beforeTokens,
    afterTokens,
    chars,
    stats: statsLine({
      beforeTokens,
      afterTokens,
      chars,
      items: shadowedSeqs.length,
    }),
  };
}

/**
 * Replace a session's whole surface with a minimal placeholder.
 *
 * The placeholder is deliberately tiny: the "not smaller" check would reject
 * a clear on a session whose history is already shorter than the framing.
 * @param ctx - the Host context.
 * @param agent - the agent owning the session.
 * @param input - provenance for the checkpoint.
 * @returns the applied counts, or null when there was nothing to clear.
 */
export async function clearContext(ctx, agent, input = {}) {
  return whileIdle(
    agent,
    async () =>
      replaceSurface(ctx, agent, {
        ...input,
        origin: CLEAR_ORIGIN,
        summary: [{ type: "text", text: CLEAR_PLACEHOLDER }],
      }),
    translatorFor(ctx),
  );
}

/**
 * Summarize a session's whole surface through a forked subagent.
 *
 * The fork inherits the parent's completed turns, so the subagent reads the
 * very history being replaced instead of a re-serialized copy of it.
 * @param ctx - the Host context.
 * @param agent - the parent agent, which must be idle for the snapshot.
 * @param input - the instruction plus the optional model override.
 * @returns the subagent's text output.
 */
/**
 * Share of the summarizer's context window the inherited history may fill.
 *
 * Not the whole window: the instruction, the tool schemas and the model's own
 * answer share the same budget, so a history that exactly fills it leaves no
 * room to write a summary about it.
 */
const SUMMARY_SHARE = 2 / 3;

/** Characters per token, the density the platform's own meter estimates at. */
const CHARS_PER_TOKEN = 4;

/** Share of the excerpt budget reserved for the oldest messages. */
const HEAD_SHARE = 0.4;

/** Smallest excerpt worth sending; below this the summary is not a summary. */
const MIN_EXCERPT_CHARS = 4_000;

/**
 * Render one message as the plain text a summarizer reads.
 *
 * Reasoning is dropped on purpose: it is the largest and least useful part of
 * a long history, and a summary that spends its budget on what the model was
 * thinking about re-reads worse than one built from what was actually said.
 * @param message - the message derived from a surface event.
 * @returns its textual form; empty when nothing worth reading remains.
 */
function renderMessage(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  const parts = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string")
      parts.push(block.text);
    else if (block?.type === "tool-call")
      parts.push(`[call ${typeof block.name === "string" ? block.name : ""}]`);
    else if (block?.type === "image") parts.push("[image]");
  }
  return parts.join("\n").trim();
}

/**
 * Build a head-and-tail excerpt that fits the summarizer's budget.
 *
 * The head keeps the goal and the constraints stated at the start; the tail
 * keeps whatever is still in progress. The middle is what a checkpoint needs
 * least, and dropping it explicitly — with a marker the summarizer can read —
 * is better than handing the model a request it cannot answer.
 * @param ctx - the Host context.
 * @param agent - the agent whose history is being excerpted.
 * @param limitTokens - the token budget the excerpt must fit.
 * @param t - translator for the omission marker.
 * @returns the excerpt, or null when the history renders to nothing.
 */
function buildExcerpt(ctx, agent, limitTokens, t) {
  const session = agent.session;
  const blocks = [];
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    if (event === undefined) continue;
    const text = renderMessage(session.deriveEventMessage(event));
    if (text !== "") blocks.push(text);
  }
  if (blocks.length === 0) return null;

  const budget = Math.max(
    MIN_EXCERPT_CHARS,
    Math.floor(limitTokens * CHARS_PER_TOKEN),
  );
  const head = [];
  let used = 0;
  const headBudget = Math.floor(budget * HEAD_SHARE);
  for (const text of blocks) {
    if (used + text.length > headBudget) break;
    head.push(text);
    used += text.length;
  }
  const tail = [];
  for (let index = blocks.length - 1; index >= head.length; index -= 1) {
    const text = blocks[index];
    if (used + text.length > budget) break;
    tail.unshift(text);
    used += text.length;
  }
  if (head.length === 0 && tail.length === 0) return null;
  const omitted = blocks.length - head.length - tail.length;
  return [
    ...head,
    ...(omitted <= 0
      ? []
      : [t("prompt.excerptGap", { items: omitted, tokens: limitTokens })]),
    ...tail,
  ].join("\n\n");
}

/**
 * The route the summarizer is going to run on.
 *
 * The configured compaction target wins over the session's own route, because
 * that is the model whose window the settings slider measures against and the
 * one the user picked for this job.
 * @param ctx - the Host context.
 * @param agent - the agent being compacted.
 * @param provider - the configured provider, or an empty string.
 * @param model - the configured model, or an empty string.
 * @returns the route plus its context window; null when unresolvable.
 */
async function resolveRoute(ctx, agent, provider, model) {
  const requested = agent.session.requestHeader?.()?.config;
  const routeProvider = provider === "" ? (requested?.provider ?? "") : provider;
  const routeModel = model === "" ? (requested?.model ?? "") : model;
  const llm = ctx.get("llm");
  if (llm === undefined || routeProvider === "" || routeModel === "")
    return { provider: routeProvider, model: routeModel, contextWindow: null };
  try {
    const info = await llm.resolveModelInfo(routeProvider, routeModel);
    const window = info?.context?.contextWindow;
    return {
      provider: routeProvider,
      model: routeModel,
      contextWindow: Number.isInteger(window) && window > 0 ? window : null,
    };
  } catch {
    // An adapter that cannot describe the route must not turn into a failed
    // compaction: falling through to the unguarded fork is what this plugin
    // did before the guard existed, and it is still the right answer when the
    // window is genuinely unknown.
    return { provider: routeProvider, model: routeModel, contextWindow: null };
  }
}

/**
 * Summarize a session's whole surface through a forked subagent.
 *
 * The fork inherits the parent's completed turns, so the subagent reads the
 * very history being replaced instead of a re-serialized copy of it. That is
 * exactly what makes compaction work — and exactly what makes it fail on a
 * session already past the model's window: the summarizer is asked to read a
 * history larger than any context it can hold, so the request either errors
 * out or hangs with no response.
 *
 * The guard below is therefore not an optimization. It measures the same
 * history the child would inherit and compares it to the window of the model
 * that would read it. A history that cannot fit switches the child from
 * `fork` (inherits the history) to `spawn` (starts empty) and hands it a
 * bounded excerpt instead, so compaction still succeeds on exactly the
 * sessions that most need it.
 * @param ctx - the Host context.
 * @param agent - the parent agent, which must be idle for the snapshot.
 * @param input - the instruction plus the optional model override.
 * @returns the subagent's text output.
 */
async function summarizeWithSubagent(ctx, agent, input) {
  const t = translatorFor(ctx);
  const subagents = ctx.get("subagents");
  if (subagents === undefined) throw new Error(t("error.noSubagent"));
  const model = typeof input.model === "string" ? input.model.trim() : "";
  const provider =
    typeof input.provider === "string" ? input.provider.trim() : "";
  // `startActivation` reads `spec.signal.throwIfAborted()` unconditionally, so
  // a signal is required even when the caller has none to pass; an inert one
  // keeps the contract without inventing a cancellation source.
  const signal = input.signal ?? new AbortController().signal;
  // --- guarded summarization starts here ---
  const inherited = (() => {
    try {
      return ctx.tokenMeter?.measure?.(agent.session)?.totalTokens ?? 0;
    } catch {
      return 0;
    }
  })();
  const route = await resolveRoute(ctx, agent, provider, model);
  const limit =
    route.contextWindow === null
      ? null
      : Math.floor(route.contextWindow * SUMMARY_SHARE);
  let excerpt = null;
  if (limit !== null && inherited > limit) {
    excerpt = buildExcerpt(ctx, agent, limit, t);
    if (excerpt === null)
      throw new Error(t("error.tooLarge", { tokens: inherited, limit }));
  }
  const receipt = await subagents.startActivation({
    // `fork` when the child can hold the history, `spawn` when it cannot: a
    // fork would re-inherit the untruncated history and hit the very failure
    // this branch exists to avoid.
    provider: excerpt === null ? "fork" : "spawn",
    label: "context compaction",
    request: {
      parent: agent,
      prompt: [
        {
          type: "text",
          text:
            excerpt === null ? input.prompt : `${input.prompt}\n\n${excerpt}`,
        },
      ],
      ...(model === ""
        ? {}
        : {
            agentOptions: {
              ...(provider === "" ? {} : { provider }),
              model,
            },
          }),
    },
    signal,
    // `parent` announces the child's result back into this session, which
    // wakes a fresh turn and makes the idle guard below reject its own
    // rewrite. `caller` hands the output to this call and touches nothing
    // else in the parent.
    delivery: "caller",
  });
  const outcome = await receipt.result;
  const parts = Array.isArray(outcome?.output) ? outcome.output : [];
  const text = parts
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (text === "") throw new Error(t("error.noSummary"));
  return text.replace(/^```(?:markdown)?\s*/i, "").replace(/\s*```$/, "");
}

/**
 * Replace a session's whole surface with a subagent-written checkpoint.
 *
 * The subagent runs before the guard is taken so a long model call does not
 * hold the agent; the rewrite itself is then re-measured against whatever the
 * surface is at that moment.
 * @param ctx - the Host context.
 * @param agent - the agent owning the session.
 * @param input - the instruction, model override and provenance.
 * @returns the applied counts, or null when there was nothing to replace.
 */
export async function compactContext(ctx, agent, input = {}) {
  const session = agent.session;
  const nodes = session.surface.nodes;
  const firstIdx =
    nodes.length > 0 && session.eventAt(nodes[0])?.type === "system/message"
      ? 1
      : 0;
  if (firstIdx >= nodes.length) return null;
  const t = translatorFor(ctx);
  const state = inspectEntryState(session);
  if (
    state.unmatched !== undefined &&
    !(
      state.latestEndSeed !== undefined &&
      state.latestEndSeed > state.unmatched.seq
    )
  )
    throw new Error(t("error.inFlight"));
  if (state.openTurn !== null) throw new Error(t("error.busy"));

  const prompt =
    typeof input.prompt === "string" && input.prompt.trim() !== ""
      ? input.prompt
      : DEFAULT_COMPACT_PROMPT;
  const text = await summarizeWithSubagent(ctx, agent, { ...input, prompt });

  return whileIdle(agent, async () =>
    replaceSurface(ctx, agent, {
      ...input,
      summary: [{ type: "text", text }],
    }),
  );
}

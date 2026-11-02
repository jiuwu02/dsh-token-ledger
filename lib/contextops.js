/**
 * Clearing and compacting a session's context.
 *
 * Both operations write the same shape: one checkpoint `user/message` carrying
 * a `compact-checkpoint` source, placed by a `replace` surface operation. The
 * platform's own chat reads that shape, so the "context was compacted" marker,
 * its disclosure and its token count all light up without any Client work.
 *
 * They differ in span and in when they may run. Clearing replaces the *whole*
 * surface and therefore needs an idle session — a step appending during the
 * rewrite would be dropped with the history it belongs to. Compacting replaces
 * only the span it selected *before* summarizing, which ends at the last cut
 * that does not split a tool-call/result pair. Everything the conversation
 * writes while the summarizer runs lands after that cut and is replayed
 * verbatim behind the checkpoint, so compacting works mid-turn.
 *
 * The events are written directly rather than through `ctx.compaction`:
 * `compactRegion` only runs while a turn is open and insists the whole surface
 * is unchanged across the model call, which is the pause this exists to avoid;
 * `compactNow` always keeps the newest node and requires an idle agent.
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
 * Clearing holds this guard because it replaces the *whole* surface: a step
 * that appends while the rewrite runs would be dropped along with the history
 * it belongs to, and there is nothing left to replay it after. Compacting does
 * not take it — it replaces a span behind the running step, which is what lets
 * it run mid-conversation. In maintenance the agent looks idle to the UI and a
 * prompt arriving meanwhile is queued rather than raced.
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
 * Whether each cut right after a surface node leaves no tool call unanswered.
 *
 * A compaction may only end on such a cut. Replacing a span that splits a
 * tool-call/result pair would leave the replayed request holding a result with
 * no preceding call, which the provider rejects. The platform folds the same
 * rule over the same surface before it compacts; this plugin writes its own
 * events, so it has to fold the rule itself instead of inheriting it.
 * @param session - the session whose surface is measured.
 * @param seqs - current surface nodes, in order.
 * @returns one boolean per node: true when the cut after it is balanced.
 */
function pairingCuts(session, seqs) {
  const cuts = new Map();
  let open = 0;
  for (const seq of seqs) {
    const event = session.eventAt(seq);
    if (event?.type === "assistant/message") {
      const content = Array.isArray(event.data?.message?.content)
        ? event.data.message.content
        : [];
      open += content.filter((block) => block?.type === "tool-call").length;
    } else if (event?.type === "tool/result") open -= 1;
    cuts.set(seq, open === 0);
  }
  return cuts;
}

/**
 * The span a compaction replaces, measured at the moment it is asked for.
 *
 * The end is the surface tail at this instant, not the tail the summary
 * eventually lands on: everything the session appends while the summarizer
 * runs is newer than this cut, so it stays outside the replacement and is
 * replayed after the checkpoint exactly as it was written. That is what lets a
 * compaction run without stopping the conversation.
 *
 * `unfinished` reports that the span reaches past the last `turn/end`. The
 * fork summarizer can only seed a child from a completed turn, so the caller
 * summarizes a rendered excerpt in that case instead of losing that tail.
 * @param session - the session being compacted.
 * @returns the span plus the two derived flags, or null when nothing qualifies.
 */
function selectCompactSpan(session) {
  const nodes = session.surface.nodes;
  if (nodes.length === 0) return null;
  const firstIdx = session.eventAt(nodes[0])?.type === "system/message" ? 1 : 0;
  if (firstIdx >= nodes.length) return null;
  const cuts = pairingCuts(session, nodes);
  let endIdx = nodes.length - 1;
  while (endIdx >= firstIdx && cuts.get(nodes[endIdx]) !== true) endIdx -= 1;
  if (endIdx < firstIdx) return null;
  const shadowedSeqs = nodes.slice(firstIdx, endIdx + 1);
  const lastEnd = session
    .snapshotEvents()
    .findLast((event) => event.type === "turn/end");
  return {
    start: shadowedSeqs[0],
    end: shadowedSeqs[shadowedSeqs.length - 1],
    shadowedSeqs,
    unfinished:
      lastEnd === undefined ||
      shadowedSeqs.some((seq) => seq > lastEnd.seq),
  };
}

/**
 * Open the compaction lock and keep what closing it again needs.
 *
 * Written before the summarizer is asked for anything, so the durable marker
 * is the lock while the model runs: a second request is then refused with
 * "already in flight" instead of summarizing the same history twice, and the
 * platform's own engine backs off instead of racing this one. `turn` names the
 * turn that was open when the compaction started, because a compaction begun
 * mid-turn belongs to that turn; it is null when the session was idle.
 * @param session - the session being compacted.
 * @param turn - the open turn at the time of the call, or null.
 * @returns the id, the lifecycle both closing events share, and the opener.
 */
function openCompaction(session, turn) {
  const compactionId = randomUUID();
  const lifecycle = { compactionId, turn: turn ?? null };
  return {
    compactionId,
    lifecycle,
    closed: false,
    start: session.append("compaction/start", lifecycle),
  };
}

/**
 * Release an opened compaction lock after a failure.
 *
 * Two callers can reach a failure — the summarizer and the rewrite — and only
 * one of them should close the pair. `closed` makes that safe instead of
 * requiring each caller to know how far the other got: a start left unmatched
 * would block every later compaction on the session, a second end would be a
 * stray event. It deliberately swallows its own error; the failure that got
 * here is the one worth reporting.
 * @param session - the session holding the lock.
 * @param opened - the result of {@link openCompaction}.
 * @param error - what went wrong.
 */
function closeCompaction(session, opened, error) {
  if (opened.closed) return;
  opened.closed = true;
  try {
    session.append("compaction/end", {
      ...opened.lifecycle,
      error: error instanceof Error ? error.message : String(error),
    });
  } catch {
    /* the original error is the one worth reporting */
  }
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
 * Require a previously selected span to still be the same replacement target.
 *
 * The conversation keeps running while the summarizer works, so the surface
 * has moved on. What must not have moved is the span itself: the same nodes,
 * in the same order, still contiguous. Nodes appended after it are the point
 * of the feature, not a reason to fail.
 * @param session - the session whose surface is checked.
 * @param span - the selected span.
 * @param t - translator for the refusal.
 */
function assertSpanStable(session, span, t) {
  const nodes = session.surface.nodes;
  const startIdx = nodes.indexOf(span.start);
  const endIdx = nodes.indexOf(span.end);
  const guarded =
    startIdx !== -1 &&
    endIdx !== -1 &&
    startIdx <= endIdx &&
    endIdx - startIdx + 1 === span.shadowedSeqs.length &&
    span.shadowedSeqs.every((seq, offset) => nodes[startIdx + offset] === seq);
  if (!guarded) throw new Error(t("error.changed"));
}

/**
 * Replace a span of a session's surface with one checkpoint.
 *
 * Two callers, two spans. Clearing names no span and takes the whole surface,
 * which is only safe on an idle session. Compacting passes the span it selected
 * before summarizing, and everything the conversation wrote in the meantime
 * stays on the surface after the checkpoint — that is what makes it possible to
 * compact without stopping the conversation.
 *
 * @param ctx - the Host context.
 * @param agent - the agent owning the session.
 * @param input - the summary blocks, their provenance, and the optional span.
 * @returns the applied counts, or null when there was nothing to replace.
 */
async function replaceSurface(ctx, agent, input) {
  const t = translatorFor(ctx);
  const session = agent.session;
  // Set as soon as a pair exists that has not landed yet. Every failure below
  // releases it: a start left unmatched would block every later compaction on
  // the session, and the caller that opened it cannot know how far this got.
  let active = input.opened;
  let landed = false;
  try {
    const nodes = session.surface.nodes;
    if (nodes.length === 0) return null;
    const firstIdx =
      session.eventAt(nodes[0])?.type === "system/message" ? 1 : 0;
    if (firstIdx >= nodes.length) return null;

    const state = inspectEntryState(session);
    // The caller may already hold the lock — compacting opens it before the
    // model call — and that opener is the `unmatched` start this would find.
    // Only a *different* unmatched start means someone else is compacting.
    const foreign =
      state.unmatched !== undefined &&
      state.unmatched.seq !== input.opened?.start.seq;
    if (
      foreign &&
      !(
        state.latestEndSeed !== undefined &&
        state.latestEndSeed > state.unmatched.seq
      )
    )
      throw new Error(t("error.inFlight"));

    // Only clearing insists on an idle session. Compacting a span that ends at
    // a completed step is safe mid-turn: the span sits behind the running step
    // and the replacement leaves everything after it untouched.
    const span = input.span ?? {
      start: nodes[firstIdx],
      end: nodes[nodes.length - 1],
      shadowedSeqs: nodes.slice(firstIdx),
    };
    if (input.span === undefined && state.openTurn !== null)
      throw new Error(t("error.busy"));
    // A span selected before the summarizer ran is rechecked here, because the
    // conversation kept going in the meantime.
    if (input.span !== undefined) assertSpanStable(session, span, t);

    const { start, end, shadowedSeqs } = span;

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

    const compactionId = active?.compactionId ?? randomUUID();
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

    // A caller that opened the lock before summarizing hands it over here; the
    // interactive path opens it now. Either way the pair brackets the body, so
    // the log records one compaction and it holds the lock the whole time.
    active = active ?? openCompaction(session, state.openTurn);
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
      sourceEventSeqs: [
        active.start.seq,
        summaryEvent.seq,
        ...shadowedSeqs,
      ],
    });
    // `landed` flips only once the pair is really closed: an `end` that failed
    // to append must still be retried by the catch below, or the lock would
    // outlive the failure and block every later compaction.
    session.append("compaction/end", active.lifecycle);
    landed = true;
    active.closed = true;
    // The platform's own manual compaction flushes after the pair closes, and
    // without it the client keeps the surface it had: the events are on disk
    // but nothing tells the open view to re-read them.
    const sessions = ctx.get?.("sessions");
    if (typeof sessions?.flush === "function") await sessions.flush(session);

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
  } catch (error) {
    if (!landed && active !== undefined) closeCompaction(session, active, error);
    throw error;
  }
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
 * @param only - the surface nodes to render, in order; the whole surface when
 *   omitted. A compaction passes its own span so the excerpt matches the span
 *   the checkpoint will replace.
 * @returns the excerpt, or null when the history renders to nothing.
 */
function buildExcerpt(ctx, agent, limitTokens, t, only) {
  const session = agent.session;
  const blocks = [];
  for (const seq of only ?? session.surface.nodes) {
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
 * @param agent - the parent agent.
 * @param input - the instruction, the optional model override, and the span
 *   being compacted when the caller already selected one.
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
  // A fork seeds its child from the parent's last completed turn, so the turn
  // in flight is invisible to it. When the span reaches into that turn — which
  // it does whenever the session is running — the fork would summarize a
  // history missing the very messages being replaced. Rendering the span
  // instead costs one copy of its text and keeps the summary faithful.
  const overBudget = limit !== null && inherited > limit;
  const rendered =
    input.span !== undefined && (input.span.unfinished || overBudget)
      ? buildExcerpt(ctx, agent, limit ?? inherited, t, input.span.shadowedSeqs)
      : null;
  const excerpt =
    rendered ?? (overBudget ? buildExcerpt(ctx, agent, limit, t) : null);
  if (overBudget && excerpt === null)
    throw new Error(t("error.tooLarge", { tokens: inherited, limit }));
  const receipt = await subagents.startActivation({
    // `fork` when the child can hold the history and no span was rendered,
    // `spawn` whenever an excerpt has to be handed over: a fork would
    // re-inherit the untruncated history and hit the very failure the excerpt
    // exists to avoid.
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
 * Replace the completed part of a session's surface with a subagent summary.
 *
 * Works while the conversation is running, which is the whole point: the span
 * is fixed before the summarizer starts, so every step the conversation takes
 * during that call lands after the cut and is replayed verbatim behind the
 * checkpoint. Nothing is stopped to make room for it.
 *
 * Three things are deliberately not locked. The agent is not held in
 * maintenance, because that is exactly the pause this avoids. The span stops
 * at the last balanced cut rather than at the tail, because a span ending on an
 * open tool call could not be replaced without splitting the pair. And the
 * compaction lock is taken before the model is called, so the session refuses a
 * second compaction instead of paying for the same summary twice.
 * @param ctx - the Host context.
 * @param agent - the agent owning the session.
 * @param input - the instruction, model override and provenance.
 * @returns the applied counts, or null when there was nothing to replace.
 */
export async function compactContext(ctx, agent, input = {}) {
  const t = translatorFor(ctx);
  const session = agent.session;
  const state = inspectEntryState(session);
  if (
    state.unmatched !== undefined &&
    !(
      state.latestEndSeed !== undefined &&
      state.latestEndSeed > state.unmatched.seq
    )
  )
    throw new Error(t("error.inFlight"));
  const span = selectCompactSpan(session);
  if (span === null) return null;

  const prompt =
    typeof input.prompt === "string" && input.prompt.trim() !== ""
      ? input.prompt
      : DEFAULT_COMPACT_PROMPT;
  // Taken before the summarizer runs, and released by replaceSurface on every
  // failure path, so a concurrent request is refused rather than duplicated.
  const opened = openCompaction(session, state.openTurn);
  let landed = false;
  try {
    // The span goes to the summarizer so it can tell whether the fork really
    // inherited everything being replaced; see `unfinished` in
    // `selectCompactSpan`.
    const text = await summarizeWithSubagent(ctx, agent, {
      ...input,
      prompt,
      span,
    });
    const result = await replaceSurface(ctx, agent, {
      ...input,
      span,
      opened,
      summary: [{ type: "text", text }],
    });
    landed = true;
    return result;
  } catch (error) {
    if (!landed) closeCompaction(session, opened, error);
    throw error;
  }
}

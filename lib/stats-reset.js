/**
 * Zero the platform's 「会话统计」dialog at a clear-context checkpoint.
 *
 * The chat UI reads two whole-log projection units — `sessionStats` (turns,
 * steps, model/tool/TTFT/decode times) and `tokenUsage` (input, cache and
 * output tokens). Both are deliberately monotonic: paging and compaction
 * must not change them. Clearing the context is different — the whole
 * history is discarded, so keeping those totals would leave a dashboard
 * full of numbers for a conversation that no longer exists.
 *
 * The platform bundles are packed into a read-only app.asar, so the plugin
 * cannot edit their sources. It does not have to: the Host's projection
 * registry keeps every unit in a public `registrations` Map, and every fold
 * path (live `drive`, lazy `buildCell`, cold `restore`) reads
 * `registration.def.apply` at call time. Wrapping that one function in place
 * therefore changes the fold for future events AND for a full refold after a
 * restart, without duplicating a single line of upstream logic: the reset
 * state is the unit's own `init()`, which is by construction schema-valid and
 * needs no `stateVersion` bump.
 *
 * A changed state reference is enough for `drive` to emit a zero view on the
 * control stream; the client's projection store is higher-seq-wins, so the
 * zero frame replaces the pre-clear nonzero row. A `WeakMap` of cells keeps
 * the reset per session — one window clearing cannot touch another.
 */

/** The marker the plugin writes on a clear checkpoint. */
export const CLEAR_ORIGIN = "clear";

/**
 * The one-line summary a clear leaves behind.
 *
 * Also the fallback marker for logs written before `source.origin` existed.
 * Keep in sync with lib/contextops.js:62-63.
 */
export const CLEAR_PLACEHOLDER =
  "The user cleared this session's context. Nothing before the messages that follow is retained; continue from them alone.";

/** The projection keys whose wire views feed the 会话统计 dialog. */
export const RESET_KEYS = ["sessionStats", "tokenUsage"];

/**
 * Recognise a clear checkpoint that carries ONLY the placeholder text.
 *
 * replaceSurface always writes `source.origin === "clear"`, but a built-in
 * compaction checkpoint that happens to contain the same sentence has no
 * such marker. Restrict the compaction/summary match to placeholder-only
 * summaries so an ordinary summary can never be mistaken for a clear.
 */
function isPlaceholderSummary(event) {
  if (event?.type !== "compaction/summary") return false;
  const parts = Array.isArray(event.data?.summary) ? event.data.summary : [];
  return (
    parts.length > 0 &&
    parts.every(
      (part) => part?.type === "text" && part.text === CLEAR_PLACEHOLDER,
    )
  );
}

/**
 * Whether one committed event is a clear-context marker.
 *
 * The plugin appends `compaction/summary` then a `user/message` checkpoint.
 * Either carries the clear: the summary holds the exact placeholder text and
 * the checkpoint carries `source.origin === "clear"`. Compaction (manual or
 * automatic) writes the same event types but neither marker, so its totals
 * keep accumulating — only 清空上下文 resets.
 *
 * @param event - a committed session event.
 * @returns true when the event opens a fresh statistics epoch.
 */
export function isContextClear(event) {
  if (event === null || typeof event !== "object") return false;
  if (isPlaceholderSummary(event)) return true;
  if (event.type !== "user/message") return false;
  if (event.data?.source?.origin === CLEAR_ORIGIN) return true;
  // A plain user message reading the placeholder (or a built-in compaction
  // checkpoint that happens to quote it) is not a clear: require the
  // checkpoint's own `compact-checkpoint` source kind as well.
  if (event.data?.source?.kind !== "compact-checkpoint") return false;
  const parts = Array.isArray(event.data?.content) ? event.data.content : [];
  return parts.some(
    (part) => part?.type === "text" && part.text === CLEAR_PLACEHOLDER,
  );
}

/**
 * Wrap the two whole-log folds in a live projection registry.
 *
 * Registration order is not guaranteed: some units may already be registered
 * when this plugin mounts, others may mount later. Both cases are covered —
 * the existing Map entries are wrapped now, and `register` is intercepted so
 * a later `sessionStats`/`tokenUsage` registration is wrapped on arrival.
 *
 * Everything is reversible. If the registry shape ever changes, this is a
 * logged no-op rather than a crash: the plugin must never take the Host down
 * over a statistics nicety.
 *
 * @param projections - the Host's `ctx.sessionProjections` service.
 * @param log - optional warning sink.
 * @returns a disposer restoring the original `register` and `apply` functions.
 */
export function installStatsReset(projections, log = () => {}) {
  const registrations = projections?.registrations;
  const originalRegister = projections?.register;
  if (!(registrations instanceof Map) || typeof originalRegister !== "function") {
    log(
      "the projection registry exposes no public registrations Map; the 会话统计 clear reset is skipped",
    );
    return () => {};
  }

  /** Original apply per wrapped def, so unload can put everything back. */
  const saved = [];

  const wrap = (def) => {
    if (def === undefined || def === null) return;
    if (saved.some((entry) => entry.def === def)) return;
    const apply = def.apply;
    const init = def.init;
    if (typeof apply !== "function" || typeof init !== "function") return;
    saved.push({ def, apply });
    def.apply = (state, event) =>
      isContextClear(event) ? init() : apply(state, event);
  };

  const wrapKey = (key, registry) => {
    if (!RESET_KEYS.includes(key)) return;
    const registration = registry.get(key);
    if (registration !== undefined) wrap(registration?.def);
  };

  // Units that registered before this plugin mounted.
  for (const key of registrations.keys()) wrapKey(key, registrations);

  // Units that register afterwards.
  projections.register = function (definition) {
    const result = originalRegister.call(this, definition);
    try {
      wrapKey(definition?.key, this.registrations ?? registrations);
    } catch (error) {
      log(
        `could not wrap projection ${String(definition?.key)}: ${String(error)}`,
      );
    }
    return result;
  };

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    projections.register = originalRegister;
    for (const { def, apply } of saved) def.apply = apply;
  };
}

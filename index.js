/**
 * dsh-token-ledger — Host half.
 *
 * Reads every stored session's event log through the `sessionPersistence`
 * service, folds the `usage` carried by each `assistant/message` event into
 * hourly, per-model slots, keeps the result in a revision-keyed local cache,
 * prices those slots against the configured billing rules, and serves the
 * result to the Client half over a fenced HTTP route.
 *
 * The session log is the only source of truth: the cache is a derived read
 * model whose entries are invalidated by the persistence service's own opaque
 * `revision` token, so an append only costs a re-read of the session that
 * changed.
 *
 * The modules under `lib/` split the work by concern: time math, event
 * folding, the config schema, billing, the cache, and the HTTP primitives. This
 * file only wires them to the plugin lifecycle.
 */

import { count } from "./lib/time.js";
import { Config, CONFIG_FIELDS, PEAK_MODES } from "./lib/schema.js";
import { billingRules, migrateCalendars } from "./lib/billing.js";
import { HolidayStore } from "./lib/holidays.js";
import { UsageIndex } from "./lib/store.js";
import { readBody, writeJson } from "./lib/http.js";
import { translatorFor } from "./lib/i18n.js";
import {
  agentForSession,
  clearContext,
  compactContext,
} from "./lib/contextops.js";
export const name = "dsh-token-ledger";
// `commands` joins the list because the two context commands are registered at
// apply time, and `tokenMeter`/`agents`/`subagents` because the context
// operations read them directly: a service is only readable once declared, and
// the failure mode is a thrown error at first use rather than a missing
// dependency at load. `llm` is here for the same reason — the settings page
// lists the models this profile can actually route, with the context window
// each one declares. The panel's own reads still go through `ctx.get` so it
// keeps working on a profile that has dropped one of them.
export const inject = [
  "webServer",
  "connection",
  "sessionPersistence",
  "commands",
  "tokenMeter",
  "agents",
  "subagents",
  "llm",
];

/**
 * Re-exported so the Loader sees the schema on the plugin entry, which is where
 * it looks for it. The schema itself lives in `lib/schema.js` with the field
 * descriptions the Client renders.
 */
export { Config };

/** Prefix route owned by this plugin. */
const ROUTE = "/token-stats/api";

export function apply(ctx, config) {
  const holidays = new HolidayStore(ctx);
  let rules = billingRules(config ?? {}, holidays.sets());
  const index = new UsageIndex(ctx, rules);

  /**
   * Host-side copy, resolved per call.
   *
   * The strings this module produces become finished text in the session log,
   * so they are translated here rather than in the Client. Reading the
   * preference on each call — instead of once at apply time — is what makes a
   * language switch take effect on the next button press.
   */
  const t = (key, values) => translatorFor(ctx)(key, values);

  /**
   * Re-price against the holiday cache as it stands.
   *
   * A year's dates landing in the cache changes which days bill at the peak
   * rate, so the rules are rebuilt rather than patched: `billingRules` is the
   * one definition of how config and calendars become a price sheet, and
   * running it again is cheaper than keeping a second, partial updater in
   * sync with it.
   */
  const reprice = () => {
    rules = billingRules(config ?? {}, holidays.sets());
    index.rules = rules;
  };

  /**
   * The four-digit years the usage corpus spans, plus the current one.
   *
   * The current year is always included so today bills against a calendar
   * that may not be cached yet, and years the data never touched are never
   * fetched — one request per year the panel can actually show.
   * @returns the years to keep in the holiday cache.
   */
  const neededYears = () => {
    const years = new Set([String(new Date().getFullYear())]);
    for (const record of index.records.values())
      for (const slot of record.slots) years.add(String(slot[0]).slice(0, 4));
    return [...years];
  };

  /**
   * Fill the holiday cache for every year the data spans, then re-price.
   *
   * Called before any snapshot is built, so the numbers a request returns
   * already account for the calendar of the days they cover. Once the cache
   * is warm this costs no network traffic at all.
   * @param force - re-fetch even published years.
   * @returns true when the cache changed and the rules were rebuilt.
   */
  const ensureHolidays = async (force = false) => {
    const changed = await holidays.ensure(neededYears(), force);
    if (changed) reprice();
    return changed;
  };
  const fence = (req) =>
    ctx.connection.requestRejection({ headers: req.headers }) === undefined;

  /**
   * The Loader entry that owns this plugin's config row.
   *
   * `configEditor` addresses rows by patch id, so the only reliable way to name
   * our own row is to match the entry the Loader itself resolved for this
   * package. When the service or the row is missing the getter returns
   * undefined and the settings modal reports that settings are read-only.
   * @returns the entry, or undefined when this profile cannot edit it.
   */
  const ownEntry = () => {
    const editor = ctx.get("configEditor");
    if (editor === undefined) return undefined;
    try {
      const entries = editor.entries();
      return entries.find((entry) => entry.options?.name === name);
    } catch {
      return undefined;
    }
  };

  /** The platform's own compaction engine entry, the one the switch writes to. */
  const COMPACTION_PACKAGE = "@deepseek-ai/dsh-compaction-basic";

  /**
   * Mirror the automatic-compaction switch into `dsh-compaction-basic`.
   *
   * The switch deliberately does not run a second compaction engine. The
   * platform already decides *when* to compact, from `agent/pre-step`, using
   * the same `tokenMeter` measurement this plugin's fill bar shows; a second
   * engine firing on the same event would either duplicate the work or race
   * the first one's surface replacement. So the switch owns two numbers and
   * writes them where that engine reads them: `auto` and `thresholdRatio`.
   *
   * Two cases are silently not written. The entry may be absent from a
   * composition that mounts a different engine, and the editor may refuse
   * because this profile is not editable — both leave the user's config
   * intact, and `readConfig` reports what actually took effect, so the UI
   * never claims a write that did not happen.
   * @param next - the config that was just validated.
   * @returns whether the platform entry was updated.
   */
  const syncCompactionEngine = async (next) => {
    const editor = ctx.get("configEditor");
    if (editor === undefined) return false;
    let target;
    try {
      target = editor
        .entries()
        .find((entry) => entry.options?.name === COMPACTION_PACKAGE);
    } catch {
      return false;
    }
    if (target === undefined) return false;
    try {
      await editor.edit(target, (current) => ({
        ...(current ?? {}),
        auto: next.autoCompact === true,
        thresholdRatio: next.autoCompactThreshold,
      }));
      return true;
    } catch {
      // The Loader replaces the edited entry's fiber while this request is in
      // flight, so a refusal here is a normal outcome rather than a fault.
      return false;
    }
  };

  /**
   * The models the last scan actually saw, most-used first.
   *
   * Read from the cached fold rather than from a fresh scan: the settings
   * window opens against whatever the panel already loaded, and asking for a
   * rescan here would make opening settings cost a full pass.
   * @returns `{model, total, calls, cost, configured}` records.
   */
  const observedModels = () => {
    const seen = new Map();
    for (const record of index.records.values()) {
      for (const slot of record.slots) {
        const model = typeof slot[1] === "string" ? slot[1] : "unknown";
        const entry = seen.get(model);
        if (entry === undefined)
          seen.set(model, { total: count(slot[6]), calls: count(slot[7]) });
        else {
          entry.total += count(slot[6]);
          entry.calls += count(slot[7]);
        }
      }
    }
    return [...seen.entries()]
      .map(([model, entry]) => ({
        model,
        total: entry.total,
        calls: entry.calls,
        configured: rules.models?.[model] !== undefined,
      }))
      .sort((left, right) => right.total - left.total);
  };

  /**
   * The routable models, with the context window each one actually has.
   *
   * Two platform services have to be joined here. `listProviders`/`listModels`
   * enumerate what this profile can route, but the advertised catalog carries
   * no context window — that lives on `resolveModelInfo`, one call per model.
   * The ratio the settings page shows is "how full is this session against the
   * model I picked", so the second number is the one that matters and the join
   * happens on the Host, once per request, rather than in the Client.
   *
   * A provider or model whose metadata cannot be resolved is reported in
   * `failures` instead of being dropped: a picker that silently omits a model
   * the user configured reads as "this model does not exist".
   * @returns the catalog plus the per-model limits.
   */
  const modelCatalog = async () => {
    const llm = ctx.get("llm");
    if (llm === undefined) return { groups: [], failures: [] };
    const groups = [];
    const failures = [];
    let providers;
    try {
      providers = llm.listProviders();
    } catch (error) {
      return {
        groups: [],
        failures: [
          {
            id: "",
            name: "",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
    for (const provider of providers) {
      let models;
      try {
        models = await llm.listModels(provider.id);
      } catch (error) {
        failures.push({
          id: provider.id,
          name: provider.name ?? provider.id,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const resolved = [];
      for (const model of models) {
        let info;
        try {
          info = await llm.resolveModelInfo(provider.id, model.id);
        } catch (error) {
          failures.push({
            id: `${provider.id}/${model.id}`,
            name: model.name,
            message: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        resolved.push({
          id: model.id,
          name: model.name,
          ...(model.description === undefined
            ? {}
            : { description: model.description }),
          // Without a declared window the Client cannot compute a ratio at
          // all, and a guessed denominator would report a confident, wrong
          // percentage. Null says "unknown" and the Client renders the
          // threshold without a fill bar.
          contextWindow: info?.context?.contextWindow ?? null,
          defaultMaxTokens: info?.defaultMaxTokens ?? null,
        });
      }
      if (resolved.length === 0) continue;
      groups.push({
        id: provider.id,
        name: provider.name ?? provider.id,
        models: resolved,
      });
    }
    return { groups, failures };
  };

  /**
   * Live context pressure for one session, against the limit that applies.
   *
   * The settings page draws a fill bar under the threshold slider, and the
   * number behind it has to be the same one the platform's own compaction
   * uses or the slider lies. That number is `tokenMeter.measure`, which prices
   * the whole current surface and adds the tool schemas from the latest
   * request envelope; the three-way split shown beside it comes from the
   * `contextBreakdown` projection, whose definition is deliberately the
   * platform's own system/tools/message division.
   *
   * The model whose window divides the total is, in order: the configured
   * compaction target when there is one, the session's last routed route, and
   * nothing — in which case the ratio is reported as unknown rather than
   * guessed.
   * @param sessionId - the session the dock buttons were rendered for.
   * @returns the measured pressure, or a reason it cannot be measured.
   */
  const contextPressure = async (sessionId) => {
    const agent = agentForSession(ctx, sessionId);
    if (agent === undefined) return { available: false, reason: "no-session" };
    const session = agent.session;
    const meter = ctx.get("tokenMeter");
    if (meter === undefined) return { available: false, reason: "no-meter" };
    let measurement;
    try {
      measurement = meter.measure(session);
    } catch (error) {
      return {
        available: false,
        reason: "measure-failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    let breakdown = null;
    try {
      const projections = ctx.get("sessionProjections");
      const snapshot = projections?.snapshot?.(session, ["contextBreakdown"]);
      const value = snapshot?.values?.contextBreakdown;
      if (
        value !== null &&
        value !== undefined &&
        typeof value.systemTokens === "number" &&
        typeof value.toolsTokens === "number" &&
        typeof value.messageTokens === "number"
      )
        breakdown = {
          systemTokens: value.systemTokens,
          toolsTokens: value.toolsTokens,
          messageTokens: value.messageTokens,
        };
    } catch {
      // A missing projection registry only costs the split, not the total:
      // the threshold is decided by `measure` alone.
    }
    const requested = session.requestHeader?.();
    const provider = config?.compactProvider || requested?.config?.provider;
    const model = config?.compactModel || requested?.config?.model;
    let contextWindow = null;
    const llm = ctx.get("llm");
    if (llm !== undefined && provider && model) {
      try {
        const info = await llm.resolveModelInfo(provider, model);
        contextWindow = info?.context?.contextWindow ?? null;
      } catch {
        // An unknown route leaves the window null; the Client shows the
        // measured total and the slider without a fill bar.
      }
    }
    const totalTokens = count(measurement.totalTokens);
    return {
      available: true,
      provider: provider ?? null,
      model: model ?? null,
      contextWindow,
      totalTokens,
      // The slider's own percentage, so the bar and the trigger use exactly
      // one arithmetic path.
      ratio:
        contextWindow === null || contextWindow <= 0
          ? null
          : totalTokens / contextWindow,
      breakdown,
    };
  };

  /**
   * Read the live config and the field description the modal renders.
   * @returns the snapshot the Client draws.
   */
  const readConfig = () => {
    const editor = ctx.get("configEditor");
    const entry = ownEntry();
    let override = config ?? {};
    if (editor !== undefined && entry !== undefined) {
      try {
        const row = editor
          .configuration()
          .find((candidate) => candidate.entry === entry);
        if (row !== undefined) override = row.override;
      } catch {
        /* fall back to the config this fiber already resolved */
      }
    }
    return {
      fields: CONFIG_FIELDS,
      // The normalized view, not the raw closure: an upgraded profile still
      // holds the pre-1.1 price shape, and the modal must show the migrated
      // prices or the user would see empty inputs and overwrite good data.
      value: {
        timeZone: rules.timeZone,
        currency: rules.currency,
        models: rules.models,
        defaultPrice: rules.defaultPrice,
        peakProfiles: rules.peakProfiles,
        holidays: migrateCalendars(config ?? {}, holidays.sets()),
        // Context handling is read straight from the resolved config: it has
        // no billing representation to normalize, so the raw value is the
        // value the modal should show and round-trip.
        compactPrompt: config?.compactPrompt ?? "",
        compactProvider: config?.compactProvider ?? "",
        compactModel: config?.compactModel ?? "",
        autoCompact: config?.autoCompact ?? false,
        autoCompactThreshold: config?.autoCompactThreshold ?? 0.75,
      },
      override,
      editable: editor !== undefined && entry !== undefined,
      currency: rules.currency,
      timeZone: rules.timeZone,
      // The catalogs the pickers need, plus the models seen so far: sending
      // them keeps the Client from bundling a tzdata copy or guessing which
      // models exist.
      holidaySets: holidays.catalog(),
      holidayYears: holidays.yearList(),
      peakModes: PEAK_MODES,
      observed: observedModels(),
    };
  };

  /**
   * Validate and persist a new config through the platform's own editor.
   *
   * Resolving the candidate against the schema here first is deliberate: it
   * turns a bad value into a message naming the field instead of a Loader
   * failure, and it guarantees the row written to disk already passed the same
   * check the Loader will run.
   *
   * Saving makes the Loader rebuild this plugin, so the instance answering this
   * request is about to be replaced and its `config` closure is already stale.
   * The response therefore reports the values that were just written rather
   * than re-reading them, and the Client refreshes the panel to pick up the new
   * instance's numbers.
   * @param next - the raw config the modal submitted.
   * @returns the config after validation plus whether the platform mirror took.
   */
  const saveConfig = async (next) => {
    const editor = ctx.get("configEditor");
    const entry = ownEntry();
    if (editor === undefined || entry === undefined)
      throw new Error(t("error.configNotEditable"));
    let resolved;
    try {
      resolved = Config(next);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
    await editor.edit(entry, () => resolved);
    // The mirror runs after this plugin's own row is durable: if it fails the
    // switch is still saved, and the modal can tell the user that automatic
    // compaction was not applied here rather than losing their edit.
    const compactSynced = await syncCompactionEngine(resolved);
    return { resolved, compactSynced };
  };

  /**
   * The context knobs the two operations read.
   *
   * Kept as one accessor so the commands and the dock buttons cannot drift:
   * both must run on the instruction the modal last saved, not on a default
   * captured when this instance booted.
   * @returns the prompt plus the optional provider/model override.
   */
  const compactOptions = () => ({
    prompt: config?.compactPrompt ?? "",
    provider: config?.compactProvider ?? "",
    model: config?.compactModel ?? "",
  });

  /**
   * The slash command each dock button replays.
   *
   * The two buttons are buttons, not slash-command shortcuts a user has to
   * type, but their report belongs in the transcript rather than in a note
   * glued under the buttons: that is where every other long-running action
   * reports, it survives a panel unmount, and it is part of the session log.
   * The only transcript channel that carries a report without becoming part
   * of the model's context is the platform's own command lifecycle, so the
   * button runs the very same CommandRuntime the typed command does.
   */
  const COMMAND_OF_OP = { clear: "clear-context", compact: "compact-context" };

  /**
   * Run one context operation and turn its outcome into a report line.
   *
   * Expected conditions (nothing to do, session busy, a summary that did not
   * shrink) are reported rather than thrown: a slash command answers in the
   * transcript, and a sentence there beats a stack trace.
   *
   * The two operations deliberately answer in different words. "Cleared 3
   * history items" and "Compacted 3 history items" are not interchangeable:
   * the first dropped the history, the second replaced it with a summary the
   * user can expand in the chat. A shared template would leave that
   * distinction to a one-word prefix and hide the difference that matters.
   * @param op - `clear` or `compact`.
   * @param agent - the agent whose session is being rewritten.
   * @param sourceCommandId - the command that asked, when there was one.
   * @returns the report shown to the user.
   */
  const runContextOp = async (op, agent, sourceCommandId) => {
    const input = { ...compactOptions(), sourceCommandId };
    if (op === "clear") {
      const result = await clearContext(ctx, agent, input);
      if (result === null) return t("report.clearEmpty");
      return t("report.clearDone")
        .replace("{items}", String(result.items))
        .replace("{before}", String(result.beforeTokens))
        .replace("{after}", String(result.afterTokens));
    }
    const result = await compactContext(ctx, agent, input);
    if (result === null) return t("report.compactEmpty");
    return t("report.compactDone")
      .replace("{items}", String(result.items))
      .replace("{before}", String(result.beforeTokens))
      .replace("{after}", String(result.afterTokens))
      .replace("{chars}", String(result.chars));
  };

  /**
   * Replay one of our own commands inside an existing session.
   *
   * `agent` here is the live agent the dock button belongs to, so the command
   * runs against the same session the button was rendered for. The runtime
   * appends `command/run` and `command/done` itself; both are log-only, which
   * is what keeps the report out of the model's context while still landing
   * it in the transcript.
   * @param op - `clear` or `compact`.
   * @param agent - the live agent owning the session.
   * @returns the report text, or a refusal when the runtime is unavailable.
   */
  const runContextCommand = async (op, agent) => {
    const commands = ctx.get("commands");
    const name = COMMAND_OF_OP[op];
    if (typeof commands?.execute !== "function" || name === undefined)
      return { ok: false, text: t("report.noCommandRuntime") };
    // `submittedAttachments` must be an array. The runtime dereferences
    // `.length` on it before its own try block, so `undefined` throws a
    // TypeError that reaches no `settleThrown` — `command/run` is already in
    // the log and `command/done` never gets written, leaving the transcript
    // card stuck on "running" forever. An empty array is the runtime's own
    // `NO_ATTACHMENTS` sentinel.
    const execution = await commands.execute(
      agent,
      `/${name}`,
      [],
      new AbortController().signal,
    );
    if (execution === undefined)
      return { ok: false, text: t("report.noCommandRuntime") };
    return {
      ok: execution.result.kind === "success",
      text: execution.result.text ?? t(`report.${op}Empty`),
    };
  };

  // Both commands share one shape: resolve the agent from the invocation, run
  // the operation, and answer in the transcript. `definitionId` is omitted
  // because it is optional and this plugin imports no platform package.
  ctx.get("commands")?.register?.({
    name: "clear-context",
    description: t("command.clear.description"),
    handler: async (invocation) => {
      // A command answers with a CommandResult, not a bare string: the
      // platform's own registry rejects anything without a `kind`.
      try {
        return {
          kind: "success",
          text: await runContextOp(
            "clear",
            invocation.agent,
            invocation.commandId,
          ),
        };
      } catch (error) {
        return {
          kind: "error",
          text: t("report.clearFailed", {
            error: error instanceof Error ? error.message : String(error),
          }),
        };
      }
    },
  });
  ctx.get("commands")?.register?.({
    name: "compact-context",
    description: t("command.compact.description"),
    handler: async (invocation) => {
      try {
        return {
          kind: "success",
          text: await runContextOp(
            "compact",
            invocation.agent,
            invocation.commandId,
          ),
        };
      } catch (error) {
        return {
          kind: "error",
          text: t("report.compactFailed", {
            error: error instanceof Error ? error.message : String(error),
          }),
        };
      }
    },
  });

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: ROUTE,
        handler: async (req, res) => {
          if (!fence(req)) {
            writeJson(res, 403, {
              ok: false,
              error: { code: "forbidden", message: "forbidden" },
            });
            return;
          }
          if (req.method !== "POST") {
            writeJson(res, 405, {
              ok: false,
              error: { code: "method", message: "POST required" },
            });
            return;
          }
          const path = new URL(req.url ?? "/", "http://dsh.internal").pathname;
          const method = path.startsWith(`${ROUTE}/`)
            ? path.slice(ROUTE.length + 1)
            : "";
          try {
            const body = await readBody(req);
            if (method === "summary") {
              if (body.refresh === true) await index.scan(true);
              else await index.ensureFresh();
              await ensureHolidays();
              writeJson(res, 200, { ok: true, value: index.snapshot(null) });
              return;
            }
            if (method === "refresh") {
              const scanInfo = await index.scan(true);
              await ensureHolidays();
              writeJson(res, 200, {
                ok: true,
                value: index.snapshot(scanInfo),
              });
              return;
            }
            if (method === "config") {
              await holidays.load();
              await ensureHolidays();
              const value = readConfig();
              // The model list is joined in here rather than in the Client
              // because only the Host can resolve a context window, and the
              // picker and the fill bar have to agree on the same numbers.
              value.models = await modelCatalog();
              writeJson(res, 200, { ok: true, value });
              return;
            }
            if (method === "holidays") {
              // The settings window's refresh button: re-fetch every year the
              // data spans, not just the missing ones, so a correction the
              // publisher made to a published year reaches the price sheet.
              const changed = await ensureHolidays(true);
              writeJson(res, 200, {
                ok: true,
                value: {
                  changed,
                  sets: holidays.catalog(),
                  years: holidays.yearList(),
                },
              });
              return;
            }
            if (method === "clearContext" || method === "compactContext") {
              // The dock buttons: the Client only knows the session it was
              // rendered for, so the agent is resolved here. The operation
              // itself runs as a command — not as a direct call — so its
              // report lands in the transcript's command row, which is
              // visible to the user and absent from the model's context.
              const agent = agentForSession(ctx, body.sessionId);
              if (agent === undefined) {
                writeJson(res, 404, {
                  ok: false,
                  error: {
                    code: "no-session",
                    message: "no live agent for that session",
                  },
                });
                return;
              }
              const outcome = await runContextCommand(
                method === "clearContext" ? "clear" : "compact",
                agent,
              );
              writeJson(res, 200, {
                ok: true,
                value: { ok: outcome.ok, result: outcome.text },
              });
              return;
            }
            if (method === "contextPressure") {
              // The settings page's fill bar. Cheap enough to re-read on every
              // open of the modal and on every save, and it must never be
              // cached: the whole point is to show the current surface.
              const value = await contextPressure(body.sessionId);
              writeJson(res, 200, { ok: true, value });
              return;
            }
            if (method === "saveConfig") {
              if (body.value === undefined || body.value === null) {
                writeJson(res, 400, {
                  ok: false,
                  error: {
                    code: "invalid",
                    message: "a config object is required",
                  },
                });
                return;
              }
              const { resolved, compactSynced } = await saveConfig(body.value);
              writeJson(res, 200, {
                ok: true,
                value: {
                  saved: resolved,
                  fields: CONFIG_FIELDS,
                  value: resolved,
                  override: resolved,
                  editable: true,
                  // The switch is stored on this plugin but enforced by the
                  // platform's engine, so the Client needs to know when the
                  // mirror did not land; otherwise it would show the toggle as
                  // active while nothing compacts.
                  compactSynced,
                },
              });
              return;
            }
            writeJson(res, 404, {
              ok: false,
              error: {
                code: "not-found",
                message: `unknown method "${method}"`,
              },
            });
          } catch (error) {
            ctx.logger?.warn?.(
              `dsh-token-ledger: ${ROUTE}/${method} failed: ${String(error)}`,
            );
            writeJson(res, 500, {
              ok: false,
              error: {
                code: "internal",
                message: error instanceof Error ? error.message : String(error),
              },
            });
          }
        },
      }),
    "dsh-token-ledger: usage route",
  );
}

//#endregion

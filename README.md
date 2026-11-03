# Token Ledger for DSH

A DeepSeek Harness bundle that aggregates every session's token usage into one panel: lifetime totals, a
calendar heatmap, a trend chart, a per-model breakdown, a per-session usage table, and CSV/JSON export.

Everything is read from the platform's own session persistence service, so nothing is scraped from logs and no
third-party dependency is required.

## Features

- **Lifetime totals**: cumulative tokens, plus the input / output / cache-read / cache-write split and call count.
- **Cache hit rate**: cache reads as a share of all input-side tokens, with absolute hit and miss counts.
- **Cost estimate**: priced against DeepSeek's peak / off-peak bands, each band's amount shown separately.
- **Calendar heatmap**: GitHub-style week columns or one mini calendar per month; switch with the `Week` /
  `Month` control.
- **Trend chart**: daily / weekly / monthly / yearly granularity, with a hover readout per point.
- **Model breakdown**: tokens and calls per model, sorted by volume.
- **Workspace breakdown**: grouped by the working directory each session header records, so you can see which
  project costs the most.
- **Session usage tree**: main sessions only by default; opening one reveals the subagent sessions it owns, so
  the card does not grow with the subagent count. Sortable by column, archived sessions marked and hideable,
  and row figures follow the selected date range.
- **Paging**: 40 session groups per page, so a large history never renders every row at once.
- **Shared time range**: the filter bar is the one control every card reads (All / Today / Last 24 hours /
  This week / Last 7 days / This month / Last 30 days, plus a pair of date inputs). The heatmap, trend, cost,
  peak, model, session and workspace cards all recompute from the same span.
- **Hourly axis**: narrowing to Today or Last 24 hours switches the trend card to hours, filling in the quiet
  hours so the line cannot cut across an idle stretch.
- **Export**: daily buckets as CSV (UTF-8 BOM + CRLF) or JSON, plus a separate per-session CSV with the
  workspace, parent session, and cost columns.
- **Incremental refresh**: a per-session revision token decides what to re-read, so a refresh only decodes
  sessions that actually changed.
- **Holiday auto-update**: any year is fetched at runtime and cached, so a new year needs no new build.
- **Context actions**: Clear (orange) and Compact (green) buttons in the dock under the composer, plus the
  `/clear-context`, `/compact-context` and `/compact` commands. Compact runs mid-conversation: it fixes a cut
  before summarizing, so everything written while the summarizer works stays verbatim behind the summary, and
  the checkpoint reuses the platform's own "context compacted" marker with the item and token counts. A
  `/compact` run folds the command row and the marker into one merged card, like the platform's own compaction.
  Clear replaces the whole surface and therefore needs an idle session.
- **Prompt optimization**: an Optimize button in the input box toolbar sends the draft to a configurable
  optimizer model and pastes the rewrite back into the composer; attachments are untouched. The request can
  also carry an excerpt of the session's context, so a prompt that says "this function" rewrites into one that
  names it. Instruction, route and the context toggle live on the **Prompt optimization** settings tab.
- **Bilingual**: Chinese and English follow the platform locale.

## Requirements

- DSH `>= 0.2.1-rc.3` (declared as `dsh.engines.dsh`).
- A profile whose client runs the Web UI; the bundle registers into `sidebar.panellist` and `main`.

## Install

Install from a local directory through the Plugins page or the plugin manager, pointing at the package
directory (the folder containing `package.json`):

```
plugin_manager install_bundle target="<absolute path to this directory>"
```

After installation the sidebar shows a **Token Ledger** entry; selecting it opens the main panel.

To remove it, uninstall the `dsh-token-ledger` bundle from the Plugins page.

## Usage

1. Select **Token Ledger** in the sidebar.
2. Choose a range from the filter bar, or type a `From` / `To` pair.
3. Switch the heatmap between `Week` and `Month`, and the trend between `Hour` / `Day` / `Week` /
   `Month` / `Year` (`Hour` appears only on a sub-day range).
4. Hover any trend point for its exact numbers.
5. The **Session usage** tree lists main sessions by default. Select the `▶` at the start of a row to open it,
   revealing every subagent session it owns. Select a column header (Session / Tokens / Calls / Created) to
   sort, clear `Show archived` to see only sessions still in use (the choice is remembered across visits), and
   use `Export sessions CSV` to save what the table currently shows.
6. Page through large histories with `Previous` / `Next`; each page holds 40 session groups.
7. Use **Refresh** to re-scan, or **Export** to save the daily buckets as CSV / JSON.
8. Use **General settings** to open the settings window and change the zone, currency, peak windows, holidays,
   and price sheet; saving re-prices immediately.

The panel refreshes automatically when it opens; large histories load in about a second because only changed
sessions are decoded after the first pass.

## Billing configuration

Every billing parameter is a plugin config entry. Open the settings window from the `General settings` button
in the panel header to edit them online; saving re-prices immediately, with no DSH restart.

The window edits the config by structure, not by field name: model prices are a table, peak schedules are
reusable profiles, and holidays are a checklist, none of which a generic key/value editor can express. It has
six tabs:

| Tab | Contents |
| --- | --- |
| **Models & prices** | One row per model with four independent price inputs (miss input, cache-hit input, cache write, output), plus the peak toggle with its schedule picker and the delete button pinned to the right edge |
| **Peak schedules** | Reusable profiles: name, automatic mode, any number of start–end windows, off-peak ratio |
| **Holidays** | Calendars shipped with the plugin; tick to enable |
| **Context** | The compaction instruction, its model route, the live context readout, and the automatic and segmented compaction switches |
| **Prompt optimization** | The optimizer instruction, its model route, and whether the request carries an excerpt of the session's context |
| **General** | Billing time zone and currency |

The window can **export** the billing configuration to JSON and **import** a shared one; an import only
fills the form, so nothing changes until Save is pressed.

The model list defaults to the models the logs actually contain, ordered by usage, so opening the window
puts a row in front of you for every model currently being charged. A model with no price row yet shows
"not priced" and an *add price* button.

Every model is priced on its own. A model missing from the sheet falls back to `defaultPrice`, and the cost
card names it ("kimi-k3.1-pro is not priced; charging the default") instead of quietly billing zero.

Four rates, billed separately. A provider does not treat every input token alike, so the sheet has one
column per thing it charges for:

| Column | What it bills | When the provider does not charge for it |
| --- | --- | --- |
| Miss input | Input sent for the first time, with no prefix-cache hit | The listed rate |
| Cache-hit input | Input served from the prefix cache | 0 |
| Cache write | Input stored into the cache | 0 |
| Output | What the model generated | The listed rate |

Keeping the two cache columns apart matters: a write stores input and a read fetches it back, and their rates
commonly differ by more than ten times. Collapse them into one number and a session warming a cache prices
too cheaply while a session reusing one prices too expensively. A cache write is also excluded from the
hit-rate denominator: it is a write, not a read.

Peak pricing is a separate, reusable item. One schedule can back several models: switch the model's toggle on
and pick the schedule name. A model with the toggle off bills one rate all day, the full listed price, so it
counts in the peak column rather than the discounted one. Renaming a schedule renames every model's reference
with it; deleting one leaves those references behind, and a model pointing at a missing schedule bills flat
until it is re-pointed (the row says so and offers the picker).

Off-peak is a ratio, not a second price. The schedule's off-peak ratio is a share of the listed price (0.5 by
default), so there is one price sheet to maintain and changing the ratio re-prices both bands at once.

### Automatic modes

The mode decides which days a schedule applies to, following the shape of an alarm's repeat rule:

| Mode | Meaning |
| --- | --- |
| Every day | No weekday or holiday filter |
| Statutory workdays (skips holidays) | Monday to Friday, excluding any enabled holiday |
| Statutory holidays (skips workdays) | Only on enabled holidays |
| Monday to Friday | Weekday only; ignore holidays |
| Custom | Any combination of the seven weekdays |

### Time windows

A schedule holds any number of start–end windows, each entered on a 24-hour clock. **More than one window is
necessary**: DeepSeek's peak band is split around the lunch break (09:00-12:00 and 14:00-18:00), and collapsing
it into one 09:00-18:00 span bills the break at the peak rate: peak tokens would read ~450M instead of ~404M.

An `end` earlier than its `start` wraps midnight, so `22:00`-`02:00` is one entry.

### Holidays

Holiday dates are fetched over the network at runtime and cached under the profile, so a new year works without
shipping a new plugin build. Only years that have no data yet are fetched: a published year never changes again,
while a year the sources have not published (for example the next one) is retried once a day. Three keyless
sources are tried in order, and a year that every source rejects keeps whatever was already cached.

The plugin still starts with the 2026 dates built in, so pricing is correct on the very first run, before any
request leaves the process. Settings shows how many years are loaded and has a refresh button that forces a
re-fetch. The statutory-holiday calendar is on by default.

The bundled list is seed data, not the source of truth: once a year is fetched its network copy wins.

### Context actions

Two buttons sit in the dock under the composer, in the same row as the context-usage meter they act on:
**Clear context** (orange) on the left and **Compact context** (green) on the right. Both are also slash
commands (`/clear-context` and `/compact-context`), so they work without the mouse.

They differ in what they replace. Clear takes the whole surface and therefore needs an idle session: a step
appending during the rewrite would be dropped with the history it belongs to. Compact takes only the span it
selected *before* summarizing, up to the last cut that does not split a tool-call/result pair, so it works
mid-conversation, and everything written while the summarizer runs is replayed verbatim behind the checkpoint.
The session and its log are untouched either way: the events stay on disk, the surface only stops showing the
replaced part, and the context window is freed.

- **Clear**: writes a one-line placeholder. It is not a summary; nothing before the next message is retained.
- **Compact**: calls the model directly to write a summary, then replaces the cut with it. It runs on the
  session's provider and model unless the Context tab overrides them. The span is replayed as the messages it
  really holds (same system prompt, same tool definitions, instruction appended last), so the provider's
  prefix cache covers the history and the call bills as a cache read instead of a second full send. No
  subagent is started, so the summarizer has no session, no tools of its own, and nothing it could edit.

After either one, the transcript shows one command card, with no duplicate note under the buttons. The two
report different things: Clear gives the item and token counts before and after the swap, Compact adds the
character count of the summary it wrote. They ride the platform's own `command/run` / `command/done` events,
so the card is visible and expandable but never enters the surface: the model's context stays free of its own
bookkeeping.

The prompt the compaction model reads is editable on the **Context** settings tab, which also picks the
model's provider and model; leaving those empty inherits the session's. The default prompt asks for the goal,
decisions and their reasons, verbatim paths and signatures, error text, and open work, and forbids mentioning
the compaction itself.

The same tab carries three more things about how much window is left:

- **Context usage** is the live total for the current session, built from the real system prompt, tool
  definitions, and conversation messages, next to the selected model's input window, the share in use, and
  the three-part split.
- The **automatic compaction** switch and its **trigger threshold** (75% by default) decide when this plugin
  compacts on its own, before the window is full. The trigger rides the same `agent/pre-step` event the platform
  engine uses, but this plugin runs it and writes no platform config. A profile may disable that engine outright
  (billion-context disables `dsh-compaction-basic` as a whole, and a preset's nested row is not reachable
  through the config editor anyway), and then a saved switch would enforce nothing. The decision is made on the
  three-part real total described above, not the usage-anchored figure the platform panel prints at the top: on
  a long session that one reads 112K while the same request really carries 2.3M. Two compactions of one
  session are at least a minute apart, so a history still over the threshold right after being summarized does
  not pay for another summary on the very next step.
- **Segment when over the window** decides what happens once the history is larger than the summarizer's
  window. Off: the oldest part is dropped, only the newest records that fit are summarized, and the excerpt
  says how many were omitted. On: the span is cut into segments, each summarized in parallel, and a final
  request merges them into the one summary that replaces the span. Nothing is dropped, and no single request
  exceeds the window; a long conversation that used to hang or come back empty was running into exactly that
  request.
- Compaction measures first. A history past two thirds of the summarizer's window falls back to a head-and-tail
  excerpt when segmenting is off: the head keeps the goal and the constraints, the tail keeps whatever is in
  progress, and the omitted middle is marked explicitly. A span that reaches into the running turn is no
  different: the summarizer is handed the messages themselves, so the summary covers exactly what the
  checkpoint will replace.
- The compaction lock is opened before the summarizer is called, not after. A second request then answers
  "already in flight" instead of paying for the same summary twice, and the platform's own engine backs off
  rather than racing this one.

Clearing an already-cleared session is a no-op that reports success: rewriting one placeholder with another
identical one is not an error.

### Validation

The platform schema and the plugin each validate before a save lands: an unknown zone, a malformed `HH:MM`, a
negative price, an off-peak ratio outside (0, 1], or an unknown automatic mode is rejected with the offending
field named.

### Upgrading

A 1.0 configuration (one flat `peakWindows` list, six-field prices named `hitPeak` / `missPeak` / `outPeak`,
holidays as a date array) is migrated on read: the peak half becomes the listed price, a model that had an
off-peak rate is attached to the `standard` schedule, and the date array folds back into calendar keys. The
migration is read-only, so the file on disk keeps its old shape until you save from the window.

Every string in the window lives in the `ZH` / `EN` dictionaries in `client.js`, 230 keys with identical key
sets across both languages.

Saving goes through the platform's `configEditor` service, which validates the schema, writes the whole config
into the profile's `cordis.patch.yml`, and triggers a hot reload. The plugin validates once more first, so a bad
value comes back as a message naming the offending field instead of a Loader-level failure. When the profile has
no such service or no matching row, the window degrades to read-only and says why.

- **Holidays win over weekdays**: a listed day bills off-peak all day whatever weekday it falls on.
- **Validation runs at load**: an unknown zone, a malformed `HH:MM`, an impossible date, or a negative price
  is rejected with a message naming the offending field.

> DeepSeek's peak rule reads "Monday through Friday", so make-up working days (weekends worked for a holiday
> swap) still bill off-peak; the panel does not treat them as peak. Prices are per million tokens, matching the
> provider's published sheet.

## How the data is collected

- **Source**: the Host `sessionPersistence` service lists every session with an opaque `revision`. Sessions
  whose revision is unchanged are skipped; changed ones are opened read-only and their events decoded.
- **Counting**: each `assistant/message` event carrying `data.usage` contributes one call. The total prefers
  `usage.totalTokens`, falling back to `inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`.
- **Scope**: every session in the profile, including subagent sessions (`header.origin === 'subagent'`) and
  archived sessions; the footer counts main, subagent, and archived separately.
- **Session titles**: taken from the last `session/title` event in each session's own log, never from mutable
  metadata.
- **Archived flag**: read from `workspaceRegistry.archivedSessionIds`; when that service is absent the plugin
  treats the profile as having no archived sessions and every other figure stays correct.
- **Workspace**: taken from `cwd` in each session's header event (`type: "session"`); a session without one is
  grouped under "(no workspace)".
- **Lineage**: taken from `parentSession` in the same header event. A subagent whose parent is outside this
  report is shown as a top-level entry rather than dropped.
- **Buckets**: usage is keyed by the local calendar day of the event timestamp; billing additionally splits by
  hour, converted through the configured zone.
- **Cache**: the folded result is written to `~/.dsh/storages/dsh-token-ledger/usage-cache.json`
  (`CACHE_VERSION = 3`), written atomically via a temp file and rename.
- **Accuracy**: totals are exactly the sum of the underlying `usage` records; the panel never estimates. Session
  rows follow the selected range, their sum over any day equals that day's heatmap figure exactly, and the
  hourly cost is rolled into the day, model, and session dimensions, whose sums all equal the grand total.

## HTTP API

The Host registers a prefix route at `/token-stats/api`. Every request must pass the platform's own
Host/Origin fence (`ctx.connection.requestRejection`) and be `POST` with a JSON body.

| Method       | Body                | Purpose                                                         |
| ------------ | ------------------- | --------------------------------------------------------------- |
| `summary`    | `{}`                | Return the current snapshot, re-scanning only changed sessions. |
| `summary`    | `{"refresh": true}` | Force a full re-decode of every session.                        |
| `refresh`    | `{}`                | Alias for a forced refresh.                                     |
| `config`     | `{}`                | Return the live config, its field list, and editability. `models` carries the Host's live model catalog (each entry with its context window). |
| `saveConfig` | `{"value": {...}}`  | Validate and persist a config; returns it with the field list. Automatic compaction runs in this plugin and writes no platform config, so there is no "did the mirror land" field. |
| `holidays`   | `{}`                | Force a re-fetch; returns whether it changed and the per-year list. |
| `clearContext` | `{"sessionId": "..."}` | Replace that session's whole surface with a placeholder. |
| `compactContext` | `{"sessionId": "..."}` | Summarize that session with a direct model call and replace the surface. |
| `contextPressure` | `{"sessionId": "..."}` | Measure one session: total tokens, the system/tools/messages split, the routed model's context window, and the share in use. |

Response shape:

```json
{
  "ok": true,
  "value": {
    "generatedAt": 1793511000000,
    "lastScanAt": 1793510999000,
    "scan": null,
    "sessions": { "total": 0, "subagent": 0, "main": 0, "archived": 0 },
    "totals": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0,
      "total": 0,
      "calls": 0
    },
    "days": [["2026-11-01", 0, 0, 0, 0, 0, 0, 0]],
    "models": [["deepseek-v4.1-flash", 0, 0, 0]],
    "cache": { "hits": 0, "misses": 0, "hitRate": 0 },
    "billing": {
      "currency": "CNY",
      "timeZone": "Asia/Shanghai",
      "cost": 0,
      "peakCost": 0,
      "offPeakCost": 0,
      "peakTokens": 0,
      "offPeakTokens": 0,
      "peakCalls": 0,
      "offPeakCalls": 0,
      "hitRate": 0,
      "hits": 0,
      "misses": 0,
      "priced": ["deepseek-v4.1-flash"],
      "unpriced": []
    },
    "sessionRows": [],
    "firstDay": "2026-10-30",
    "lastDay": "2026-11-01"
  }
}
```

`days`, `hours` and `models` rows are `[key, input, output, cacheRead, cacheWrite, total, calls, cost,
peakInput, peakOutput, peakCacheRead, peakCacheWrite, peakTotal, peakCalls, peakCost]`. `sessionRows`
rows are `[sessionId, title, createdAt, isSubagent(0|1), isArchived(0|1), total, calls, parentId,
dayRows, cost, workspace, slotRows, models]`, where `dayRows` is `[day, …]` and `slotRows` is
`[hour, model, input, output, cacheRead, cacheWrite, total, calls, cost, isPeak(0|1)]`. Archive state
comes from `workspaceRegistry.archivedSessionIds`; archived sessions keep their logs on disk, so they
also appear in `sessionPersistence.list()`.

Slots are the finest fact the Host has, so the Client can narrow a session to a range and a model from the
row alone. The peak flag travels with them because only the Host knows the schedule and the holiday calendar,
and a second copy of those rules in the Client would eventually disagree with it.

Three extra per-model fields let the Client narrow the whole page to one model without a second request:

- `modelDays`: `[model, dayRows]`, used to rebuild that model's trend and heatmap over any range.
- `modelHours`: `[model, hourRows]`, the hour-grain twin of `modelDays`.
- `modelBilling`: `[model, {cost, peakCost, offPeakCost, peakTokens, offPeakTokens, peakCalls,
  offPeakCalls, hits, misses}]`, used to rebuild its cost, peak/off-peak and hit-rate figures.

Each family sums back to the global `totals` and `billing` exactly.

## Package layout

```
package.json        manifest: exports, dsh.bundle.patch, dsh.client, engines
cordis.patch.yml    inserts this bundle into the profile patch
index.js            Host entry: Config validation, HTTP route, plugin lifecycle
lib/time.js         Zone math, hour bucketing, numeric normalisation
lib/scan.js         Folding session events into hour × model slots
lib/schema.js       Config schema, default price sheet, field descriptions
lib/billing.js      Peak rules, pricing, legacy-config migrations
lib/holidays.js     Network fetch, per-year cache, built-in seed
lib/contextops.js   Surface replacement for clear / compact, the real three-part measurement, and segmentation
lib/store.js        Revision-keyed cache and the snapshot (per day / per model)
lib/http.js         Request body reading and JSON responses
client.js           Client half: panel, heatmap, trend chart, session tree, workspaces, export
locale/en.json      plugin metadata (English)
locale/zh.json      plugin metadata (Chinese)
icon.svg            plugin icon (reachable via the "./icon" export)
icon-prompt-optimize.svg  Optimize button icon (the same graphic is inlined in client.js)
```

UI strings live in `client.js` (`ZH` / `EN`) and register through `ctx.locale.register`; the `locale/*.json`
files only carry the plugin title and description shown by the Plugins page.

`schemastery` is resolved at runtime from the profile directory (see `schemaLibrary()`) and is deliberately
**absent from `package.json` `dependencies`**: this bundle installs as a `link:`, so its own dependencies are
never installed, and declaring one would only make the module fail to load.

## Notes and limits

- The heatmap, trend, and billing use the configured `timeZone` (default `Asia/Shanghai`, matching how DeepSeek
  bills), not the machine's local zone.
- A very long history renders one heatmap column per week; the strip scrolls horizontally rather than shrinking
  below legibility.
- Usage is attributed to models exactly as recorded; sessions predating usage reporting contribute nothing.
- A model absent from the price sheet bills at `defaultPrice`, and the cost card names it rather than pricing it
  silently.
- Make-up working days bill off-peak per the rule's literal wording; switch a schedule to Custom and tick those
  weekdays to count them as peak.
- The bundle reads session persistence and the archive list, registers one HTTP prefix route, and exposes one
  Config schema.
- The context actions rewrite the session surface (the `compaction/*` pair plus one surface replacement), so they
  need four platform services: `commands`, `tokenMeter`, `agents`, and `llm`. On a profile missing any of them
  those two buttons and commands are unavailable there; the statistics are unaffected. Replaced events are never
  deleted from the log.
- A compaction cannot rewrite until the model has finished writing, so one run takes as long as the session
  length and chosen model require. The session stays usable throughout: the rewrite waits for it to go idle.

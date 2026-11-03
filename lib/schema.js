/**
 * The plugin configuration schema and the field descriptions the Client renders.
 *
 * `Config` is the single source of truth: the platform validates saves against
 * it, and the settings form is generated from `CONFIG_FIELDS`, so a new option
 * only has to be declared here to reach both the validator and the UI.
 */

import { createRequire } from "node:module";
import { join } from "node:path";

import { count } from "./time.js";
import {
  DEFAULT_COMPACT_PROMPT,
  DEFAULT_OPTIMIZER_PROMPT,
} from "./contextops.js";

/**
 * Load the schema library the Loader itself uses.
 *
 * A plugin installed from a local directory is linked, not copied, so its own
 * `dependencies` are never installed; importing the package by bare specifier
 * would fail even though the profile already carries it. Resolving through the
 * profile directory finds the copy the Host already loaded, which also keeps
 * `Config` an instance of the very class the Loader validates against.
 * @returns the schema builder, or undefined when the profile lacks it.
 */
function schemaLibrary() {
  const base = process.env.DSH_PROFILE_DIR;
  const probes = [];
  if (typeof base === "string" && base !== "")
    probes.push(join(base, "package.json"));
  probes.push(join(process.cwd(), "package.json"));
  for (const probe of probes) {
    try {
      const value = createRequire(probe)("@deepseek-ai/schemastery");
      return typeof value === "function" ? value : value?.default;
    } catch {
      /* try the next anchor */
    }
  }
  return undefined;
}

const Schema = schemaLibrary();

/** A price must be a finite, non-negative number. */
export const Price = Schema.transform(Schema.number().default(0), (value) => {
  if (!Number.isFinite(value) || value < 0)
    throw new TypeError("a price must be a finite non-negative number");
  return value;
});

/** `HH:MM` on a 24-hour clock, kept as text so the stored config stays readable. */
const Clock = Schema.transform(Schema.string().default("00:00"), (value) => {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))
    throw new TypeError(`"${value}" is not an HH:MM time of day`);
  return value;
});

/** One weekday number, 1 = Monday through 7 = Sunday. */
const Weekday = Schema.transform(Schema.number(), (value) => {
  if (!Number.isInteger(value) || value < 1 || value > 7)
    throw new TypeError("a weekday must be an integer from 1 (Mon) to 7 (Sun)");
  return value;
});

/**
 * How a peak profile decides which days it applies to.
 *
 * The two "statutory" modes are the reason this is a mode rather than a
 * weekday list: they need the holiday calendar to answer, and answering it
 * here keeps the rule in one place instead of split between the UI and the
 * pricing pass.
 */
export const PEAK_MODES = [
  "everyday",
  "workday",
  "holiday",
  "weekdays",
  "custom",
];

/** The mode selector of one peak profile. */
const PeakMode = Schema.transform(
  Schema.string().default("workday"),
  (value) => {
    if (!PEAK_MODES.includes(value))
      throw new TypeError(`"${value}" is not one of ${PEAK_MODES.join(", ")}`);
    return value;
  },
).description("Which days this window applies to");

/**
 * One daily time window, in the configured zone's wall clock.
 *
 * A profile holds a list of these rather than one pair, because a provider can
 * split its peak band: DeepSeek bills 09:00-12:00 and 14:00-18:00 with a
 * cheaper gap in between, and a single pair could not express that without
 * over-charging the lunch break.
 */
const PeakWindow = Schema.object({
  start: Clock.default("09:00").description("The window opens at this time"),
  end: Clock.default("18:00").description(
    "The window closes at this time; earlier than start wraps midnight",
  ),
}).description("One daily peak window");

/**
 * A reusable peak-pricing profile.
 *
 * Profiles are named and referenced by models, so several models can follow
 * one schedule: a new model then only needs a price row and the name of the
 * schedule it belongs to.
 */
const PeakProfile = Schema.object({
  mode: PeakMode,
  windows: Schema.array(PeakWindow)
    .default([{ start: "09:00", end: "18:00" }])
    .description("The daily windows this schedule prices at the listed rate"),
  weekdays: Schema.array(Weekday)
    .default([1, 2, 3, 4, 5])
    .description("Weekdays used by the custom mode"),
  offPeakRatio: Schema.transform(Schema.number().default(0.5), (value) => {
    if (!Number.isFinite(value) || value <= 0 || value > 1)
      throw new TypeError("offPeakRatio must be greater than 0 and at most 1");
    return value;
  }).description(
    "Off-peak price as a share of the listed price; 0.5 means half",
  ),
}).description("A reusable peak-pricing schedule");

/**
 * One model's prices and the peak schedule it follows.
 *
 * The four rates are the four things a provider can bill separately. Not every
 * provider splits all four — DeepSeek charges a cache write at the miss rate,
 * Anthropic charges 1.25× for one — but keeping a rate per item means a
 * provider that starts billing one needs a number, not a new config shape.
 * A rate of 0 means "this provider does not bill it".
 *
 * A price row always carries the peak (or flat) rate; whether a second,
 * cheaper band applies is decided entirely by `peakProfile`. An empty value
 * means the model bills at one rate all day.
 */
const ModelConfig = Schema.object({
  input: Price.description("Cache-miss input, per 1M tokens"),
  cacheRead: Price.description("Cache-hit input, per 1M tokens"),
  cacheWrite: Price.description("Writing input into the cache, per 1M tokens"),
  output: Price.description("Output, per 1M tokens"),
  peakProfile: Schema.string()
    .default("")
    .description("Key of a peak profile, or empty for flat pricing"),
}).description("One model's prices");

/**
 * One model's price row.
 *
 * The argument order follows the settings table left to right, so a default
 * sheet reads in the same order the user sees it.
 * @param input - cache-miss input price at peak.
 * @param cacheRead - cache-hit input price at peak.
 * @param cacheWrite - cache-write price at peak.
 * @param output - output price at peak.
 * @param profile - the peak profile this model follows, or "".
 * @returns one model's config row.
 */
export function modelRow(input, cacheRead, cacheWrite, output, profile) {
  return { input, cacheRead, cacheWrite, output, peakProfile: profile };
}

/**
 * A description of one config field, flattened for the settings modal.
 *
 * The schema's own {@link Schema.toJSON} output is a ref graph keyed by `uid`,
 * which the Client would have to re-walk for every field. Sending one plain
 * record per field keeps the Client a renderer: it never interprets a schema.
 * @typedef {object} FieldDescription
 * @property {string} key - dotted path from the config root.
 * @property {"string"|"number"|"boolean"|"list"|"map"|"object"} kind - editor to use.
 * @property {string} label - the field's own name.
 * @property {string} description - the schema's description, or "".
 * @property {unknown} default - the schema default, when it has one.
 * @property {FieldDescription[]} [fields] - children of an object or map value.
 * @property {FieldDescription} [item] - element description of a list or map.
 */

const KIND_OF = {
  string: "string",
  number: "number",
  boolean: "boolean",
  array: "list",
  dict: "map",
  object: "object",
};

/**
 * Walk a schemastery schema into field descriptions.
 *
 * A `transform` wrapper is opaque to introspection — its callback never runs —
 * so the walk continues into whatever it wraps and the Client collects the raw
 * text; validation still happens on save, in the Host.
 * @param {object} schema - the schemastery schema to describe.
 * @param {string} prefix - dotted path of this schema in its parent.
 * @param {number} depth - recursion guard for self-referential schemas.
 * @returns {FieldDescription[]} the fields, or a single synthetic entry.
 */
function describeFields(schema, prefix, depth) {
  if (schema === undefined || schema === null || depth > 4) return [];
  const inner = schema.type === "transform" ? schema.inner : schema;
  if (inner === undefined || inner === null) return [];
  const type = inner.type;
  if (type !== "object" && type !== "dict") {
    return [{ ...describeLeaf(inner, prefix), key: prefix }];
  }
  const dict = inner.dict ?? {};
  const fields = [];
  for (const [name, child] of Object.entries(dict)) {
    const key = prefix === "" ? name : `${prefix}.${name}`;
    const leaf = describeLeaf(child, key);
    if (leaf.kind === "object" || leaf.kind === "map") {
      const kids = describeFields(child, key, depth + 1);
      fields.push(
        leaf.kind === "map"
          ? { ...leaf, item: kids[0], fields: undefined }
          : { ...leaf, fields: kids },
      );
    } else if (leaf.kind === "list") {
      const element = child.type === "transform" ? child.inner : child;
      const elementInner = element?.inner;
      fields.push({
        ...leaf,
        item:
          elementInner === undefined
            ? undefined
            : { ...describeLeaf(elementInner, key), key },
      });
    } else {
      fields.push(leaf);
    }
  }
  return fields;
}

/**
 * Describe one non-container schema.
 * @param {object} schema - the schema node.
 * @param {string} key - its dotted path.
 * @returns {FieldDescription} the description.
 */
function describeLeaf(schema, key) {
  const inner = schema.type === "transform" ? schema.inner : schema;
  const kind = KIND_OF[inner?.type];
  const meta = schema.meta ?? inner?.meta ?? {};
  return {
    key,
    kind: kind ?? "string",
    label: key.split(".").pop() ?? key,
    description: typeof meta.description === "string" ? meta.description : "",
    default: meta.default,
  };
}

export const Config = Schema.object({
  timeZone: Schema.transform(Schema.string(), (value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value });
    } catch {
      throw new TypeError(`"${value}" is not a known IANA time zone`);
    }
    return value;
  })
    .default("Asia/Shanghai")
    .description(
      "IANA zone the provider bills in; decides every slot boundary",
    ),
  currency: Schema.string()
    .default("CNY")
    .description("Currency label shown beside every amount"),
  peakProfiles: Schema.dict(PeakProfile)
    .default({
      standard: {
        mode: "workday",
        // DeepSeek's peak band is split around the lunch break, so the
        // default schedule carries both windows rather than one span.
        windows: [
          { start: "09:00", end: "12:00" },
          { start: "14:00", end: "18:00" },
        ],
        weekdays: [1, 2, 3, 4, 5],
        offPeakRatio: 0.5,
      },
    })
    .description("Named peak schedules; models refer to one by name"),
  holidays: Schema.array(Schema.string())
    .default(["cn"])
    .description(
      "Enabled holiday categories: cn, cn-makeup (per-year keys still load)",
    ),
  models: Schema.dict(ModelConfig)
    .default({
      // The cache-hit rate is 2% of the miss rate for the flash models and
      // 3.33% for the pro ones — not the 10% most providers use. Filling in the
      // habit figure would overstate a cache-heavy bill five times over, so
      // these come from the published sheet, not from a rule of thumb.
      //
      // A cache write bills at the miss rate on DeepSeek, which is why the
      // write and miss columns carry the same number here.
      "deepseek-v4.1-flash": modelRow(2, 0.04, 2, 8, "standard"),
      "deepseek-flash": modelRow(2, 0.04, 2, 8, "standard"),
      "deepseek-v4-flash": modelRow(2, 0.04, 2, 8, "standard"),
      "deepseek-v4-pro": modelRow(9, 0.3, 9, 27, "standard"),
      "deepseek-v4-pro-0813": modelRow(9, 0.3, 9, 27, "standard"),
      // The two other models the local logs carry. Kimi prices a cache write
      // by its TTL — 1x the input rate for five minutes, 2x for an hour — and
      // the five-minute rate is the one recorded here, because it is the
      // default and a longer TTL is the case that under-bills rather than
      // over-bills. MiMo waives the write charge entirely.
      "kimi-k3.1-pro": modelRow(13, 1.3, 13, 68, ""),
      "mimo-v2.6-flash": modelRow(1, 0.02, 0, 2, ""),
    })
    .description("Price sheet keyed by the model name the session logs carry"),
  defaultPrice: ModelConfig.default(modelRow(2, 0.04, 2, 8, "")).description(
    "Applied to any model the sheet does not list",
  ),
  // Context handling sits apart from billing: it is the instruction the
  // compaction model reads and the route it runs on, not a price. An empty
  // model inherits the parent session's, so the default needs no guessing.
  compactPrompt: Schema.string()
    .default(DEFAULT_COMPACT_PROMPT)
    .description(
      "Instruction the compaction model reads when compressing a session",
    ),
  compactProvider: Schema.string()
    .default("")
    .description(
      "Provider for the compaction model; empty inherits the session's",
    ),
  compactModel: Schema.string()
    .default("")
    .description(
      "Model for the compaction model; empty inherits the session's",
    ),
  // Automatic compaction is run by this plugin, from the same `agent/pre-step`
  // event the platform's own engine uses. It used to be delegated — the switch
  // only mirrored two values into `dsh-compaction-basic` — but a profile that
  // disables that engine (billion-context does, and preset rows are not even
  // reachable through the config editor) then had a switch that saved and did
  // nothing. Owning the trigger is what makes the switch real: the threshold is
  // compared against the measured three-part total below.
  autoCompact: Schema.boolean()
    .default(false)
    .description(
      "Whether this plugin compacts automatically once the real context total reaches the threshold",
    ),
  autoCompactThreshold: Schema.number()
    .min(0.05)
    .max(0.95)
    .default(0.75)
    .description(
      "Share of the model's input context at which automatic compaction fires",
    ),
  // Only consulted when the history to compact is larger than the summarizer's
  // window, which is the case that used to end in an empty answer or a request that
  // never returned. Splitting asks for one summary of each segment, then merges
  // them; leaving it off instead drops the oldest part and summarizes only what
  // still fits.
  splitCompaction: Schema.boolean()
    .default(false)
    .description(
      "When the history exceeds the summarizer's window, summarize it in parallel segments and merge them instead of discarding the oldest part",
  ),
  // Prompt optimization shares the context stack's shape — an instruction and
  // an optional route — but serves the composer, not compaction: the button
  // above the input box rewrites the draft through this route. The same
  // inherit-when-empty rule keeps the default usable with no configuration.
  optimizerPrompt: Schema.string()
    .default(DEFAULT_OPTIMIZER_PROMPT)
    .description(
      "Instruction the optimizer model reads when rewriting a user prompt",
    ),
  optimizerProvider: Schema.string()
    .default("")
    .description(
      "Provider for the optimizer model; empty inherits the session's",
    ),
  optimizerModel: Schema.string()
    .default("")
    .description("Model for the optimizer model; empty inherits the session's"),
  // Off by default: the context excerpt spends extra tokens on every click,
  // and a draft usually carries enough intent to rewrite on its own.
  optimizerUseContext: Schema.boolean()
    .default(false)
    .description(
      "Include an excerpt of the current session's context in the optimize request so the rewrite fits the ongoing task",
    ),
});

/**
 * The settings modal's field list, computed once: the schema never changes at
 * runtime, and rebuilding it per request would walk the whole tree for nothing.
 */
export const CONFIG_FIELDS = describeFields(Config, "", 0);

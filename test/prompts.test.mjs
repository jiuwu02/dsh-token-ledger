/**
 * The default instructions: one shape, three engines.
 *
 * All three prompts are shipped defaults a user can replace in the settings
 * dialog, so the properties worth pinning are the ones the code depends on:
 * every prompt opens with the five modules in the same order (they sit on three
 * separate settings tabs but share one skeleton, so a drifting heading breaks
 * the parallel the user sees when switching between them), and each keeps the
 * one clause its call site relies on.
 *
 * The optimizer clause matters most. Its output is written straight into the
 * user's input box, and `stripFence` only removes a fence that wraps the WHOLE
 * answer — so a prompt that asks for a code block plus trailing advice leaves
 * that advice in the draft. That is why the default forbids both.
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const load = (relative) => import(pathToFileURL(join(root, relative)).href);

// schema.js first: the module graph has a circular edge through it.
await load("lib/schema.js");
const { DEFAULT_COMPACT_PROMPT, DEFAULT_OPTIMIZER_PROMPT } = await load(
  "lib/contextops.js",
);
const { DEFAULT_ASK_PROMPT } = await load("lib/ask.js");

const HEADINGS = [
  "# 角色定义",
  "## 核心能力",
  "## 核心红线",
  "## 工作流程",
  "## 交付格式",
];

for (const [name, prompt] of [
  ["compact", DEFAULT_COMPACT_PROMPT],
  ["optimizer", DEFAULT_OPTIMIZER_PROMPT],
  ["ask", DEFAULT_ASK_PROMPT],
]) {
  assert.ok(prompt.length > 500, name + " prompt is not a stub");
  assert.deepEqual(
    prompt.match(/^#+ .*/gmu).map((line) => line.trim()),
    HEADINGS,
    name + " prompt uses the shared five-module shape",
  );
  // Half-width punctuation is a rule the prompt states, so the prompt itself
  // must obey it; a full-width comma in the instruction would contradict it.
  assert.doesNotMatch(prompt, /[，。、：；！？（）「」“”]/u, name + " prompt is half-width only");
}

// The conflict that made this test exist: an optimizer prompt that asks for a
// fenced block plus advice outside it cannot survive a fence-only strip.
assert.match(DEFAULT_OPTIMIZER_PROMPT, /禁止包裹代码块/u);
assert.doesNotMatch(DEFAULT_OPTIMIZER_PROMPT, /必须包裹在带 markdown/u);
assert.match(DEFAULT_OPTIMIZER_PROMPT, /直接填入用户输入框/u);

// The compaction prompt's segment clause is what keeps a split request from
// being answered as if it held the whole conversation.
assert.match(DEFAULT_COMPACT_PROMPT, /分段优先/u);
assert.match(DEFAULT_COMPACT_PROMPT, /不受本规则约束/u);

console.log("prompts ok: shared shape, half-width only, fence-free, segment precedence");

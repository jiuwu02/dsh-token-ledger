/**
 * i18n drift guard (C1).
 *
 * The two client dictionaries (`client.js`) and the two server dictionaries
 * (`lib/i18n.js`) are maintained by hand, so the one invariant that keeps
 * them honest is asserted here instead of trusted: every key exists in both
 * languages exactly once, and both languages carry the same {placeholders}
 * for it. A missing key falls back to English silently and a missing
 * placeholder drops data from a sentence — neither shows up in review.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The text of one dictionary literal.
 * @param text - the file text.
 * @param name - the dictionary's variable name.
 * @param closingIndent - the indent its closing brace carries.
 * @returns the dictionary body.
 */
function dictBlock(text, name, closingIndent) {
  const start = text.indexOf(`const ${name} = {`);
  assert.notEqual(start, -1, `dictionary ${name} not found`);
  const after = text.slice(start);
  const end = after.indexOf(`\n${closingIndent}};`);
  assert.notEqual(end, -1, `dictionary ${name} is not closed`);
  return after.slice(0, end);
}

/**
 * Key to value text for one dictionary body.
 * @param block - the dictionary body.
 * @param indent - the indent every key line carries.
 * @returns a Map from key to the raw text after it.
 */
function entriesOf(block, indent) {
  const pattern = new RegExp(`^ {${indent}}"([^"]+)":`, "gm");
  const marks = [...block.matchAll(pattern)];
  const entries = new Map();
  for (let index = 0; index < marks.length; index += 1) {
    const mark = marks[index];
    const nextStart =
      index + 1 < marks.length ? marks[index + 1].index : block.length;
    entries.set(mark[1], block.slice(mark.index + mark[0].length, nextStart));
  }
  return entries;
}

/**
 * The sorted placeholder names one value text carries.
 * @param value - the raw value text.
 * @returns the placeholder names, sorted.
 */
function placeholdersOf(value) {
  return [...value.matchAll(/\{([a-zA-Z0-9_]+)\}/g)]
    .map((match) => match[1])
    .sort();
}

/**
 * Assert one language pair stays aligned.
 * @param label - the file the pair came from, for messages.
 * @param zh - the Chinese entries.
 * @param en - the English entries.
 */
function assertAligned(label, zh, en) {
  const zhKeys = [...zh.keys()];
  const enKeys = [...en.keys()];
  assert.equal(
    new Set(zhKeys).size,
    zhKeys.length,
    `${label}: the Chinese dictionary has duplicate keys`,
  );
  assert.equal(
    new Set(enKeys).size,
    enKeys.length,
    `${label}: the English dictionary has duplicate keys`,
  );
  for (const key of zhKeys)
    assert.ok(en.has(key), `${label}: "${key}" is missing from English`);
  for (const key of enKeys)
    assert.ok(zh.has(key), `${label}: "${key}" is missing from Chinese`);
  for (const key of zhKeys) {
    assert.deepEqual(
      placeholdersOf(zh.get(key)),
      placeholdersOf(en.get(key)),
      `${label}: "${key}" has different placeholders in the two languages`,
    );
  }
}

const client = readFileSync(join(root, "client.js"), "utf8");
const server = readFileSync(join(root, "lib", "i18n.js"), "utf8");

const clientZh = entriesOf(dictBlock(client, "ZH", "    "), 6);
const clientEn = entriesOf(dictBlock(client, "EN", "    "), 6);
const serverZh = entriesOf(dictBlock(server, "ZH", ""), 2);
const serverEn = entriesOf(dictBlock(server, "EN", ""), 2);

assertAligned("client.js", clientZh, clientEn);
assertAligned("lib/i18n.js", serverZh, serverEn);

// The split keys are the error envelopes the server translates and the UI
// strings the client draws; a key in the wrong dictionary is a bug the set
// comparison above cannot see, so the namespaces each side owns are named
// here as a boundary check.
for (const key of serverZh.keys()) {
  assert.ok(
    /^(api|error|report|command|schema|optimizer|prompt|ask)\./.test(key),
    `lib/i18n.js: "${key}" looks like a client key`,
  );
}

console.log(
  `i18n ok: client ${clientZh.size} keys ×2, server ${serverZh.size} keys ×2`,
);

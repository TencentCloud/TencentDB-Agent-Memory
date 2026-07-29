/**
 * Demo for issue #160: FTS5 operator sanitization in buildFtsQuery.
 *
 * Shows two things:
 *   1. Adversarial inputs are neutralized — every user token is emitted as a
 *      quoted FTS5 phrase, so operators/stars/colons/parens can't alter query
 *      semantics.
 *   2. The naive fix suggested in the issue (`/(AND|OR|NOT|NEAR)/gi` substring
 *      strip) silently CORRUPTS ordinary words, while per-token quoting keeps
 *      them intact.
 *
 * Run: npm run demo:fts-sanitization
 */

import { buildFtsQuery, _setJiebaForTest, _resetJiebaForTest } from "../src/core/store/sqlite.js";

// Force the jieba-free fallback path so output is deterministic across machines.
_setJiebaForTest(null);

// The buggy fix from the issue's "Suggested Fix" section, for comparison.
function naiveStrip(raw: string): string {
  return raw.replace(/(AND|OR|NOT|NEAR)/gi, " ").replace(/\s+/g, " ").trim();
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

console.log("FTS5 operator sanitization demo (issue #160)");
console.log("============================================");
console.log("");
console.log("1) Adversarial inputs → safe FTS5 MATCH query (every token quoted)");
console.log("");

const attacks = [
  "cats AND dogs",
  "a NOT b NEAR c",
  'x" OR "1"="1',
  "title:secret OR bar*",
  "(drop) NEAR/2 table",
];
const w = Math.max(...attacks.map((a) => a.length)) + 2;
console.log(`${pad("raw input", w)}buildFtsQuery output`);
console.log(`${pad("-".repeat(w - 2), w)}${"-".repeat(40)}`);
for (const a of attacks) {
  console.log(`${pad(a, w)}${buildFtsQuery(a)}`);
}

console.log("");
console.log("2) Ordinary words containing operator substrings — naive strip vs quoting");
console.log("");

const words = ["android network corner notebook", "coordinator organizer nearby"];
const w2 = Math.max(...words.map((s) => s.length)) + 2;
console.log(`${pad("raw input", w2)}${pad("naive /(AND|OR|NOT|NEAR)/gi strip (BROKEN)", 46)}buildFtsQuery (correct)`);
console.log(`${pad("-".repeat(w2 - 2), w2)}${pad("-".repeat(44), 46)}${"-".repeat(40)}`);
for (const s of words) {
  console.log(`${pad(s, w2)}${pad(naiveStrip(s), 46)}${buildFtsQuery(s)}`);
}

console.log("");
console.log("Interpretation:");
console.log("- The naive substring strip mangles android→roid, network→netwk, corner→cner,");
console.log("  coordinator→codinatr, nearby→by — destroying legitimate search recall.");
console.log("- Per-token double-quoting makes operators inert WITHOUT touching the words.");

_resetJiebaForTest();

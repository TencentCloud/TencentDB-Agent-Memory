/**
 * The tokenizer the context budget is measured with.
 *
 * ponytail: this is an ESTIMATE, not the model's tokenizer — the repository has
 * no LLM tokenizer and pulling a dependency in for an estimate is not worth it.
 * Ceiling: counts are off by whatever the real BPE would say. Upgrade path: the
 * envelope pins `tokenizerId`/`tokenizerVersion`, and `Tokenizer` is a port —
 * swap the implementation in the shell and the recorded ids stop matching old
 * measurements, which is exactly the signal you want.
 */

import type { Tokenizer } from "./types.js";

/** Latin-ish text averages ~4 characters per token. */
const CHARS_PER_TOKEN = 4;

/** CJK, Japanese kana and Hangul — roughly one token per character. */
const CJK = /[　-ヿ㐀-䶿一-鿿豈-﫿가-힯]/u;

/**
 * Token estimate for a piece of text. Pure and deterministic: the same string
 * always costs the same, which is what makes a budget re-checkable.
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let rest = 0;
  for (const char of text) {
    if (CJK.test(char)) cjk++;
    else rest++;
  }
  return cjk + Math.ceil(rest / CHARS_PER_TOKEN);
}

/** The default tokenizer port: `estimateTokens` with an id to pin it by. */
export function createCharTokenizer(): Tokenizer {
  return { id: "chars-cjk-v1", version: "1", count: estimateTokens };
}

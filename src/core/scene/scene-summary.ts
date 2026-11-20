/**
 * Scene summary length governance.
 *
 * Every scene block (`scene_blocks/*.md`) starts with a META header:
 *
 *   -----META-START-----
 *   created: ...
 *   updated: ...
 *   summary: ...
 *   heat: N
 *   -----META-END-----
 *
 * `summary` is not just an index field: `generateSceneNavigation()` renders it
 * into the navigation block that `auto-recall` injects into the system prompt
 * at session start, so its length is paid on *every* turn. The extraction
 * prompt asks the model for "30-40 words", but a prompt is not a guarantee —
 * this module is the deterministic engineering cap.
 *
 * Design constraints (see PR description for the review that produced them):
 *   - No model calls, no re-extraction, no retries. Pure string arithmetic.
 *   - Idempotent: `clampSceneSummary(clampSceneSummary(x)) === clampSceneSummary(x)`,
 *     so a second L2 round writes nothing (no COS churn).
 *   - A summary that already fits is returned verbatim — only over-budget text
 *     is rewritten.
 *   - Over-budget text is compacted as an *index*, not as prose: keywords are
 *     segmented with jieba (`Jieba.cut`), function words are dropped, and the
 *     surviving keywords are kept in original order inside the existing budget.
 *     When jieba is unavailable (or nothing but function words survives) the
 *     text is hard-cut on a code-point boundary instead.
 *   - Surrogate-pair safe (`Array.from`, never UTF-16 index slicing).
 *   - Never touches anything outside the `summary:` line of a *valid* META block —
 *     files without a META header are returned byte-identical.
 *
 * Limits are language-normalised: a Latin word counts 1, a CJK character counts
 * 0.5 (≈2 characters per Chinese "word"), so the same 30-word budget means
 * ≈60 Chinese characters or ≈25-30 English words. `maxChars` is a hard ceiling
 * on top of that so a punctuation-free blob cannot slip through.
 */

import { getJieba } from "../text/jieba.js";

export interface SceneSummaryLimits {
  /** Word-equivalents (Latin word = 1, CJK char = 0.5). */
  maxWordEquivalent: number;
  /** Hard ceiling on code points, ellipsis included. */
  maxChars: number;
}

export const SCENE_SUMMARY_LIMITS: SceneSummaryLimits = {
  maxWordEquivalent: 30,
  maxChars: 160,
};

export interface SceneSummaryMeasurement {
  wordEquivalent: number;
  chars: number;
  exceeds: boolean;
}

const META_START = "-----META-START-----";
const META_END = "-----META-END-----";

const LATIN_WORD_RE = /[A-Za-z0-9]+(?:['\u2019-][A-Za-z0-9]+)*/g;
// CJK ideographs, kana, hangul, plus CJK compatibility ideographs.
const CJK_RE = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af\uf900-\ufaff]/g;
const CJK_TAIL_RE = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af\uf900-\ufaff]$/;

// Soft separators: dropped before appending the ellipsis ("结论，…" reads badly).
const SOFT_TRAIL_RE = /[\s，,、；;：:—\-]+$/u;
// Hard terminators: replaced by the ellipsis instead of being kept alongside it.
const HARD_TRAIL_RE = /[\s。！？!?.;；，,、：:—\-]+$/u;

const ELLIPSIS_CJK = "…";
const ELLIPSIS_ASCII = "...";
const EXISTING_ELLIPSIS_RE = /(?:…|\.\.\.)$/;

// A token is a candidate keyword when it carries at least one letter or digit.
const WORDLIKE_RE = /[\p{L}\p{N}]/u;
const WHITESPACE_RE = /\s/;

/**
 * Function words dropped before keywords are packed into the index.
 *
 * Deliberately separate from `ZH_STOP_WORDS` in `store/sqlite.ts`: that one
 * tunes FTS5 recall and must not change with the summary governor. Jieba emits
 * whole words, so this list only needs high-frequency function words — content
 * words are what we want to keep. English entries are the same idea applied to
 * a Latin summary (jieba splits those on whitespace).
 */
const SUMMARY_STOP_WORDS = new Set([
  // pronouns / demonstratives
  "我", "你", "他", "她", "它", "我们", "你们", "他们", "她们", "它们",
  "这", "那", "这个", "那个", "这些", "那些", "这里", "那里", "其", "之",
  // particles / auxiliaries
  "的", "了", "着", "过", "地", "得", "吗", "吧", "呢", "啊", "呀", "哦", "嗯",
  "是", "有", "没有", "没", "不", "会", "能", "可以", "要", "想", "需要",
  // conjunctions / prepositions
  "和", "与", "及", "以及", "或", "或者", "而", "而且", "但", "但是", "却",
  "并", "并且", "因为", "所以", "因此", "如果", "虽然", "然后", "同时",
  "在", "于", "从", "向", "往", "给", "让", "使", "对", "对于", "关于", "被", "把",
  // adverbs / quantifiers
  "也", "就", "都", "很", "又", "还", "再", "才", "只", "已", "已经",
  "个", "一个", "一些", "中", "上", "下", "里", "内", "外",
  // English function words
  "the", "a", "an", "of", "and", "or", "to", "in", "on", "at", "by", "for",
  "with", "that", "this", "these", "those", "is", "are", "was", "were", "be",
  "been", "it", "its", "as", "from", "while", "but", "not", "no", "has", "have",
  "had", "will", "would", "can", "could", "should",
]);

/** Collapse whitespace (incl. CRLF and full-width space) into single spaces. */
export function normalizeSummary(input: string): string {
  if (!input) return "";
  return input.replace(/\s+/g, " ").trim();
}

function countWords(text: string): number {
  const latin = text.match(LATIN_WORD_RE)?.length ?? 0;
  const cjk = text.match(CJK_RE)?.length ?? 0;
  return latin + cjk * 0.5;
}

function fits(text: string, limits: SceneSummaryLimits): boolean {
  return (
    countWords(text) <= limits.maxWordEquivalent &&
    Array.from(text).length <= limits.maxChars
  );
}

/** Measure a summary against the limits (whitespace-normalised first). */
export function measureSceneSummary(
  input: string,
  limits: SceneSummaryLimits = SCENE_SUMMARY_LIMITS,
): SceneSummaryMeasurement {
  const text = normalizeSummary(input);
  const wordEquivalent = countWords(text);
  const chars = Array.from(text).length;
  return {
    wordEquivalent,
    chars,
    exceeds: wordEquivalent > limits.maxWordEquivalent || chars > limits.maxChars,
  };
}

function pickEllipsis(text: string): string {
  return CJK_TAIL_RE.test(text) ? ELLIPSIS_CJK : ELLIPSIS_ASCII;
}

/** Drop trailing soft separators (comma / enumeration mark / colon / dash). */
function trimSoftTrail(text: string): string {
  return text.replace(SOFT_TRAIL_RE, "").trimEnd();
}

/**
 * Hard fallback: drop trailing code points until the text fits.
 *
 * The input is pre-sliced to the character budget first: `clampSceneSummary`
 * only calls this when the text is over budget, and a scene file is written by
 * the model, so `body` can be tens of KB of punctuation-free text. Re-measuring
 * the full string on every pop would be O(n²) (measured: 2k chars ≈ 47ms,
 * 50k chars ≈ tens of seconds) and would stall the L2 round; slicing first
 * bounds the loop to `maxChars` iterations, since the budget never exceeds it.
 */
function cutToFit(body: string, limits: SceneSummaryLimits): string {
  const budget = Math.max(0, limits.maxChars);
  const chars = Array.from(body);
  if (chars.length > budget) chars.length = budget;
  while (chars.length > 0 && !fits(chars.join(""), limits)) {
    chars.pop();
  }
  return chars.join("").trimEnd();
}

function withEllipsis(body: string, limits: SceneSummaryLimits): string {
  let trimmed = trimSoftTrail(body);
  if (!trimmed) return "";

  // An already-truncated summary keeps its marker: strip the old one and
  // re-append it after fitting, instead of leaving a markerless cut.
  if (EXISTING_ELLIPSIS_RE.test(trimmed)) {
    trimmed = trimmed.replace(EXISTING_ELLIPSIS_RE, "").trimEnd();
  } else {
    // Drop the sentence terminator the ellipsis replaces ("结论。…" → "结论…").
    trimmed = trimmed.replace(HARD_TRAIL_RE, "").trimEnd();
  }
  if (!trimmed) return "";

  const suffix = pickEllipsis(trimmed);
  const suffixLen = Array.from(suffix).length;
  const bodyBudget: SceneSummaryLimits = {
    maxWordEquivalent: limits.maxWordEquivalent,
    maxChars: limits.maxChars - suffixLen,
  };
  const head = cutToFit(trimmed, bodyBudget);
  if (!head) return "";
  return head + suffix;
}

/** A token is worth keeping when it carries a letter/digit and is not a 虚词. */
function isKeywordToken(token: string): boolean {
  if (!token || !WORDLIKE_RE.test(token)) return false;
  return !SUMMARY_STOP_WORDS.has(token.toLowerCase());
}

/**
 * Compact an over-budget summary into a keyword index.
 *
 * `Jieba.cut` returns every character, so concatenating the surviving tokens in
 * order yields a *subsequence of the original text* — the summary still reads
 * like the scene, minus the function words. One space is re-inserted wherever
 * the original had whitespace, which keeps Latin summaries readable
 * ("user prefers dark mode") without inventing punctuation.
 *
 * Returns `""` when jieba is unavailable or nothing survives the stop-word
 * filter, so the caller can fall back to a hard cut.
 */
function compactByKeywords(text: string, limits: SceneSummaryLimits): string {
  const jieba = getJieba();
  if (!jieba) return "";

  let tokens: string[];
  try {
    tokens = jieba.cut(text, true);
  } catch {
    return ""; // native call failed at runtime — hard cut instead
  }
  if (tokens.length === 0) return "";

  // Reserve room for the marker up front; the final trim below covers the case
  // where the packed body ends in a different script than the input.
  const suffixLen = Array.from(pickEllipsis(text)).length;
  const bodyBudget: SceneSummaryLimits = {
    maxWordEquivalent: limits.maxWordEquivalent,
    maxChars: Math.max(0, limits.maxChars - suffixLen),
  };

  let acc = "";
  let sawSpace = false; // dropped tokens since the last kept one contained space
  for (const token of tokens) {
    if (!isKeywordToken(token)) {
      if (WHITESPACE_RE.test(token)) sawSpace = true;
      continue;
    }
    const candidate = acc && sawSpace ? `${acc} ${token}` : acc + token;
    if (!fits(candidate, bodyBudget)) break; // first overflow = end of the index
    acc = candidate;
    sawSpace = false;
  }
  if (!acc) return "";

  const suffix = pickEllipsis(acc);
  let head = acc;
  while (head && !fits(head + suffix, limits)) {
    head = Array.from(head).slice(0, -1).join("").trimEnd();
  }
  return head ? head + suffix : "";
}

/**
 * Clamp a scene summary to `limits`.
 *
 * Over-budget order of preference:
 *   1. jieba keyword index — function words dropped, keywords in original order;
 *   2. hard code-point cut (jieba missing, or the summary is all function words).
 *
 * Returns the input unchanged when it already fits, which makes repeated L2
 * rounds free of writes (and therefore idempotent).
 */
export function clampSceneSummary(
  input: string,
  limits: SceneSummaryLimits = SCENE_SUMMARY_LIMITS,
): string {
  const text = normalizeSummary(input);
  if (!text) return "";
  if (fits(text, limits)) return text;

  let result = compactByKeywords(text, limits) || withEllipsis(text, limits);

  // Guarantee the invariant (and therefore idempotency) even for pathological
  // inputs where the marker itself pushed us over.
  while (result && !fits(result, limits)) {
    const chars = Array.from(result);
    chars.pop();
    result = chars.join("").trimEnd();
  }
  return result;
}

/**
 * Clamp the `summary:` line of a scene block file in memory.
 *
 * Surgical by design: only the value after `summary:` changes. `created`,
 * `updated`, `heat`, the body, CRLF line endings and any other byte of the
 * file stay untouched, so this cannot be mistaken for a content edit by the
 * `l2_extraction` diffing logic (which compares `parseSceneBlock().content`).
 *
 * Files without a complete META header are returned unchanged — a body line
 * that happens to start with `summary:` must never be rewritten.
 */
export function clampSummaryInSceneFile(raw: string): { content: string; changed: boolean } {
  const startIdx = raw.indexOf(META_START);
  const endIdx = raw.indexOf(META_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return { content: raw, changed: false };
  }

  const metaStart = startIdx + META_START.length;
  const meta = raw.slice(metaStart, endIdx);

  // `[ \t]*` (not `\s*`) so an empty value cannot swallow the next line —
  // `^summary:\s*(.*)$` matches `heat: 5` as group 1 when the line is empty.
  const summaryLineRe = /^([ \t]*)summary:[ \t]*(.*)$/m;
  const match = summaryLineRe.exec(meta);
  if (!match) return { content: raw, changed: false };

  const current = match[2] ?? "";
  const clamped = clampSceneSummary(current);
  if (clamped === current) return { content: raw, changed: false };

  // Function replacement form: a summary containing `$&` / `$1` must not be
  // interpreted as a replacement pattern.
  const replacedMeta = meta.replace(summaryLineRe, (_line, indent: string) => `${indent}summary: ${clamped}`);
  const content = raw.slice(0, metaStart) + replacedMeta + raw.slice(endIdx);
  return { content, changed: content !== raw };
}

/** Convenience wrapper for callers that only need the clamped text. */
export function clampSummaryInText(raw: string): string {
  return clampSummaryInSceneFile(raw).content;
}

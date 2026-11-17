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
 *   - Never a bare hard cut unless the budget cannot hold a single clause:
 *     complete sentences are preferred, then clauses, and only then code points.
 *   - Surrogate-pair safe (`Array.from`, never UTF-16 index slicing).
 *   - Never touches anything outside the `summary:` line of a *valid* META block —
 *     files without a META header are returned byte-identical.
 *
 * Limits are language-normalised: a Latin word counts 1, a CJK character counts
 * 0.5 (≈2 characters per Chinese "word"), so the same 30-word budget means
 * ≈60 Chinese characters or ≈25-30 English words. `maxChars` is a hard ceiling
 * on top of that so a punctuation-free blob cannot slip through.
 */

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

const SENTENCE_END_RE = /[。！？；!?;]/;
const CLAUSE_END_RE = /[，,、：:—]/;

// Soft separators: dropped before appending the ellipsis ("结论，…" reads badly).
const SOFT_TRAIL_RE = /[\s，,、；;：:—\-]+$/u;
// Hard terminators: replaced by the ellipsis instead of being kept alongside it.
const HARD_TRAIL_RE = /[\s。！？!?.;；，,、：:—\-]+$/u;

const ELLIPSIS_CJK = "…";
const ELLIPSIS_ASCII = "...";
const EXISTING_ELLIPSIS_RE = /(?:…|\.\.\.)$/;

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

/**
 * Split into semantic units, each keeping its trailing punctuation.
 * `boundary` decides the granularity: sentence terminators first, clause
 * separators only when a single sentence does not fit.
 */
function splitUnits(text: string, boundary: RegExp): string[] {
  const units: string[] = [];
  let current = "";
  for (const ch of Array.from(text)) {
    current += ch;
    if (boundary.test(ch)) {
      units.push(current);
      current = "";
    }
  }
  if (current) units.push(current);
  return units;
}

/** Drop trailing soft separators (comma / enumeration mark / colon / dash). */
function trimSoftTrail(text: string): string {
  return text.replace(SOFT_TRAIL_RE, "").trimEnd();
}

/**
 * Would `body` still fit once the ellipsis marker is accounted for?
 * Used by the greedy accumulation so we never land exactly on the limit and
 * then have no room for the marker. The trailing terminator is stripped first
 * because `withEllipsis()` replaces it — otherwise a sentence that would fit
 * exactly would be rejected for one extra character.
 */
function fitsWithEllipsis(body: string, limits: SceneSummaryLimits): boolean {
  const trimmed = trimSoftTrail(body);
  if (!trimmed) return false;
  if (EXISTING_ELLIPSIS_RE.test(trimmed)) return fits(trimmed, limits);
  const base = trimmed.replace(HARD_TRAIL_RE, "").trimEnd() || trimmed;
  return fits(base + pickEllipsis(base), limits);
}

/** Greedily accumulate units while the result (plus ellipsis) still fits. */
function greedyFit(units: string[], limits: SceneSummaryLimits): string {
  let acc = "";
  for (const unit of units) {
    const candidate = acc + unit;
    if (!fitsWithEllipsis(candidate, limits)) break;
    acc = candidate;
  }
  return acc;
}

/** Hard fallback: drop trailing code points until the text fits. */
function cutToFit(body: string, limits: SceneSummaryLimits): string {
  const chars = Array.from(body);
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

/**
 * Clamp a scene summary to `limits`.
 *
 * Order of preference when over budget:
 *   1. keep as many *complete sentences* as fit;
 *   2. otherwise keep as many *complete clauses* as fit;
 *   3. otherwise (single giant clause) cut on a code-point boundary.
 *
 * Returns the input unchanged when it already fits, which makes repeated L2
 * rounds free of writes.
 */
export function clampSceneSummary(
  input: string,
  limits: SceneSummaryLimits = SCENE_SUMMARY_LIMITS,
): string {
  const text = normalizeSummary(input);
  if (!text) return "";
  if (fits(text, limits)) return text;

  const sentences = greedyFit(splitUnits(text, SENTENCE_END_RE), limits);
  const clauses = sentences ? "" : greedyFit(splitUnits(text, CLAUSE_END_RE), limits);
  const seed = sentences || clauses || text;

  let result = withEllipsis(seed, limits);

  // Guarantee the invariant (and therefore idempotency) even for pathological
  // inputs where the ellipsis itself pushed us over.
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

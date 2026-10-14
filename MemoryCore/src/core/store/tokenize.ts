/**
 * Store-layer shared tokenization + BM25 score helpers.
 *
 * These were historically defined in `sqlite.ts` and imported across the
 * codebase (`memory-search`, `conversation-search`, `skill-store`, `l1-dedup`,
 * `auto-recall`). They are backend-agnostic — the SQLite FTS5 path, the TCVDB
 * sparse-vector path, and the MongoDB `$search` path all need the same Chinese
 * word segmentation so that write-side and query-side tokens line up.
 *
 * Canonical location is here; `sqlite.ts` re-exports for backward compatibility.
 *
 * Design (D6): we pre-segment Chinese with jieba `cutForSearch` and store the
 * space-joined tokens in a `tokens` field. Lucene / FTS5 then use a plain
 * whitespace tokenizer and never re-segment, keeping all three backends aligned.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ── Chinese word segmentation (jieba) ──
// Lazy-loaded singleton: initialised on first call. If @node-rs/jieba is
// unavailable, falls back to dictionary-less CJK character-bigram
// segmentation (segmentCjkFallback) so CJK recall stays functional.

interface JiebaInstance {
  cutForSearch(text: string, hmm: boolean): string[];
}

let _jieba: JiebaInstance | null | undefined; // undefined = not yet tried

function getJieba(): JiebaInstance | null {
  if (_jieba !== undefined) return _jieba;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Jieba } = require("@node-rs/jieba");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { dict } = require("@node-rs/jieba/dict");
    _jieba = Jieba.withDict(dict) as JiebaInstance;
  } catch (err) {
    _jieba = null; // mark as unavailable — won't retry
    // Native module missing (bundled deployments often skip platform binaries).
    // Recall must keep working, so we fall back to CJK character-bigram
    // segmentation — but the degradation has to be visible, or CJK users run
    // for weeks on dictionary-less recall without noticing (issue #1382).
    console.warn(
      "[tokenize] @node-rs/jieba unavailable (" +
        (err instanceof Error ? err.message : String(err)) +
        ") — falling back to CJK character-bigram segmentation. " +
        "Chinese recall stays functional but is dictionary-less; " +
        "install @node-rs/jieba for dictionary-quality segmentation.",
    );
  }
  return _jieba;
}

// CJK script runs (Han / Kana / Hangul). These scripts have no spaces, so a
// whitespace tokenizer keeps each contiguous run as ONE token unless the text
// is pre-segmented — the root cause of the #1382 silent-recall failure.
const CJK_CHAR_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;

/**
 * Dictionary-less fallback segmentation used when `@node-rs/jieba` cannot be
 * loaded (see {@link getJieba}).
 *
 * Runs of letters/digits that are not CJK stay whole words; each contiguous
 * CJK run contributes both its unigrams and its bigrams. Bigrams alone cannot
 * express two-character words cut out of a longer run, unigrams alone cannot
 * match them ("口令" in "专属测试口令"), and keeping the raw run whole is what
 * broke CJK recall entirely before #1382 — so the INDEX side stores both
 * granularities and lets BM25 ranking absorb the extra noise.
 *
 * With `queryMode` the unigrams of multi-character runs are omitted: a query
 * term must precisely match an indexed token, and emitting "口"/"令" for the
 * query "口令" would OR-match unrelated documents. Single-character runs still
 * yield their unigram, so one-character queries keep working.
 *
 * MUST be used on both the write side ({@link tokenizeForFts}) and the query
 * side ({@link buildFtsQuery} / {@link extractQueryTokens}) so indexed and
 * queried tokens stay aligned on every backend (SQLite FTS5, TCVDB sparse,
 * MongoDB $search).
 *
 * Example (index mode, default):
 *   "闪电阻尼器 API" → ["闪","闪电","电","电阻","阻","阻尼","尼","尼器","器","API"]
 * Example (queryMode):
 *   "闪电阻尼器 API" → ["闪电","电阻","阻尼","尼器","API"]
 */
export function segmentCjkFallback(
  raw: string,
  opts?: { queryMode?: boolean },
): string[] {
  const queryMode = opts?.queryMode === true;
  const chars = Array.from(raw);
  const out: string[] = [];
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i]!;
    if (!WORD_CHAR_RE.test(ch)) {
      i++;
      continue;
    }
    const cjkRun = CJK_CHAR_RE.test(ch);
    let j = i + 1;
    while (
      j < chars.length &&
      WORD_CHAR_RE.test(chars[j]!) &&
      CJK_CHAR_RE.test(chars[j]!) === cjkRun
    ) {
      j++;
    }
    const run = chars.slice(i, j).join("");
    if (!cjkRun) {
      out.push(run);
    } else if (run.length === 1) {
      out.push(run);
    } else {
      for (let k = 0; k < run.length; k++) {
        if (!queryMode) out.push(run.charAt(k));
        if (k + 1 < run.length) out.push(run.slice(k, k + 2));
      }
    }
    i = j;
  }
  return out;
}

/**
 * Common Chinese stop-words that add noise to keyword queries.
 * Kept small on purpose — only high-frequency function words.
 */
export const ZH_STOP_WORDS = new Set([
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一",
  "一个", "上", "也", "很", "到", "说", "要", "去", "你", "会", "着",
  "没有", "看", "好", "自己", "这", "他", "她", "它", "们", "那",
  "吗", "吧", "呢", "啊", "呀", "哦", "嗯",
]);

/**
 * Build an FTS5 MATCH query from raw text.
 *
 * When `@node-rs/jieba` is available, uses jieba's search-engine mode
 * (`cutForSearch`) for accurate Chinese word segmentation, producing much
 * better recall than the fallback approach. Falls back to
 * {@link segmentCjkFallback} (CJK unigram+bigram) if jieba is not installed —
 * the old raw-regex fallback stored contiguous CJK as one giant token that no
 * CJK query could ever match (#1382).
 *
 * Tokens are OR-joined as quoted FTS5 phrase terms so that a document matching
 * *any* token is returned. BM25 naturally ranks documents that match more
 * tokens higher, so precision is preserved while recall improves.
 *
 * Example (with jieba):
 *   "用户喜欢编程和TypeScript" → '"用户" OR "喜欢" OR "编程" OR "TypeScript"'
 * Example (fallback, queryMode):
 *   "旅行计划 API" → '"旅行" OR "行计" OR "计划" OR "API"'
 */
export function buildFtsQuery(raw: string): string | null {
  const jieba = getJieba();

  let tokens: string[];
  if (jieba) {
    tokens = jieba
      .cutForSearch(raw, true)
      .map((t) => t.trim())
      .filter((t) => {
        if (!t) return false;
        if (!/[\p{L}\p{N}]/u.test(t)) return false;
        if (ZH_STOP_WORDS.has(t)) return false;
        return true;
      });
    tokens = [...new Set(tokens)];
  } else {
    tokens = segmentCjkFallback(raw, { queryMode: true })
      .map((t) => t.trim())
      .filter((t) => {
        if (!t) return false;
        if (!/[\p{L}\p{N}]/u.test(t)) return false;
        if (ZH_STOP_WORDS.has(t)) return false;
        return true;
      });
    tokens = [...new Set(tokens)];
  }

  if (tokens.length === 0) return null;
  const quoted = tokens.map((t) => `"${t.replaceAll('"', "")}"`);
  return quoted.join(" OR ");
}

/**
 * Return the raw keyword tokens (de-duplicated, stop-word filtered) for a query.
 *
 * Unlike {@link buildFtsQuery} (which produces FTS5 MATCH syntax), this yields
 * a plain token array — used by backends whose query language is not FTS5, e.g.
 * MongoDB `$search` where we join tokens with spaces for a whitespace analyzer.
 * Returns `[]` when nothing meaningful remains.
 */
export function extractQueryTokens(raw: string): string[] {
  const jieba = getJieba();
  if (jieba) {
    const tokens = jieba
      .cutForSearch(raw, true)
      .map((t) => t.trim())
      .filter((t) => {
        if (!t) return false;
        if (!/[\p{L}\p{N}]/u.test(t)) return false;
        if (ZH_STOP_WORDS.has(t)) return false;
        return true;
      });
    return [...new Set(tokens)];
  }
  return [
    ...new Set(
      segmentCjkFallback(raw, { queryMode: true })
        .map((t) => t.trim())
        .filter((t) => {
          if (!t) return false;
          if (!/[\p{L}\p{N}]/u.test(t)) return false;
          if (ZH_STOP_WORDS.has(t)) return false;
          return true;
        }),
    ),
  ];
}

/**
 * Tokenize text for keyword indexing (write-side).
 *
 * Uses jieba `cutForSearch()` (search-engine mode) to segment Chinese text,
 * then joins tokens with spaces. The resulting string is stored in the search
 * `content` / `tokens` column so a whitespace/unicode61 tokenizer can split it
 * into meaningful words — including both full words and their sub-words.
 *
 * Falls back to {@link segmentCjkFallback} if jieba is unavailable. Storing
 * the raw text instead would keep every contiguous CJK run as one FTS token,
 * making CJK queries unable to match anything (#1382).
 *
 * Example (with jieba):
 *   "用户五月去日本旅行" → "用户 五月 去 日本 旅行"
 *   "人工智能的分支"     → "人工 智能 人工智能 的 分支"
 * Example (fallback):
 *   "我的口令" → "我 我的 的 的口 口 口令 令"
 */
export function tokenizeForFts(raw: string): string {
  const jieba = getJieba();
  if (!jieba) return segmentCjkFallback(raw).join(" ");
  const tokens = jieba.cutForSearch(raw, true);
  return tokens.join(" ");
}

/**
 * Reset jieba state so next call re-initialises. Testing only.
 * @internal
 */
export function _resetJiebaForTest(): void {
  _jieba = undefined;
}

/**
 * Override jieba instance (or set to `null` to force fallback). Testing only.
 * @internal
 */
export function _setJiebaForTest(instance: JiebaInstance | null): void {
  _jieba = instance;
}

/**
 * Convert a SQLite FTS5 BM25 rank (negative = more relevant) to a 0–1 score.
 * Mirrors the formula in openclaw core `hybrid.ts`.
 */
export function bm25RankToScore(rank: number): number {
  if (!Number.isFinite(rank)) return 1 / (1 + 999);
  if (rank < 0) {
    const relevance = -rank;
    return relevance / (1 + relevance);
  }
  return 1 / (1 + rank);
}

/**
 * Convert a MongoDB `$search` `$meta:"searchScore"` (unbounded positive, higher
 * = more relevant) to the same 0–1 scale as SQLite BM25 (D12).
 *
 * SQLite's `bm25RankToScore` maps a *relevance* magnitude via
 * `relevance / (1 + relevance)` (its negative branch). Mongo's searchScore is
 * already a positive relevance, so we feed it through the identical transform.
 * This keeps the downstream `scoreThreshold=0.3` gate meaningful across both
 * backends without touching SQLite or the threshold. Equivalent to
 * `bm25RankToScore(-searchScore)` for searchScore > 0.
 */
export function mongoSearchScoreToScore(searchScore: number): number {
  if (!Number.isFinite(searchScore) || searchScore <= 0) return 0;
  return searchScore / (1 + searchScore);
}

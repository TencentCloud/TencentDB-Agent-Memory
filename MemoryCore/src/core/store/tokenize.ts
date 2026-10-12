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
// unavailable, falls back to Unicode-regex splitting.

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
  } catch {
    _jieba = null; // mark as unavailable — won't retry
  }
  return _jieba;
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
 * better recall than the previous regex-only approach. Falls back to
 * Unicode-regex splitting if jieba is not installed.
 *
 * Tokens are OR-joined as quoted FTS5 phrase terms so that a document matching
 * *any* token is returned. BM25 naturally ranks documents that match more
 * tokens higher, so precision is preserved while recall improves.
 *
 * Example (with jieba):
 *   "用户喜欢编程和TypeScript" → '"用户" OR "喜欢" OR "编程" OR "TypeScript"'
 * Example (fallback):
 *   "旅行计划 API" → '"旅行计划" OR "API"'
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
    tokens =
      raw
        .match(/[\p{L}\p{N}_]+/gu)
        ?.map((t) => t.trim())
        .filter(Boolean) ?? [];
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
  return (
    raw
      .match(/[\p{L}\p{N}_]+/gu)
      ?.map((t) => t.trim())
      .filter(Boolean) ?? []
  );
}

/**
 * Tokenize text for keyword indexing (write-side).
 *
 * Uses jieba `cutForSearch()` (search-engine mode) to segment Chinese text,
 * then joins tokens with spaces. The resulting string is stored in the search
 * `content` / `tokens` column so a whitespace/unicode61 tokenizer can split it
 * into meaningful words — including both full words and their sub-words.
 *
 * Falls back to the original text if jieba is unavailable.
 *
 * Example (with jieba):
 *   "用户五月去日本旅行" → "用户 五月 去 日本 旅行"
 *   "人工智能的分支"     → "人工 智能 人工智能 的 分支"
 */
export function tokenizeForFts(raw: string): string {
  const jieba = getJieba();
  if (!jieba) return raw;
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

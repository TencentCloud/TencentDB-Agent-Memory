/**
 * VectorStore: SQLite-based vector storage using sqlite-vec extension.
 *
 * Manages two layers of vector-indexed data in a single SQLite database:
 *
 * **L1 (structured memories):**
 * 1. `l1_records` — relational metadata table (content, type, priority, scene, timestamps)
 * 2. `l1_vec` — vec0 virtual table for cosine similarity search
 *
 * **L0 (raw conversations):**
 * 3. `l0_conversations` — relational metadata table (session_key, role, message text, timestamps)
 * 4. `l0_vec` — vec0 virtual table for cosine similarity search on individual messages
 *
 * Dependencies: Node.js built-in `node:sqlite` (Node 22+) + `sqlite-vec` (from root workspace).
 *
 * Design:
 * - All operations are synchronous (DatabaseSync API).
 * - Writes use manual BEGIN/COMMIT transactions for atomicity (metadata + vector).
 * - vec0 virtual table does NOT support ON CONFLICT, so upsert = delete + insert.
 * - Thread-safe via WAL mode.
 */

import { createRequire } from "node:module";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { MemoryRecord } from "../record/l1-writer.js";
import type { EmbeddingProviderInfo } from "./embedding.js";
import type {
  IMemoryStore,
  StoreCapabilities,
  L0Record,
  L1SearchResult,
  L1FtsResult,
  L0SearchResult,
  L0FtsResult,
} from "./types.js";
import type { Logger } from "../types.js";

// ============================
// Types
// ============================

export interface VectorSearchResult {
  record_id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  /** Cosine similarity score (1.0 - cosine_distance) */
  score: number;
  timestamp_str: string;
  timestamp_start: string;
  timestamp_end: string;
  session_key: string;
  session_id: string;
  /** Raw metadata JSON string (e.g., contains activity_start_time / activity_end_time for episodic) */
  metadata_json: string;
}

/** L0 single-message vector search result. */
export interface L0VectorSearchResult {
  record_id: string;
  session_key: string;
  session_id: string;
  role: string;
  message_text: string;
  /** Cosine similarity score (1.0 - cosine_distance) */
  score: number;
  recorded_at: string;
  /** Original message timestamp (epoch ms) */
  timestamp: number;
}

/** Raw row returned by L1 record queries (column names match SQLite schema). */
export interface L1RecordRow {
  record_id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  session_key: string;
  session_id: string;
  timestamp_str: string;
  timestamp_start: string;
  timestamp_end: string;
  created_time: string;
  updated_time: string;
  metadata_json: string;
}

export interface L0RecordRow {
  record_id: string;
  session_key: string;
  session_id: string;
  role: string;
  message_text: string;
  recorded_at: string;
  timestamp: number;
}

/** Filter options for querying L1 records from SQLite. */
export interface L1QueryFilter {
  /** If provided, only return records for this session key (conversation channel). */
  sessionKey?: string;
  /** If provided, only return records for this session ID (single conversation instance). */
  sessionId?: string;
  /** If provided, only return records with updated_time strictly after this ISO 8601 UTC timestamp. */
  updatedAfter?: string;
}

const TAG = "[memory-tdai][sqlite]";

/** Persisted metadata about the embedding provider used to generate stored vectors. */
interface EmbeddingMeta {
  provider: string;
  model: string;
  dimensions: number;
}

/** Result of VectorStore.init() — indicates whether a re-embed is needed. */
export interface VectorStoreInitResult {
  /**
   * `true` if the embedding provider/model/dimensions changed since
   * the vectors were last written.  Callers should re-embed all texts
   * (via `reindexAll()`) after receiving this flag.
   */
  needsReindex: boolean;
  /** Human-readable reason (for logging). */
  reason?: string;
}

// Use createRequire to load the experimental node:sqlite module
const require = createRequire(import.meta.url);

function requireNodeSqlite(): typeof import("node:sqlite") {
  return require("node:sqlite") as typeof import("node:sqlite");
}

// ============================
// FTS5 helpers (adapted from openclaw core hybrid.ts)
// ============================

// ── Chinese word segmentation (jieba) ──
// Lazy-loaded singleton: initialised on first call to `buildFtsQuery`.
// If @node-rs/jieba is unavailable, falls back to Unicode-regex splitting.

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
 * Common Chinese stop-words that add noise to FTS5 queries.
 * Kept small on purpose — only high-frequency function words.
 */
const ZH_STOP_WORDS = new Set([
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一",
  "一个", "上", "也", "很", "到", "说", "要", "去", "你", "会", "着",
  "没有", "看", "好", "自己", "这", "他", "她", "它", "们", "那",
  "吗", "吧", "呢", "啊", "呀", "哦", "嗯",
]);

/**
 * Escape a single token into a safe FTS5 literal phrase.
 *
 * FTS5 query syntax reserves characters/keywords that, when fed raw user
 * input, can change query semantics or trigger a syntax error (injection):
 * quotes (`"` `'`), prefix wildcard (`*`), grouping (`(` `)`), boolean ops
 * (`AND` `OR` `NOT`), proximity (`NEAR`), column qualifier (`:`), caret (`^`),
 * and minus (`-`).
 *
 * The recommended defence is to wrap every token in double quotes so it is
 * parsed as a *literal phrase*: inside a phrase the only character that needs
 * escaping is the double quote itself, written as two consecutive quotes
 * (`""`). Once quoted, all reserved characters lose their syntactic meaning
 * and become ordinary text.
 *
 * We *escape* (not strip) the double quote so literal content is preserved —
 * stripping would silently drop characters and hurt recall.
 *
 * @param token  A single already-tokenised term (no surrounding whitespace).
 * @returns A double-quoted FTS5 phrase literal safe to embed in a MATCH query.
 * @see https://www.sqlite.org/fts5.html#full_text_query_syntax
 */
export function sanitizeFtsToken(token: string): string {
  // Inside an FTS5 phrase the only special character is `"` — escape it by
  // doubling. Every other char (`* ( ) : ^ - AND OR NOT NEAR` …) is taken
  // literally inside the quotes, neutralising injection attempts.
  return `"${token.replaceAll('"', '""')}"`;
}

/**
 * Whitelist-based sanitiser for raw FTS5 query input (defence-in-depth).
 *
 * An explicit, character-level whitelist applied to the *raw* user input
 * *before* tokenisation. It keeps only characters that are both safe and
 * meaningful for keyword search — letters, digits, underscore, whitespace,
 * dot, slash and hyphen — and **drops** every FTS5 operator (`" ' * ( ) : ^`
 * etc.) at the character level, before they can reach the query parser.
 *
 * This is intentionally *stricter* than `sanitizeFtsToken` (which neutralises
 * operators by quoting them): here the operators are simply removed. Use it as
 * an optional front-end filter for belt-and-braces protection — e.g. when the
 * downstream tokeniser is untrusted or when policy mandates allow-list input
 * validation.
 *
 * Note: keyword operators made of plain letters (`AND`/`OR`/`NOT`/`NEAR`)
 * survive the whitelist by design — they are neutralised later by
 * `sanitizeFtsToken`'s quoting. The two layers are complementary.
 *
 * @returns The cleaned string (may be empty). Feed the result into
 *          `buildFtsQuery()` for tokenisation + phrase escaping.
 * @see https://www.sqlite.org/fts5.html#full_text_query_syntax
 */
export function sanitizeFtsWhitelist(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) return "";
  // Keep letters, digits, underscore, whitespace, dot, slash, hyphen.
  // Drop quotes, *, (, ), :, ^ and any other FTS5 operator → replaced by space.
  return raw.replace(/[^\p{L}\p{N}_\s./-]/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * Build an FTS5 MATCH query from raw text.
 *
 * When `@node-rs/jieba` is available, uses jieba's search-engine mode
 * (`cutForSearch`) for accurate Chinese word segmentation, producing
 * much better recall than the previous regex-only approach.
 *
 * Falls back to Unicode-regex splitting (`/[\p{L}\p{N}_]+/gu`) if
 * jieba is not installed.
 *
 * Tokens are OR-joined as quoted FTS5 phrase terms so that a document
 * matching *any* token is returned.  BM25 naturally ranks documents that
 * match more tokens higher, so precision is preserved while recall is
 * significantly improved — especially for longer queries and when running
 * in FTS-only fallback mode (no embedding available).
 *
 * Example (with jieba):
 *   "用户喜欢编程和TypeScript" → '"用户" OR "喜欢" OR "编程" OR "TypeScript"'
 * Example (fallback):
 *   "旅行计划 API" → '"旅行计划" OR "API"'
 */
export function buildFtsQuery(raw: string): string | null {
  // Strip FTS5 operators (AND, OR, NOT, NEAR) before tokenization
  // to prevent user input from altering FTS5 query semantics.
  const FTS5_OPS = /\b(AND|OR|NOT|NEAR)\b/gi;
  const cleaned = raw.replace(FTS5_OPS, " ");

  const jieba = getJieba();

  let tokens: string[];
  if (jieba) {
    // jieba cutForSearch: splits long words further for better recall
    // e.g. "北京烤鸭" → ["北京", "烤鸭", "北京烤鸭"]
    tokens = jieba
      .cutForSearch(cleaned, true)
      .map((t) => t.trim())
      .filter((t) => {
        if (!t) return false;
        // Remove pure whitespace / punctuation tokens
        if (!/[\p{L}\p{N}]/u.test(t)) return false;
        // Remove common Chinese stop-words to reduce noise
        if (ZH_STOP_WORDS.has(t)) return false;
        return true;
      });
    // Deduplicate (cutForSearch may produce duplicates for sub-words)
    tokens = [...new Set(tokens)];
  } else {
    // Fallback: simple Unicode regex split
    tokens =
      cleaned
        .match(/[\p{L}\p{N}_]+/gu)
        ?.map((t) => t.trim())
        .filter(Boolean) ?? [];
  }

  if (tokens.length === 0) return null;
  const quoted = tokens.map(sanitizeFtsToken);
  return quoted.join(" OR ");
}
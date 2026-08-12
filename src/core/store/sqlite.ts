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
 * Dependencies: Built-in SQLite module (`node:sqlite` on Node 22+, `bun:sqlite` on Bun) + `sqlite-vec` (from root workspace).
 *
 * Design:
 * - All operations are synchronous (DatabaseSync API).
 * - Writes use manual BEGIN/COMMIT transactions for atomicity (metadata + vector).
 * - vec0 virtual table does NOT support ON CONFLICT, so upsert = delete + insert.
 * - Thread-safe via WAL mode.
 */

import { createRequire } from "node:module";
import { getEnv } from "../../utils/env.js";
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
import type { ScopeMode } from "../hooks/auto-recall/scope.js";

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
  /** Project this memory came from; '' when unknown. */
  project_id?: string;
  /** 'global' | 'project' | '' (legacy records predate scoping). */
  scope?: string;
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
  project_id: string;
  /** '' for a row written before the column existed. */
  scope: string;
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

// ── Full-reindex gate + single-flight (wave tdai-memory-subagents-2026-08-02, P8) ──
// Module-level so every VectorStore instance (gateway core, apply executor,
// readonly diagnostics) observes the same state — they share one vectors.db.
// During a full reindexAll the store fails OPEN on vector reads (empty result,
// not an error) and SKIPS vector dual-writes (meta rows still go through); the
// post-reindex count reconciliation backfills the delta per-row
// (reindexL1Records / reindexL0Records, ТЗ §5.6).
let reindexInProgress = false;

/** Serialize full reindexAll invocations (single-flight, ТЗ §5.6). */
let reindexLock: Promise<void> = Promise.resolve();
function withReindexSingleFlight<T>(fn: () => Promise<T>): Promise<T> {
  const prev = reindexLock;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  reindexLock = gate;
  return prev.then(fn).finally(() => {
    release();
  });
}

/**
 * How long a statement waits for another process's write lock.
 *
 * Named because a second place has to UNDO it: the postponed-rebuild retry
 * must not park a request for five seconds just to learn that the lock is
 * still held (`tryPostponedFtsRebuild`).
 */
const SQLITE_BUSY_TIMEOUT_MS = 5000;

/**
 * Texts per embedding call during a full reindex.
 *
 * Env `TDAI_REINDEX_EMBED_BATCH` overrides it — a provider with a smaller
 * per-request cap needs a smaller number, and a local model gains nothing
 * from a large one. 64 keeps a batch's worth of vectors (64 x dims floats)
 * small enough to hold while the rows are written one transaction at a time.
 */
const REINDEX_EMBED_BATCH_DEFAULT = 64;

function reindexEmbedBatchSize(): number {
  const raw = Number.parseInt(getEnv("TDAI_REINDEX_EMBED_BATCH") ?? "", 10);
  return Number.isInteger(raw) && raw > 0 ? raw : REINDEX_EMBED_BATCH_DEFAULT;
}

/**
 * How often a postponed rebuild is retried, in milliseconds.
 *
 * The retry runs on read paths, so it must be rare enough to cost nothing in
 * the common case and frequent enough that a session repairs itself long
 * before anyone restarts the gateway. Overridable because the right number
 * depends on the install (one gateway or several, how long its rebuild takes)
 * and because a test cannot wait half a minute to see the retry happen.
 */
const FTS_REBUILD_RETRY_DEFAULT_MS = 30_000;

function ftsRebuildRetryIntervalMs(): number {
  const raw = Number.parseInt(getEnv("TDAI_FTS_REBUILD_RETRY_MS") ?? "", 10);
  return Number.isInteger(raw) && raw >= 0 ? raw : FTS_REBUILD_RETRY_DEFAULT_MS;
}

function isSqliteBusy(err: unknown): boolean {
  return err instanceof Error && /SQLITE_BUSY/.test(err.message);
}

/**
 * Retry a synchronous DB call on SQLITE_BUSY. WAL + the busy timeout already
 * retry inside SQLite; this is a belt-and-braces second layer for the long
 * reindex windows where a concurrent capture can hold the write lock.
 */
function runSqliteBusyRetry<T>(fn: () => T, attempts = 3): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (isSqliteBusy(err) && attempt < attempts) continue;
      throw err;
    }
  }
}

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

// Use createRequire to load the SQLite built-in module (node:sqlite or bun:sqlite)
const require = createRequire(import.meta.url);

/**
 * Minimal structural shape of a synchronous SQLite handle that works across both
 * supported runtimes:
 *   - Node.js: built-in `node:sqlite` (DatabaseSync)
 *   - Bun:     built-in `bun:sqlite` (Database)
 *
 * Both expose the same exec/prepare/run/all/get/close methods used by this store.
 * `enableLoadExtension` is Node-only — Bun's Database loads extensions via
 * `loadExtension()` directly, without an enable step.
 */
interface SqliteHandle {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  enableLoadExtension?(enabled: boolean): unknown;
  loadExtension(path: string): unknown;
  close(): unknown;
}

/**
 * Open a SQLite database using whichever built-in module the current runtime
 * provides. Bun loads the sqlite-vec extension via `db.loadExtension()` directly;
 * Node requires `{ allowExtension: true }` at construction plus
 * `db.enableLoadExtension(true)` before loading (see init()).
 */
function openSqliteHandle(path: string): SqliteHandle {
  if ((globalThis as { Bun?: unknown }).Bun !== undefined) {
    const { Database } = require("bun:sqlite");
    return new Database(path) as unknown as SqliteHandle;
  }
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(path, {
    allowExtension: true,
  }) as unknown as SqliteHandle;
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
  "的",
  "了",
  "在",
  "是",
  "我",
  "有",
  "和",
  "就",
  "不",
  "人",
  "都",
  "一",
  "一个",
  "上",
  "也",
  "很",
  "到",
  "说",
  "要",
  "去",
  "你",
  "会",
  "着",
  "没有",
  "看",
  "好",
  "自己",
  "这",
  "他",
  "她",
  "它",
  "们",
  "那",
  "吗",
  "吧",
  "呢",
  "啊",
  "呀",
  "哦",
  "嗯",
]);

/**
 * Runs written without spaces: Han, kana, and the marks that bind them.
 *
 * Kana is INSIDE the run on purpose. Japanese writes kanji and kana in one
 * unbroken string ("日本語のテキストを検索する"), so a Han-only run cuts that
 * sentence into kanji islands and hands each to jieba — a CHINESE segmenter
 * with no Japanese dictionary, which returns them one codepoint at a time
 * ("検索" → "検", "索"). The particles between them survived as one-character
 * tokens, and a phrase nobody wrote ("パンを食べる") matched documents through
 * "を" and "食". Which run goes to which segmenter is decided per run, below.
 *
 * Hangul is NOT here: Korean is written with spaces, so the ordinary word
 * breaker already sees its boundaries.
 */
const CJK_RUN =
  /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u309F\u30A0-\u30FF\u31F0-\u31FF\u30FC\u3005]+/gu;

/** Kana — the mark that a run is Japanese and not Chinese. */
const KANA_CHAR = /[\u3040-\u309F\u30A0-\u30FF\u31F0-\u31FF]/u;

/**
 * Segmentation version the FTS content was written with.
 *
 * v1: raw text. v2: jieba on everything, which broke every non-CJK script.
 * v3: per-script segmentation (`segmentForFts`). v4: Japanese — kana keeps its
 * run out of jieba's hands, lone particles are dropped, and a Han run is read
 * by both segmenters. CHANGING this in either direction makes an existing
 * database drop and rebuild its FTS tables once, on open.
 */
const FTS_SCHEMA_VERSION = 4;
const FTS_SCHEMA_META_KEY = "fts_schema_version";
const FTS_TOKENIZER_META_KEY = "fts_tokenizer";

/**
 * Which segmenters this runtime actually has.
 *
 * The version alone does not describe the index: the same code cuts text
 * differently when jieba is missing, and differently again when the platform
 * has no `Intl.Segmenter` at all and the regex fallback takes over. An index
 * written by one and queried by the other silently answers nothing, so the
 * pair is recorded next to the version and a change orders a rebuild.
 *
 * What it does NOT capture is WHICH dictionaries a present `Intl.Segmenter`
 * carries — a small-ICU build reports `intl` and cuts Japanese differently.
 * Naming that would take probing the breaker on a known phrase; until it does,
 * `intl` means "there is one", not "it knows Japanese".
 */
function currentTokenizerId(): string {
  return `jieba=${getJieba() ? "on" : "off"},words=${WORD_SEGMENTER ? "intl" : "regex"}`;
}

/**
 * Whether a failure is another process holding the write lock.
 *
 * It reads as an ordinary error, but it says nothing about the index: the
 * tables are intact and someone else is already doing the work. Treating it
 * like a broken fts5 build cost this process keyword search for its whole
 * lifetime — two gateways opening the same store at once was enough.
 */
function isDatabaseLocked(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.startsWith("SQLITE_BUSY")) return true;
  const message = err instanceof Error ? err.message.toLowerCase() : "";
  return message.includes("database is locked") || message.includes("busy");
}

/**
 * What an open found the FTS index to be.
 *
 * `unknown` is not `current`: a check that could not run says nothing about
 * the index, and the schema marker must stay unwritten so the next open looks
 * again.
 */
type FtsMigrationCheck = {
  kind: "rebuild-needed" | "current" | "unknown";
  /** Whether the existing tables must go before new ones can be created. */
  dropFirst?: boolean;
  /**
   * Whether the tables themselves are wrong (missing, or of an older shape) —
   * as opposed to merely holding text cut by an older segmentation. Only the
   * first makes the index unusable, so only the first is worth losing FTS for.
   */
  shapeChanged?: boolean;
};

/**
 * Whether the schema marker may be written for what this open did.
 *
 * The marker means "the index was written by this build's segmentation", and
 * only two things earn it: an index already at this version, or a rebuild that
 * finished. A rebuild that failed leaves the tables dropped and empty, and a
 * check that could not run says nothing at all — marking either would retire
 * the repair and freeze a broken index in place.
 */
export function shouldWriteFtsMarker(
  check: FtsMigrationCheck["kind"],
  didRebuild: boolean,
): boolean {
  if (check === "current") return true;
  if (check === "rebuild-needed") return didRebuild;
  return false;
}

/**
 * Split text into index/query tokens, choosing the tokenizer per script.
 *
 * jieba is a CHINESE segmenter. Fed a Russian sentence it returns one token
 * per letter, and both sides of FTS used it on everything: documents were
 * indexed as loose letters and queries became `"п" OR "о" OR "т" …`, so any
 * Cyrillic query matched nearly any Cyrillic document and BM25 ranked noise.
 * The same held for Greek, Hebrew, Armenian — every script jieba has no
 * dictionary for.
 *
 * So the text is cut into CJK and non-CJK runs first. jieba segments the CJK
 * runs (where it is right, and where whitespace carries no word boundaries);
 * everything else is split on Unicode word characters, which is what those
 * scripts actually need.
 */
export type FtsSide = "index" | "query";

export function segmentForFts(raw: string, side: FtsSide = "index"): string[] {
  const jieba = getJieba();
  const tokens: string[] = [];

  let last = 0;
  CJK_RUN.lastIndex = 0;
  for (
    let match = CJK_RUN.exec(raw);
    match !== null;
    match = CJK_RUN.exec(raw)
  ) {
    pushWords(tokens, raw.slice(last, match.index));
    const run = match[0];
    // A run with kana in it is Japanese, and jieba does not know Japanese: the
    // word breaker does. A run of Han alone goes to jieba, where cutForSearch
    // also splits long words further ("北京烤鸭" → 北京, 烤鸭, 北京烤鸭), so the
    // index holds the same sub-words a query will ask for.
    if (jieba && !KANA_CHAR.test(run))
      pushHanRun(tokens, jieba, run, side === "query");
    else pushWords(tokens, run);
    last = match.index + run.length;
  }
  pushWords(tokens, raw.slice(last));

  return tokens
    .map((t) => t.trim())
    .filter(
      (t) =>
        t &&
        /[\p{L}\p{N}]/u.test(t) &&
        !ZH_STOP_WORDS.has(t) &&
        // A lone kana is a Japanese particle ("を", "の"), not a word: as a
        // token it matches nearly every Japanese document, which is the same
        // noise this segmentation exists to end.
        !(t.length === 1 && KANA_CHAR.test(t)),
    );
}

/**
 * Positions of `run` that some multi-character token already covers.
 *
 * Used to tell a word from a spelling-out: a character a longer token of the
 * same reading contains is that reading's way of writing part of a word.
 */
function coveredPositions(run: string, tokens: readonly string[]): Set<number> {
  const covered = new Set<number>();
  for (const token of tokens) {
    if (token.length < 2) continue;
    for (let at = run.indexOf(token); at >= 0; at = run.indexOf(token, at + 1))
      for (let i = 0; i < token.length; i++) covered.add(at + i);
  }
  return covered;
}

/**
 * Append the tokens of a run of Han alone, as BOTH segmenters read it.
 *
 * A run of Han carries no mark of its language, and the two sides of FTS meet
 * it in different company. "情報処理技術" indexed from a Japanese sentence was
 * cut by the word breaker (情報処理 / 技術, because the sentence has kana);
 * typed alone as a query it reaches jieba, which reads it as Chinese and
 * returns 情報 / 処 / 理技術 — a query that cannot find the document it came
 * from. So the run is cut both ways and both answers are kept: jieba's
 * `cutForSearch` also splits long words further ("北京烤鸭" → 北京, 烤鸭,
 * 北京烤鸭), and for Chinese the two readings mostly agree anyway.
 *
 * What is NOT kept is a single character that one of the readings covers with
 * a longer token EVERYWHERE it occurs: that reading is spelling out a word the
 * other one knows ("検索" → 検, 索; "编程" → 编, 程), and as tokens those
 * characters match every unrelated document that happens to use them. A
 * character that stands alone somewhere in the run — 茶 in "茶和茶叶" — is a
 * word of its own and stays, or a query for it would find nothing.
 */
function pushHanRun(
  into: string[],
  jieba: JiebaInstance,
  run: string,
  dropSpelledOut: boolean,
): void {
  const byJieba = [...jieba.cutForSearch(run, true)];
  const byWordBreaker: string[] = [];
  pushWords(byWordBreaker, run);
  const covers = dropSpelledOut
    ? [coveredPositions(run, byJieba), coveredPositions(run, byWordBreaker)]
    : [];

  const seen = new Set<string>();
  for (const token of [...byJieba, ...byWordBreaker]) {
    if (seen.has(token)) continue;
    seen.add(token);
    if (token.length === 1 && isSpelledOut(run, token, covers)) continue;
    into.push(token);
  }

  // The INDEX also keeps every character of the run on its own. A word both
  // segmenters read as whole ("喝茶" — to drink tea) otherwise hides its parts:
  // a search for 茶 found no document that says 喝茶, because neither reading
  // ever emitted 茶. Characters are what a one-character query asks for, and
  // in Han they are morphemes, not letters. The QUERY side does not take them
  // (that is what `dropSpelledOut` decides), so this widens what can be found
  // without widening what is asked for.
  if (dropSpelledOut) return;
  for (const char of run) {
    if (seen.has(char)) continue;
    seen.add(char);
    into.push(char);
  }
}

/** Whether one reading covers this character everywhere it occurs in the run. */
function isSpelledOut(
  run: string,
  token: string,
  covers: readonly Set<number>[],
): boolean {
  if (covers.length === 0) return false;
  const positions: number[] = [];
  for (let at = run.indexOf(token); at >= 0; at = run.indexOf(token, at + 1))
    positions.push(at);
  return covers.some((covered) => positions.every((at) => covered.has(at)));
}

/** Word breaker for everything outside Han, built once. */
const WORD_SEGMENTER =
  typeof Intl?.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "word" })
    : undefined;

/**
 * Append the word tokens of a non-Han run.
 *
 * `Intl.Segmenter` knows the scripts that write no spaces between words — kana
 * above all — and gives the same answer a character-class split gives for the
 * scripts that do. Without it those scripts arrive as one token per run:
 * sound, but findable only by an exact whole-run query.
 */
function pushWords(into: string[], run: string): void {
  if (!run) return;
  if (!WORD_SEGMENTER) {
    into.push(...(run.match(/[\p{L}\p{N}_]+/gu) ?? []));
    return;
  }
  for (const piece of WORD_SEGMENTER.segment(run))
    if (piece.isWordLike) into.push(piece.segment);
}

/**
 * Shortest query token that is allowed to match by prefix.
 *
 * Russian, and every other inflected language here, changes the END of a word:
 * "потребитель" is written "потребителя" in the corpus, and an exact-token
 * query would miss it. FTS5 prefix queries (`"tok"*`) recover that. Below this
 * length a prefix is not a word stem but a letter or two, and `"и"*` would
 * match nearly every document — which is the very failure this schema bump
 * exists to end.
 */
const FTS_PREFIX_MIN_TOKEN_LENGTH = 4;

/**
 * The same floor for Hangul, counted in syllables.
 *
 * A Hangul syllable is a whole cluster of letters, so two of them are already
 * a word ("문서" — document), while two Cyrillic letters are not. Korean is
 * agglutinative and the corpus holds "문서입니다"; without this the stem query
 * a reader would type finds nothing.
 */
const FTS_PREFIX_MIN_HANGUL_SYLLABLES = 2;

/** Hangul syllables — segmented by word breaker, so their tokens are words. */
const HANGUL_CHAR = /[\uAC00-\uD7AF]/u;

/**
 * Written as escapes, not as literal characters: the range this replaced ended
 * up starting at U+8C48 (an ordinary ideograph that looks like the start of
 * the compatibility block) and so swallowed Hangul, which is how Korean lost
 * its prefixes without anyone seeing it in the source.
 *
 * The script a prefix query does not suit: jieba cuts Han to words of one or
 * two characters, where a prefix is half a word rather than a stem. Hangul and
 * kana DO get prefixes — they are segmented by word breaker, not by jieba, and
 * Korean inflects at the end of the word exactly like Russian does.
 */
const HAN_CHAR = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u;

/** Long enough to be a stem rather than a fragment, in this token's script. */
function prefersPrefix(token: string): boolean {
  if (HAN_CHAR.test(token)) return false;
  const floor = HANGUL_CHAR.test(token)
    ? FTS_PREFIX_MIN_HANGUL_SYLLABLES
    : FTS_PREFIX_MIN_TOKEN_LENGTH;
  return token.length >= floor;
}

/**
 * Build the FTS5 MATCH expression for a user query.
 *
 * Tokens are OR-ed, and long enough non-CJK tokens match by prefix so that an
 * inflected form in the corpus is still found. A word nobody wrote still
 * matches nothing: a prefix is a prefix, not a scatter of letters.
 *
 * @returns the MATCH expression, or null when the text holds no word at all.
 */
export function buildFtsQuery(raw: string): string | null {
  // Deduplicate — cutForSearch produces sub-words that repeat.
  const tokens = [...new Set(segmentForFts(raw, "query"))];
  if (tokens.length === 0) return null;
  return tokens
    .map((token) => {
      const quoted = `"${token.replaceAll('"', "")}"`;
      return prefersPrefix(token) ? `${quoted}*` : quoted;
    })
    .join(" OR ");
}

/**
 * Tokenize text for FTS5 indexing (write-side).
 *
 * The SAME segmentation the query side uses (`segmentForFts`), joined with
 * spaces for FTS5's `unicode61` tokenizer to split on — so every token the
 * index holds is a token a query can ask for. There is no fallback to raw
 * text: skipping segmentation when jieba is missing left the index holding
 * whole runs while queries asked for pieces of them, and the search answered
 * nothing without saying so.
 *
 * Example: "人工智能的分支" → "人工 智能 人工智能 分支" (jieba's sub-words,
 * with the stop word dropped); "日本語のテキスト" → "日本語 テキスト" (the
 * word breaker's, because the run carries kana).
 */
export function tokenizeForFts(raw: string): string {
  return segmentForFts(raw, "index").join(" ");
}

/**
 * Reset jieba state so next call to `buildFtsQuery` re-initialises.
 * Exported for testing only.
 * @internal
 */
export function _resetJiebaForTest(): void {
  _jieba = undefined;
}

/**
 * Override jieba instance (or set to `null` to force fallback).
 * Exported for testing only.
 * @internal
 */
export function _setJiebaForTest(instance: JiebaInstance | null): void {
  _jieba = instance;
}

/**
 * Convert a BM25 rank (negative = more relevant) to a 0–1 score.
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

/** FTS5 search result for L1 records. */
export interface FtsSearchResult {
  record_id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  /** BM25-derived score (0–1, higher is better) */
  score: number;
  timestamp_str: string;
  timestamp_start: string;
  timestamp_end: string;
  session_key: string;
  session_id: string;
  metadata_json: string;
  /** Project this memory came from; '' when unknown. */
  project_id?: string;
  /** 'global' | 'project' | '' (legacy records predate scoping). */
  scope?: string;
}

/** FTS5 search result for L0 records. */
export interface L0FtsSearchResult {
  record_id: string;
  session_key: string;
  session_id: string;
  role: string;
  message_text: string;
  /** BM25-derived score (0–1, higher is better) */
  score: number;
  recorded_at: string;
  timestamp: number;
}

// ============================
// VectorStore class
// ============================

export class VectorStore implements IMemoryStore {
  private db: DatabaseSync;
  private readonly dimensions: number;
  private readonly logger?: Logger;

  /** @see IMemoryStore.supportsDeferredEmbedding */
  readonly supportsDeferredEmbedding = true;

  /**
   * When `true`, the store is in a degraded state (e.g. sqlite-vec failed to
   * load, or init() encountered an unrecoverable error).  All public methods
   * become safe no-ops so the plugin never blocks the main OpenClaw flow.
   */
  private degraded = false;

  /**
   * Set when the ONLY thing wrong at open was another process holding the
   * write lock — a backup, a migration, a sibling gateway. That is a passing
   * condition, not a broken install, so it must not cost this process its
   * memory for the rest of its life: `isReindexing()` reports it (read routes
   * answer "rebuilding", never "empty") and retries the open, spaced exactly
   * like the postponed FTS rebuild.
   */
  private initRetryPending = false;
  private lastInitRetry = 0;
  private initProviderInfo?: EmbeddingProviderInfo;

  /** Tracks whether close() has been called to prevent double-close errors. */
  private closed = false;

  /**
   * `true` when vec0 virtual tables (l1_vec / l0_vec) have been created and
   * their prepared statements are ready.  When `dimensions === 0` (i.e.
   * provider="none"), vec0 tables are deferred and this stays `false`.
   */
  private vecTablesReady = false;

  // Prepared statements — L1 (initialized in init())
  private stmtUpsertMeta!: StatementSync;
  private stmtDeleteVec?: StatementSync; // optional — only set when vecTablesReady
  private stmtInsertVec?: StatementSync; // optional — only set when vecTablesReady
  private stmtDeleteMeta!: StatementSync;
  private stmtGetMeta!: StatementSync;
  /** Per-id content+updated_time lookup for incremental per-row reindex (P8). */
  private stmtGetReindexMeta!: StatementSync;
  private stmtSearchVec?: StatementSync; // optional — only set when vecTablesReady
  private stmtQueryBySessionId!: StatementSync;
  private stmtQueryBySessionIdSince!: StatementSync;
  private stmtQueryBySessionKey!: StatementSync;
  private stmtQueryBySessionKeySince!: StatementSync;
  private stmtQueryAll!: StatementSync;
  private stmtQueryAllSince!: StatementSync;

  // Prepared statements — L0 (initialized in init())
  private stmtL0UpsertMeta!: StatementSync;
  private stmtL0DeleteVec?: StatementSync; // optional — only set when vecTablesReady
  private stmtL0InsertVec?: StatementSync; // optional — only set when vecTablesReady
  private stmtL0DeleteMeta!: StatementSync;
  private stmtL0GetMeta!: StatementSync;
  private stmtL0SearchVec?: StatementSync; // optional — only set when vecTablesReady
  /** L0 query for L1 runner: all messages for a session key */
  private stmtL0QueryAll!: StatementSync;
  /** L0 query for L1 runner: messages after a timestamp cursor */
  private stmtL0QueryAfter!: StatementSync;
  /** L1 cursor-based pagination for migration (by PK) */
  private stmtL1QueryMigrationCursor!: StatementSync;
  /** L0 cursor-based pagination for migration (by PK) */
  private stmtL0QueryMigrationCursor!: StatementSync;

  // FTS5 tables availability flag (created best-effort — may be false if fts5 is not compiled in)
  private ftsAvailable = false;

  /**
   * A rebuild this open could not take the lock for.
   *
   * The index is searchable but holds text cut by ANOTHER segmentation, so a
   * query built by this one quietly finds less than is there — which reads
   * exactly like an empty memory. `isReindexing()` reports it, and read
   * routes answer "rebuilding" instead of "nothing found" (ТЗ R2/S4).
   */
  private ftsRebuildPending = false;

  /** When the postponed rebuild was last attempted (0 = never). */
  private lastFtsRebuildAttempt = 0;

  // Prepared statements — FTS5 L1 (initialized in init())
  private stmtL1FtsInsert!: StatementSync;
  private stmtL1FtsDelete!: StatementSync;
  private stmtL1FtsSearch!: StatementSync;

  // Prepared statements — FTS5 L0 (initialized in init())
  private stmtL0FtsInsert!: StatementSync;
  private stmtL0FtsDelete!: StatementSync;
  private stmtL0FtsSearch!: StatementSync;

  /**
   * Create a VectorStore instance.
   *
   * Note: After construction, you MUST call `init()` to load the sqlite-vec
   * extension and create the schema.
   */
  constructor(dbPath: string, dimensions: number, logger?: Logger) {
    this.dimensions = dimensions;
    this.logger = logger;

    // Open database (node:sqlite under Node, bun:sqlite under Bun)
    this.db = openSqliteHandle(dbPath) as unknown as DatabaseSync;

    // Set busy timeout so concurrent processes retry instead of failing with SQLITE_BUSY
    this.db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);

    // Enable WAL mode for better concurrent read performance
    this.db.exec("PRAGMA journal_mode = WAL");

    // Cap page cache at 64 MB
    this.db.exec("PRAGMA cache_size = -65536");

    // Cap memory-mapped I/O at 128 MB to bound RSS growth
    this.db.exec("PRAGMA mmap_size = 134217728");

    // Auto-checkpoint WAL every 1000 pages (~4 MB) to keep WAL file compact
    this.db.exec("PRAGMA wal_autocheckpoint = 1000");
  }

  /**
   * Whether the store is in degraded mode (e.g. sqlite-vec failed to load).
   * When degraded, all write/search operations become safe no-ops.
   */
  isDegraded(): boolean {
    return this.degraded;
  }

  /**
   * Load sqlite-vec extension and initialize database schema.
   * Must be called once after construction.
   *
   * @param providerInfo  Current embedding provider info. When provided,
   *   the store compares it against the persisted metadata. If the provider,
   *   model, or dimensions changed, the vector tables are dropped and
   *   re-created with the new dimensions, and `needsReindex: true` is returned
   *   so the caller can schedule a full re-embed.
   */
  init(providerInfo?: EmbeddingProviderInfo): VectorStoreInitResult {
    this.initProviderInfo = providerInfo;
    // Load sqlite-vec extension (same approach as root project's sqlite-vec.ts)
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sqliteVec = require("sqlite-vec");
      // Node needs enableLoadExtension(true) before loading; Bun loads directly.
      this.db.enableLoadExtension?.(true);
      sqliteVec.load(this.db);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.error(
        `${TAG} Failed to load sqlite-vec extension: ${message}. ` +
          `VectorStore entering degraded mode — all operations will be no-ops.`,
      );
      this.degraded = true;
      return {
        needsReindex: false,
        reason: `sqlite-vec load failed: ${message}`,
      };
    }

    // ── Schema creation & prepared statements ──────────────────────────────
    // Wrapped in try-catch: if anything fails during schema init (e.g. the DB
    // is corrupted, disk full, etc.), we degrade gracefully instead of crashing.
    try {
      return this.initSchema(providerInfo);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.degraded = true;
      // A held write lock is temporary. Degrading is still right for now — the
      // statements are not prepared, so nothing can be served — but the store
      // says so out loud and tries again on the next read instead of serving
      // an empty memory until someone restarts the gateway.
      this.initRetryPending = isDatabaseLocked(err);
      this.logger?.error(
        `${TAG} Schema initialization failed: ${message}. ` +
          (this.initRetryPending
            ? `The database is locked by another process — reads answer "rebuilding" and the open is retried.`
            : `VectorStore entering degraded mode.`),
      );
      return { needsReindex: false, reason: `schema init failed: ${message}` };
    }
  }

  /**
   * Internal schema initialization — separated from init() so we can
   * catch errors at the top level and degrade gracefully.
   */
  private initSchema(
    providerInfo?: EmbeddingProviderInfo,
  ): VectorStoreInitResult {
    // Tracks which provider/model/dimensions were used to generate vectors.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // Detect whether re-index is needed
    let needsReindex = false;
    let reindexReason: string | undefined;

    const savedMeta = this.readEmbeddingMeta();

    if (providerInfo) {
      if (savedMeta) {
        const providerChanged = savedMeta.provider !== providerInfo.provider;
        const modelChanged = savedMeta.model !== providerInfo.model;
        const dimsChanged = savedMeta.dimensions !== this.dimensions;

        if (providerChanged || modelChanged || dimsChanged) {
          const reasons: string[] = [];
          if (providerChanged)
            reasons.push(
              `provider: ${savedMeta.provider} → ${providerInfo.provider}`,
            );
          if (modelChanged)
            reasons.push(`model: ${savedMeta.model} → ${providerInfo.model}`);
          if (dimsChanged)
            reasons.push(
              `dimensions: ${savedMeta.dimensions} → ${this.dimensions}`,
            );
          reindexReason = reasons.join(", ");

          this.logger?.info(
            `${TAG} Embedding config changed (${reindexReason}). ` +
              `Dropping vector tables for rebuild...`,
          );

          // Drop and re-create vector tables with new dimensions
          this.dropVectorTables();
          needsReindex = true;
        }
      } else {
        // No saved meta — first run or legacy DB without meta table.
        // Two cases require dropping vector tables:
        // 1. Existing data created without meta tracking (legacy DB) — need re-embed
        // 2. vec0 tables exist with wrong dimensions (e.g. previously created with
        //    provider="none" placeholder 768D, now switching to a real provider
        //    with different dimensions) — must rebuild even if data tables are empty
        const l1Count = this.tableRowCount("l1_records");
        const l0Count = this.tableRowCount("l0_conversations");
        const existingVecDims = this.getVecTableDimensions();

        if (l1Count > 0 || l0Count > 0) {
          this.logger?.info(
            `${TAG} No embedding_meta found but existing data exists ` +
              `(L1=${l1Count}, L0=${l0Count}). Dropping vector tables for safety...`,
          );
          this.dropVectorTables();
          needsReindex = true;
          reindexReason =
            "legacy DB without embedding_meta — cannot verify vector compatibility";
        } else if (
          existingVecDims !== null &&
          existingVecDims !== this.dimensions
        ) {
          // vec0 tables exist (from a previous provider="none" placeholder or
          // different config) but with mismatched dimensions.  Drop them so they
          // get re-created with the correct dimensions below.
          this.logger?.info(
            `${TAG} vec0 table dimension mismatch (existing=${existingVecDims}, ` +
              `required=${this.dimensions}). Dropping vector tables for rebuild...`,
          );
          this.dropVectorTables();
          // No needsReindex — there's no data to re-embed
        }
      }
    }

    // ── L1 schema ──────────────────────────────────

    // Metadata table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS l1_records (
        record_id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        type TEXT DEFAULT '',
        priority INTEGER DEFAULT 50,
        scene_name TEXT DEFAULT '',
        session_key TEXT DEFAULT '',
        session_id TEXT DEFAULT '',
        timestamp_str TEXT DEFAULT '',
        timestamp_start TEXT DEFAULT '',
        timestamp_end TEXT DEFAULT '',
        created_time TEXT DEFAULT '',
        updated_time TEXT DEFAULT '',
        metadata_json TEXT DEFAULT '{}'
      )
    `);

    // Migration: per-project scoping columns (existing DBs pre-scope).
    // MUST run after CREATE TABLE above (on a fresh DB the table would not exist
    // yet and the try/catch would silently swallow the ALTER) and before any
    // prepare() that reads these columns — otherwise prepare throws on an
    // existing DB and the whole store falls into degraded mode.
    for (const ddl of [
      "ALTER TABLE l1_records ADD COLUMN project_id TEXT DEFAULT ''",
      "ALTER TABLE l1_records ADD COLUMN scope TEXT DEFAULT 'global'",
    ]) {
      try {
        this.db.exec(ddl);
        this.logger?.debug?.(`${TAG} Migrated l1_records: ${ddl}`);
      } catch {
        // Column already exists — expected on non-first run
      }
    }

    // Indexes for common queries
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_type ON l1_records(type)");
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_l1_scope_project ON l1_records(scope, project_id)",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_l1_session_key ON l1_records(session_key)",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_l1_session_id ON l1_records(session_id)",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_l1_scene ON l1_records(scene_name)",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_l1_ts_start ON l1_records(timestamp_start)",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_l1_ts_end ON l1_records(timestamp_end)",
    );
    // Composite index: session_id exact match + updated_time range scan (for incremental L2 queries)
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_l1_session_updated ON l1_records(session_id, updated_time)",
    );
    // Composite index: session_key exact match + updated_time range scan (for pipeline cursor queries)
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_l1_sessionkey_updated ON l1_records(session_key, updated_time)",
    );

    // Vector virtual table (cosine distance) — only created when dimensions > 0.
    // When provider="none", dimensions=0 and vec0 tables are deferred until a
    // real embedding provider is configured.
    if (this.dimensions > 0) {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS l1_vec USING vec0(
          record_id TEXT PRIMARY KEY,
          embedding float[${this.dimensions}] distance_metric=cosine,
          updated_time TEXT DEFAULT ''
        )
      `);
    }

    // Prepare statements for reuse
    this.stmtUpsertMeta = this.db.prepare(`
      INSERT INTO l1_records (
        record_id, content, type, priority, scene_name, session_key, session_id,
        timestamp_str, timestamp_start, timestamp_end,
        created_time, updated_time, metadata_json, project_id, scope
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_id) DO UPDATE SET
        content=excluded.content,
        type=excluded.type,
        priority=excluded.priority,
        scene_name=excluded.scene_name,
        timestamp_str=excluded.timestamp_str,
        timestamp_start=excluded.timestamp_start,
        timestamp_end=excluded.timestamp_end,
        updated_time=excluded.updated_time,
        metadata_json=excluded.metadata_json,
        project_id=excluded.project_id,
        scope=excluded.scope
    `);

    if (this.dimensions > 0) {
      this.stmtDeleteVec = this.db.prepare(
        "DELETE FROM l1_vec WHERE record_id = ?",
      );
      this.stmtInsertVec = this.db.prepare(
        "INSERT INTO l1_vec (record_id, embedding, updated_time) VALUES (?, ?, ?)",
      );
    }
    this.stmtDeleteMeta = this.db.prepare(
      "DELETE FROM l1_records WHERE record_id = ?",
    );

    this.stmtGetMeta = this.db.prepare(`
      SELECT content, type, priority, scene_name, session_key, session_id,
             timestamp_str, timestamp_start, timestamp_end, metadata_json,
             project_id, COALESCE(scope, '') AS scope
      FROM l1_records WHERE record_id = ?
    `);

    // Per-id lookup for incremental per-row reindex (P8) — committed schema
    // only (content + updated_time), so it works on both trees.
    this.stmtGetReindexMeta = this.db.prepare(
      "SELECT content, updated_time FROM l1_records WHERE record_id = ?",
    );

    if (this.dimensions > 0) {
      this.stmtSearchVec = this.db.prepare(`
        SELECT record_id, distance
        FROM l1_vec
        WHERE embedding MATCH ?
          AND k = ?
        ORDER BY distance
      `);
    }

    // ── L0 schema ──────────────────────────────────

    // L0 metadata table: stores individual messages for vector search
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS l0_conversations (
        record_id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        session_id TEXT DEFAULT '',
        role TEXT NOT NULL DEFAULT '',
        message_text TEXT NOT NULL,
        recorded_at TEXT DEFAULT '',
        timestamp INTEGER DEFAULT 0
      )
    `);

    // Migration: add timestamp column if missing (existing DBs pre-v3.x)
    try {
      this.db.exec(
        "ALTER TABLE l0_conversations ADD COLUMN timestamp INTEGER DEFAULT 0",
      );
      this.logger?.debug?.(
        `${TAG} Migrated l0_conversations: added timestamp column`,
      );
    } catch {
      // Column already exists — expected on non-first run
    }

    // Migration: project_id must travel with L0 — L1 extraction is async and by
    // then the originating cwd is long gone.
    try {
      this.db.exec(
        "ALTER TABLE l0_conversations ADD COLUMN project_id TEXT DEFAULT ''",
      );
      this.logger?.debug?.(
        `${TAG} Migrated l0_conversations: added project_id column`,
      );
    } catch {
      // Column already exists — expected on non-first run
    }

    // Indexes for L0 queries
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_l0_session ON l0_conversations(session_key)",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_l0_session_id ON l0_conversations(session_id)",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_l0_recorded ON l0_conversations(recorded_at)",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_l0_timestamp ON l0_conversations(timestamp)",
    );

    // L0 vector virtual table (cosine distance, same dimensions as L1) — deferred when dimensions=0
    if (this.dimensions > 0) {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS l0_vec USING vec0(
          record_id TEXT PRIMARY KEY,
          embedding float[${this.dimensions}] distance_metric=cosine,
          recorded_at TEXT DEFAULT ''
        )
      `);
    }

    // L0 prepared statements
    this.stmtL0UpsertMeta = this.db.prepare(`
      INSERT INTO l0_conversations (
        record_id, session_key, session_id, role, message_text, recorded_at, timestamp, project_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_id) DO UPDATE SET
        message_text=excluded.message_text,
        recorded_at=excluded.recorded_at,
        timestamp=excluded.timestamp,
        project_id=excluded.project_id
    `);

    if (this.dimensions > 0) {
      this.stmtL0DeleteVec = this.db.prepare(
        "DELETE FROM l0_vec WHERE record_id = ?",
      );
      this.stmtL0InsertVec = this.db.prepare(
        "INSERT INTO l0_vec (record_id, embedding, recorded_at) VALUES (?, ?, ?)",
      );
    }
    this.stmtL0DeleteMeta = this.db.prepare(
      "DELETE FROM l0_conversations WHERE record_id = ?",
    );

    this.stmtL0GetMeta = this.db.prepare(`
      SELECT session_key, session_id, role, message_text, recorded_at, timestamp, project_id
      FROM l0_conversations WHERE record_id = ?
    `);

    if (this.dimensions > 0) {
      this.stmtL0SearchVec = this.db.prepare(`
        SELECT record_id, distance
        FROM l0_vec
        WHERE embedding MATCH ?
          AND k = ?
        ORDER BY distance
      `);
    }

    // L0 query statements for L1 runner (newest-first + LIMIT to bound memory)
    // Sort/filter by recorded_at (write time) instead of timestamp (conversation time)
    // because L1 cursor uses recorded_at semantics. ISO 8601 string comparison preserves time order.
    this.stmtL0QueryAll = this.db.prepare(`
      SELECT record_id, session_key, session_id, role, message_text, recorded_at, timestamp, project_id
      FROM l0_conversations
      WHERE session_key = ?
      ORDER BY recorded_at DESC
      LIMIT ?
    `);

    this.stmtL0QueryAfter = this.db.prepare(`
      SELECT record_id, session_key, session_id, role, message_text, recorded_at, timestamp, project_id
      FROM l0_conversations
      WHERE session_key = ? AND recorded_at > ?
      ORDER BY recorded_at DESC
      LIMIT ?
    `);

    this.stmtL0QueryMigrationCursor = this.db.prepare(`
      SELECT record_id, session_key, session_id, role, message_text, recorded_at, timestamp
      FROM l0_conversations
      WHERE record_id > ?
      ORDER BY record_id ASC
      LIMIT ?
    `);

    // ── FTS5 tables (best-effort — gracefully degrade if fts5 is not compiled in) ──
    // Schema v2+: `content` column stores segmented text (for indexing),
    // `content_original` (UNINDEXED) stores the raw text (for display).
    // If old v1 tables exist (no content_original column), drop + recreate.
    try {
      // ── Migrate old FTS5 tables (v1 → v2) ──
      // v1 tables stored raw text in the `content` column. v2 stores segmented
      // text in `content` and raw text in `content_original` / `message_text_original`.
      // FTS5 virtual tables don't support ALTER TABLE ADD COLUMN, so we must
      // drop and recreate. The data will be repopulated by `rebuildFtsIndex()`.
      const migration = this.migrateFtsTablesIfNeeded();
      const didRebuild = this.openFtsTables(migration);
      if (shouldWriteFtsMarker(migration.kind, didRebuild)) {
        this.writeFtsSchemaVersion(FTS_SCHEMA_VERSION);
        this.writeFtsTokenizer();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.ftsAvailable = false;
      this.logger?.warn(
        `${TAG} FTS5 tables NOT available (fts5 may not be compiled in): ${message}. ` +
          `FTS-based keyword search will be unavailable; recall will use in-memory scoring if needed.`,
      );
    }

    // Save current embedding meta (write after schema is ready)
    if (providerInfo) {
      this.writeEmbeddingMeta({
        provider: providerInfo.provider,
        model: providerInfo.model,
        dimensions: this.dimensions,
      });
    }

    // Mark vec0 tables as ready only when they were actually created
    this.vecTablesReady = this.dimensions > 0;
    // L1 query statements (for l1-reader)
    const l1QueryCols = `record_id, content, type, priority, scene_name, session_key, session_id,
      timestamp_str, timestamp_start, timestamp_end,
      created_time, updated_time, metadata_json, project_id,
      COALESCE(scope, '') AS scope`;

    this.stmtQueryBySessionId = this.db.prepare(`
      SELECT ${l1QueryCols} FROM l1_records
      WHERE session_id = ?
      ORDER BY updated_time ASC
    `);

    this.stmtQueryBySessionIdSince = this.db.prepare(`
      SELECT ${l1QueryCols} FROM l1_records
      WHERE session_id = ? AND updated_time > ?
      ORDER BY updated_time ASC
    `);

    this.stmtQueryBySessionKey = this.db.prepare(`
      SELECT ${l1QueryCols} FROM l1_records
      WHERE session_key = ?
      ORDER BY updated_time ASC
    `);

    this.stmtQueryBySessionKeySince = this.db.prepare(`
      SELECT ${l1QueryCols} FROM l1_records
      WHERE session_key = ? AND updated_time > ?
      ORDER BY updated_time ASC
    `);

    this.stmtQueryAll = this.db.prepare(`
      SELECT ${l1QueryCols} FROM l1_records
      ORDER BY updated_time ASC
    `);

    this.stmtQueryAllSince = this.db.prepare(`
      SELECT ${l1QueryCols} FROM l1_records
      WHERE updated_time > ?
      ORDER BY updated_time ASC
    `);

    this.stmtL1QueryMigrationCursor = this.db.prepare(`
      SELECT ${l1QueryCols} FROM l1_records
      WHERE record_id > ?
      ORDER BY record_id ASC
      LIMIT ?
    `);

    this.logger?.debug?.(`${TAG} Initialized (dimensions=${this.dimensions})`);

    return { needsReindex, reason: reindexReason };
  }

  // ── Embedding meta helpers ──────────────────────────────

  /** Version of the segmentation the FTS content was written with. */
  private readFtsSchemaVersion(): number {
    try {
      const row = this.db
        .prepare("SELECT value FROM embedding_meta WHERE key = ?")
        .get(FTS_SCHEMA_META_KEY) as { value: string } | undefined;
      // No marker means the index predates versioning — i.e. v2 content.
      return row ? Number.parseInt(row.value, 10) || 0 : 0;
    } catch {
      return 0;
    }
  }

  /** The tokenizer pair the FTS content was written with, if it was recorded. */
  private readFtsTokenizer(): string {
    try {
      const row = this.db
        .prepare("SELECT value FROM embedding_meta WHERE key = ?")
        .get(FTS_TOKENIZER_META_KEY) as { value?: string } | undefined;
      return row?.value ?? "";
    } catch {
      return "";
    }
  }

  private writeFtsTokenizer(): void {
    try {
      this.db
        .prepare(
          "INSERT INTO embedding_meta (key, value) VALUES (?, ?) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(FTS_TOKENIZER_META_KEY, currentTokenizerId());
    } catch (err) {
      this.logger?.warn(
        `${TAG} could not record the FTS tokenizer (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private writeFtsSchemaVersion(version: number): void {
    try {
      this.db
        .prepare(
          "INSERT INTO embedding_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(FTS_SCHEMA_META_KEY, String(version));
    } catch (err) {
      // Losing the marker only costs one extra rebuild on the next open.
      this.logger?.warn(
        `${TAG} Could not record FTS schema version: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private readEmbeddingMeta(): EmbeddingMeta | null {
    try {
      const row = this.db
        .prepare("SELECT value FROM embedding_meta WHERE key = ?")
        .get("embedding_provider_info") as { value: string } | undefined;
      if (!row) return null;
      return JSON.parse(row.value) as EmbeddingMeta;
    } catch {
      return null;
    }
  }

  private writeEmbeddingMeta(meta: EmbeddingMeta): void {
    this.db
      .prepare(
        "INSERT INTO embedding_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run("embedding_provider_info", JSON.stringify(meta));
  }

  /** Allowed table names for row counting (whitelist to prevent SQL injection). */
  private static readonly COUNTABLE_TABLES = new Set([
    "l1_records",
    "l0_conversations",
  ]);

  /**
   * Extra rows to retrieve from vec0 KNN search to compensate for legacy
   * zero-vector placeholders that may still linger from older data.
   */
  private static readonly ZERO_VEC_BUFFER = 10;

  /** Default result limit for FTS5 keyword searches. */
  private static readonly FTS_DEFAULT_LIMIT = 20;

  private tableRowCount(table: string): number {
    if (!VectorStore.COUNTABLE_TABLES.has(table)) {
      this.logger?.warn(
        `${TAG} tableRowCount: rejected unknown table name "${table}"`,
      );
      return 0;
    }
    try {
      const row = this.db
        .prepare(`SELECT COUNT(*) AS cnt FROM ${table}`)
        .get() as { cnt: number } | undefined;
      return row?.cnt ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Detect the embedding dimension of an existing vec0 table by inspecting
   * the DDL stored in sqlite_master.  Returns `null` if the table doesn't
   * exist or the dimension cannot be determined.
   *
   * The vec0 DDL looks like:
   *   CREATE VIRTUAL TABLE l1_vec USING vec0(... embedding float[768] ...)
   * We parse the number inside `float[N]`.
   */
  private getVecTableDimensions(): number | null {
    try {
      const row = this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
        .get("l1_vec") as { sql: string } | undefined;
      if (!row?.sql) return null;
      const match = row.sql.match(/float\[(\d+)\]/);
      return match ? Number(match[1]) : null;
    } catch {
      return null;
    }
  }

  /**
   * Drop both L1 and L0 vector virtual tables.
   * Metadata tables (l1_records, l0_conversations) are preserved — only
   * the vec0 tables need to be rebuilt with the new dimensions.
   */
  private dropVectorTables(): void {
    this.db.exec("DROP TABLE IF EXISTS l1_vec");
    this.db.exec("DROP TABLE IF EXISTS l0_vec");
    this.logger?.info(`${TAG} Dropped vector tables (l1_vec, l0_vec)`);
  }

  /**
   * Write or update a memory record (metadata + vector).
   * Uses a manual transaction for atomicity.
   *
   * If `embedding` is `undefined` or a zero vector (all elements are 0), only
   * the metadata row is written — the vec0 table is left untouched.  This
   * allows callers without an EmbeddingService to still persist metadata + FTS
   * without constructing a throwaway zero-vector, and prevents placeholder
   * zero vectors (from embedding-service failures) from polluting KNN search
   * results with null / NaN distances.
   *
   * **Fault-tolerant**: catches all errors internally so that a vector store
   * failure never propagates to the caller / main OpenClaw flow.
   * Returns `true` on success, `false` on failure (logged as warning).
   */
  upsertL1(record: MemoryRecord, embedding: Float32Array | undefined): boolean {
    if (this.degraded) {
      this.logger?.warn(
        `${TAG} [L1-upsert] SKIPPED (degraded mode) id=${record.id}`,
      );
      return false;
    }
    try {
      const { id: recordId, timestamps } = record;
      const tsStr = timestamps[0] ?? "";
      const tsStart =
        timestamps.length > 0
          ? timestamps.reduce((a, b) => (a < b ? a : b))
          : tsStr;
      const tsEnd =
        timestamps.length > 0
          ? timestamps.reduce((a, b) => (a > b ? a : b))
          : tsStr;

      const skipVec =
        !embedding ||
        embedding.every((v) => v === 0) ||
        !this.vecTablesReady ||
        reindexInProgress;

      this.logger?.debug?.(
        `${TAG} [L1-upsert] START id=${recordId}, type=${record.type}, ` +
          `content="${record.content.slice(0, 60)}..."` +
          (embedding
            ? `, embeddingDims=${embedding.length}, ` +
              `embeddingNorm=${Math.sqrt(Array.from(embedding).reduce((s, v) => s + v * v, 0)).toFixed(4)}` +
              `${skipVec ? " (ZERO VECTOR or vec tables not ready — vec write will be skipped)" : ""}`
            : " (no embedding — metadata-only write)"),
      );

      this.db.exec("BEGIN");
      try {
        // Upsert metadata (INSERT OR UPDATE)
        this.stmtUpsertMeta.run(
          recordId,
          record.content,
          record.type,
          record.priority,
          record.scene_name,
          record.sessionKey,
          record.sessionId,
          tsStr,
          tsStart,
          tsEnd,
          record.createdAt,
          record.updatedAt,
          JSON.stringify(record.metadata),
          record.projectId ?? "",
          record.scope ?? "global",
        );

        if (!skipVec) {
          // vec0 does not support ON CONFLICT → delete then insert
          this.stmtDeleteVec!.run(recordId);
          this.stmtInsertVec!.run(
            recordId,
            Buffer.from(embedding!.buffer),
            record.updatedAt,
          );
        } else {
          this.logger?.debug?.(
            `${TAG} [L1-upsert] Skipping vec write (${embedding ? "zero vector" : "no embedding"}) id=${recordId}`,
          );
        }

        // Sync FTS5 (delete + re-insert to handle updates)
        if (this.ftsAvailable) {
          try {
            this.stmtL1FtsDelete.run(recordId);
            this.stmtL1FtsInsert.run(
              tokenizeForFts(record.content), // content — segmented for indexing
              record.content, // content_original — raw for display
              recordId,
              record.type,
              record.priority,
              record.scene_name,
              record.sessionKey,
              record.sessionId,
              tsStr,
              tsStart,
              tsEnd,
              JSON.stringify(record.metadata),
            );
          } catch (ftsErr) {
            // FTS write failure is non-fatal — log and continue
            this.logger?.warn(
              `${TAG} [L1-upsert] FTS write failed (non-fatal) id=${recordId}: ${ftsErr instanceof Error ? ftsErr.message : String(ftsErr)}`,
            );
          }
        }

        this.db.exec("COMMIT");
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* ignore rollback errors */
        }
        throw err;
      }
      this.logger?.debug?.(
        `${TAG} [L1-upsert] OK id=${recordId}${skipVec ? " (meta-only)" : ""}`,
      );
      return true;
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L1-upsert] FAILED (non-fatal) id=${record.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Vector similarity search (cosine distance).
   * Returns top-k results sorted by similarity (highest first).
   *
   * **Fault-tolerant**: returns an empty array on any error (e.g. dimension
   * mismatch, corrupted DB) so callers can fall back to keyword search.
   */
  // NOTE: `_queryText` is unused here but MUST keep its slot — the interface
  // declares (emb, topK?, queryText?, projectId?) and callers already pass a
  // query text third. Dropping it would slide projectId into that position and
  // the scope filter would match nothing.
  searchL1Vector(
    queryEmbedding: Float32Array,
    topK = 5,
    _queryText?: string,
    projectId = "",
    mode: ScopeMode = "hidden",
  ): VectorSearchResult[] {
    if (this.degraded || !this.vecTablesReady) {
      if (this.degraded)
        this.logger?.warn(`${TAG} [L1-search] SKIPPED (degraded mode)`);
      return [];
    }
    if (reindexInProgress) {
      // reindex-in-progress gate (ТЗ §5.6): during a full reindex the vec0
      // tables are being repopulated — fail OPEN with an empty result, never
      // an error (/recall, /search/memories, /search/conversations).
      this.logger?.debug?.(
        `${TAG} [L1-search] SKIPPED (reindex-in-progress, fail-open)`,
      );
      return [];
    }
    try {
      // Over-retrieve to compensate for legacy zero-vector placeholders that
      // may still exist in the vec0 table.  New zero vectors are no longer
      // inserted (upsert() skips vec write for zero vectors since v3.x), but
      // older data may still contain them — they surface as NULL/NaN distance
      // in KNN results.  A small buffer of 10 is sufficient for remnants.
      // NOTE: "AND distance IS NOT NULL" is NOT usable because vec0 does not
      // support that constraint — it causes an empty result set.
      // ponytail: scope filtering happens AFTER the vec0 KNN, so a DB heavily
      // skewed towards other projects can under-fill topK. Over-retrieving 3x
      // covers it in practice; upgrade path is a pre-filtered rowid set if this
      // ever measurably starves results.
      const ZERO_VEC_BUFFER = 10;
      const retrieveCount = (projectId ? topK * 3 : topK) + ZERO_VEC_BUFFER;

      this.logger?.debug?.(
        `${TAG} [L1-search] START topK=${topK}, retrieveCount=${retrieveCount}, ` +
          `queryEmbeddingDims=${queryEmbedding.length}, ` +
          `queryNorm=${Math.sqrt(Array.from(queryEmbedding).reduce((s, v) => s + v * v, 0)).toFixed(4)}`,
      );

      const rows = this.stmtSearchVec!.all(
        Buffer.from(queryEmbedding.buffer),
        retrieveCount,
      ) as Array<{ record_id: string; distance: number }>;

      this.logger?.debug?.(
        `${TAG} [L1-search] vec0 returned ${rows.length} candidate(s)`,
      );

      if (rows.length === 0) return [];

      const results: VectorSearchResult[] = [];

      for (const { record_id, distance } of rows) {
        // sqlite-vec returns null distance for zero vectors (cosine undefined when ‖v‖=0).
        // Skip these — they are placeholder vectors from embedding-service-unavailable fallback.
        if (distance == null || Number.isNaN(distance)) {
          this.logger?.warn(
            `${TAG} [L1-search] record_id=${record_id} has null/NaN distance (likely zero vector) — skipping`,
          );
          continue;
        }

        const meta = this.stmtGetMeta.get(record_id) as
          | {
              content: string;
              type: string;
              priority: number;
              scene_name: string;
              session_key: string;
              session_id: string;
              timestamp_str: string;
              timestamp_start: string;
              timestamp_end: string;
              metadata_json: string;
              project_id: string;
              scope: string;
            }
          | undefined;

        if (!meta) {
          this.logger?.warn(
            `${TAG} [L1-search] record_id=${record_id} has vector but NO metadata (orphan)`,
          );
          continue;
        }

        // Same predicate as passesScope() in auto-recall.ts — only records
        // explicitly tagged to a different project are hidden. In `decay`
        // mode the strict project_id equality is skipped; the JS-side
        // scopeDecayMultiplier applies the soft penalty (see search-embedding.ts).
        if (
          mode === "hidden" &&
          projectId &&
          meta.scope === "project" &&
          meta.project_id !== projectId
        )
          continue;
        // strict additionally refuses a record that never said it was global.
        if (
          mode === "strict" &&
          projectId &&
          !(
            meta.scope === "global" ||
            (meta.scope === "project" && meta.project_id === projectId)
          )
        )
          continue;

        const score = 1.0 - distance;
        this.logger?.debug?.(
          `${TAG} [L1-search] HIT id=${record_id}, distance=${distance.toFixed(4)}, score=${score.toFixed(4)}, ` +
            `type=${meta.type}, content="${meta.content.slice(0, 60)}..."`,
        );

        results.push({
          record_id,
          content: meta.content,
          type: meta.type,
          priority: meta.priority,
          scene_name: meta.scene_name,
          score,
          timestamp_str: meta.timestamp_str,
          timestamp_start: meta.timestamp_start,
          timestamp_end: meta.timestamp_end,
          session_key: meta.session_key,
          session_id: meta.session_id,
          metadata_json: meta.metadata_json,
          project_id: meta.project_id ?? "",
          scope: meta.scope ?? "",
        });
      }

      // Trim back to the caller's requested topK (we over-fetched above).
      const trimmed = results.slice(0, topK);
      this.logger?.info(
        `${TAG} [L1-search] DONE returning ${trimmed.length} result(s) (from ${results.length} valid, ${rows.length} raw)`,
      );
      return trimmed;
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L1-search] FAILED (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Delete a single record (metadata + vector).
   *
   * **Fault-tolerant**: logs a warning on failure, never throws.
   */
  deleteL1(recordId: string): boolean {
    if (this.degraded) return false;
    try {
      this.db.exec("BEGIN");
      try {
        this.stmtDeleteMeta.run(recordId);
        if (this.vecTablesReady) this.stmtDeleteVec!.run(recordId);
        if (this.ftsAvailable) {
          try {
            this.stmtL1FtsDelete.run(recordId);
          } catch {
            /* non-fatal */
          }
        }
        this.db.exec("COMMIT");
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* ignore rollback errors */
        }
        throw err;
      }
      return true;
    } catch (err) {
      this.logger?.warn(
        `${TAG} delete failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Delete multiple records (metadata + vector).
   *
   * **Fault-tolerant**: logs a warning on failure, never throws.
   */
  deleteL1Batch(recordIds: string[]): boolean {
    if (this.degraded) return false;
    if (recordIds.length === 0) return true;

    try {
      this.db.exec("BEGIN");
      try {
        for (const id of recordIds) {
          this.stmtDeleteMeta.run(id);
          if (this.vecTablesReady) this.stmtDeleteVec!.run(id);
          if (this.ftsAvailable) {
            try {
              this.stmtL1FtsDelete.run(id);
            } catch {
              /* non-fatal */
            }
          }
        }
        this.db.exec("COMMIT");
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* ignore rollback errors */
        }
        throw err;
      }
      return true;
    } catch (err) {
      this.logger?.warn(
        `${TAG} deleteBatch failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Get the total number of L1 records in the store.
   *
   * **Fault-tolerant**: returns 0 on failure.
   * TTL cleanup by updated_time.
   *
   * Deletes expired rows from l1_records and matching vectors from l1_vec
   * in a single transaction to guarantee consistency.
   */
  deleteL1Expired(cutoffIso: string): number {
    if (this.degraded) {
      this.logger?.warn(`${TAG} [deleteExpired] SKIPPED (degraded mode)`);
      return 0;
    }
    try {
      const row = this.db
        .prepare(
          "SELECT COUNT(*) AS cnt FROM l1_records WHERE updated_time != '' AND updated_time < ?",
        )
        .get(cutoffIso) as { cnt: number } | undefined;
      const expiredCount = row?.cnt ?? 0;
      if (expiredCount <= 0) return 0;

      // Ratio protection: refuse to delete > 80% in one pass
      const totalRow = this.db
        .prepare("SELECT COUNT(*) AS cnt FROM l1_records")
        .get() as { cnt: number };
      const total = totalRow.cnt;
      const ratio = total > 0 ? expiredCount / total : 0;
      if (ratio > 0.8) {
        this.logger?.warn(
          `${TAG} [L1-deleteExpired] BLOCKED: would delete ${expiredCount}/${total} ` +
            `(${(ratio * 100).toFixed(1)}%) — exceeds 80% safety threshold, cutoff=${cutoffIso}`,
        );
        return 0;
      }

      this.db.exec("BEGIN");
      try {
        if (this.vecTablesReady) {
          this.db
            .prepare(
              "DELETE FROM l1_vec WHERE updated_time != '' AND updated_time < ?",
            )
            .run(cutoffIso);
        }
        // Same as L0: the index keeps its own copy of the content. A JOIN on
        // l1_records hides the orphan from THIS query, but the deleted text
        // stays in the index file and any other reader still finds it.
        if (this.ftsAvailable) {
          this.db
            .prepare(
              `DELETE FROM l1_fts WHERE record_id IN (
                 SELECT record_id FROM l1_records
                 WHERE updated_time != '' AND updated_time < ?
               )`,
            )
            .run(cutoffIso);
        }
        this.db
          .prepare(
            "DELETE FROM l1_records WHERE updated_time != '' AND updated_time < ?",
          )
          .run(cutoffIso);
        this.db.exec("COMMIT");
        this.logger?.info?.(
          `${TAG} [L1-deleteExpired] Deleted ${expiredCount}/${total} records (cutoff=${cutoffIso})`,
        );
        return expiredCount;
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* ignore rollback errors */
        }
        throw err;
      }
    } catch (err) {
      this.logger?.warn(
        `${TAG} deleteL1ExpiredByUpdatedTime failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  /**
   * Get the total number of records in the store.
   */
  countL1(): number {
    if (this.degraded) return 0;
    try {
      const row = this.db
        .prepare("SELECT COUNT(*) AS cnt FROM l1_records")
        .get() as { cnt: number };
      this.logger?.debug?.(`${TAG} [L1-count] total=${row.cnt}`);
      return row.cnt;
    } catch (err) {
      this.logger?.warn(
        `${TAG} count failed (non-fatal, returning 0): ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  /**
   * Query L1 records with optional session and time filters.
   *
   * Uses the composite index `idx_l1_session_updated(session_id, updated_time)`
   * for efficient filtering. All timestamps are compared as UTC ISO 8601 strings.
   *
   * **Fault-tolerant**: returns an empty array on any error (degraded mode, DB issues).
   */
  queryL1Records(filter?: L1QueryFilter): L1RecordRow[] {
    if (this.degraded) {
      this.logger?.warn(`${TAG} [L1-query] SKIPPED (degraded mode)`);
      return [];
    }
    try {
      const { sessionKey, sessionId, updatedAfter } = filter ?? {};

      let raw: Record<string, unknown>[];

      // Priority: sessionId > sessionKey (sessionId is more specific)
      if (sessionId && updatedAfter) {
        raw = this.stmtQueryBySessionIdSince.all(
          sessionId,
          updatedAfter,
        ) as Record<string, unknown>[];
      } else if (sessionId) {
        raw = this.stmtQueryBySessionId.all(sessionId) as Record<
          string,
          unknown
        >[];
      } else if (sessionKey && updatedAfter) {
        raw = this.stmtQueryBySessionKeySince.all(
          sessionKey,
          updatedAfter,
        ) as Record<string, unknown>[];
      } else if (sessionKey) {
        raw = this.stmtQueryBySessionKey.all(sessionKey) as Record<
          string,
          unknown
        >[];
      } else if (updatedAfter) {
        raw = this.stmtQueryAllSince.all(updatedAfter) as Record<
          string,
          unknown
        >[];
      } else {
        raw = this.stmtQueryAll.all() as Record<string, unknown>[];
      }

      // Runtime sanity check: verify first row has expected columns (guards against schema drift)
      if (raw.length > 0 && !("record_id" in raw[0] && "content" in raw[0])) {
        this.logger?.warn(
          `${TAG} [L1-query] Schema mismatch: first row missing expected columns. ` +
            `Got keys: [${Object.keys(raw[0]).join(", ")}]`,
        );
        return [];
      }

      const rows = raw as unknown as L1RecordRow[];

      this.logger?.info(
        `${TAG} [L1-query] filter={sessionKey=${sessionKey ?? "(all)"}, sessionId=${sessionId ?? "(all)"}, updatedAfter=${updatedAfter ?? "(none)"}}, ` +
          `returned ${rows.length} record(s)`,
      );
      return rows;
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L1-query] FAILED (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  // ── L0 operations ──────────────────────────────────

  /**
   * Write or update an L0 single-message record (metadata + vector).
   * Uses a manual transaction for atomicity.
   *
   * If `embedding` is `undefined` or a zero vector (all elements are 0), only
   * the metadata row (`l0_conversations`) is written — the vec0 table
   * (`l0_vec`) is left untouched.  This allows callers without an
   * EmbeddingService to still persist metadata + FTS without constructing a
   * throwaway zero-vector, and prevents placeholder zero vectors (from
   * embedding-service failures) from polluting KNN search results.
   *
   * **Fault-tolerant**: catches all errors internally, never throws.
   * Returns `true` on success, `false` on failure (logged as warning).
   */
  upsertL0(record: L0Record, embedding: Float32Array | undefined): boolean {
    if (this.degraded) {
      this.logger?.warn(
        `${TAG} [L0-upsert] SKIPPED (degraded mode) id=${record.id}`,
      );
      return false;
    }
    try {
      const skipVec =
        !embedding ||
        embedding.every((v) => v === 0) ||
        !this.vecTablesReady ||
        reindexInProgress;

      this.logger?.debug?.(
        `${TAG} [L0-upsert] START id=${record.id}, session=${record.sessionKey}, role=${record.role}, ` +
          `text="${record.messageText.slice(0, 60)}..."` +
          (embedding
            ? `, embeddingDims=${embedding.length}, ` +
              `embeddingNorm=${Math.sqrt(Array.from(embedding).reduce((s, v) => s + v * v, 0)).toFixed(4)}` +
              `${skipVec ? " (ZERO VECTOR or vec tables not ready or reindex-in-progress — vec write will be skipped)" : ""}`
            : " (no embedding — metadata-only write)"),
      );

      this.db.exec("BEGIN");
      try {
        this.stmtL0UpsertMeta.run(
          record.id,
          record.sessionKey,
          record.sessionId,
          record.role,
          record.messageText,
          record.recordedAt,
          record.timestamp,
          record.projectId ?? "",
        );

        if (!skipVec) {
          // vec0 does not support ON CONFLICT → delete then insert
          this.stmtL0DeleteVec!.run(record.id);
          this.stmtL0InsertVec!.run(
            record.id,
            Buffer.from(embedding!.buffer),
            record.recordedAt,
          );
        } else {
          this.logger?.debug?.(
            `${TAG} [L0-upsert] Skipping vec write (${embedding ? "zero vector" : "no embedding"}) id=${record.id}`,
          );
        }

        // Sync FTS5 (delete + re-insert to handle updates)
        if (this.ftsAvailable) {
          try {
            this.stmtL0FtsDelete.run(record.id);
            this.stmtL0FtsInsert.run(
              tokenizeForFts(record.messageText), // message_text — segmented for indexing
              record.messageText, // message_text_original — raw for display
              record.id,
              record.sessionKey,
              record.sessionId,
              record.role,
              record.recordedAt,
              record.timestamp,
            );
          } catch (ftsErr) {
            // FTS write failure is non-fatal — log and continue
            this.logger?.warn(
              `${TAG} [L0-upsert] FTS write failed (non-fatal) id=${record.id}: ${ftsErr instanceof Error ? ftsErr.message : String(ftsErr)}`,
            );
          }
        }

        this.db.exec("COMMIT");
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* ignore rollback errors */
        }
        throw err;
      }
      this.logger?.debug?.(
        `${TAG} [L0-upsert] OK id=${record.id}${skipVec ? " (meta-only)" : ""}`,
      );
      return true;
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L0-upsert] FAILED (non-fatal) id=${record.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Update ONLY the vector embedding for an existing L0 record.
   * The metadata row must already exist in l0_conversations (written by upsertL0).
   *
   * This is used by the background embedding task in auto-capture:
   *   1. upsertL0() writes metadata + FTS synchronously (no embedding)
   *   2. Background task calls embedBatch() then updateL0Embedding() for each record
   *
   * **Fault-tolerant**: catches all errors internally, never throws.
   * Returns `true` on success, `false` on failure.
   */
  updateL0Embedding(recordId: string, embedding: Float32Array): boolean {
    if (this.degraded || !this.vecTablesReady) {
      return false;
    }
    if (reindexInProgress) {
      // skip-dual-write policy (ТЗ §5.6): L0 vector rows are NOT written into
      // the vec0 table while a full reindex is repopulating it — the post-reindex
      // count reconciliation backfills the delta per-row (reindexL0Records).
      this.logger?.debug?.(
        `${TAG} [L0-update-embedding] SKIPPED (reindex-in-progress) for ${recordId}`,
      );
      return false;
    }
    if (!embedding || embedding.every((v) => v === 0)) {
      this.logger?.debug?.(
        `${TAG} [L0-update-embedding] Skipping zero vector for ${recordId}`,
      );
      return false;
    }
    try {
      // Look up recorded_at from metadata for the vec0 row
      const meta = this.stmtL0GetMeta.get(recordId) as
        { recorded_at: string } | undefined;
      if (!meta) {
        this.logger?.warn(
          `${TAG} [L0-update-embedding] No metadata found for ${recordId}, skipping`,
        );
        return false;
      }

      this.db.exec("BEGIN");
      try {
        this.stmtL0DeleteVec!.run(recordId);
        this.stmtL0InsertVec!.run(
          recordId,
          Buffer.from(embedding.buffer),
          meta.recorded_at,
        );
        this.db.exec("COMMIT");
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* ignore */
        }
        throw err;
      }
      return true;
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L0-update-embedding] FAILED (non-fatal) id=${recordId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Vector similarity search on L0 individual messages (cosine distance).
   * Returns top-k results sorted by similarity (highest first).
   *
   * **Fault-tolerant**: returns an empty array on any error.
   */
  searchL0Vector(
    queryEmbedding: Float32Array,
    topK = 5,
  ): L0VectorSearchResult[] {
    if (this.degraded || !this.vecTablesReady) {
      if (this.degraded)
        this.logger?.warn(`${TAG} [L0-search] SKIPPED (degraded mode)`);
      return [];
    }
    if (reindexInProgress) {
      // reindex-in-progress gate (ТЗ §5.6): fail open with an empty result.
      this.logger?.debug?.(
        `${TAG} [L0-search] SKIPPED (reindex-in-progress, fail-open)`,
      );
      return [];
    }
    try {
      // Over-retrieve to compensate for legacy zero-vector placeholders that
      // may still exist in the vec0 table.  New zero vectors are no longer
      // inserted (upsertL0() skips vec write for zero vectors since v3.x), but
      // older data may still contain them — they surface as NULL/NaN distance
      // in KNN results.
      // NOTE: "AND distance IS NOT NULL" is NOT usable because vec0 does not
      // support that constraint — it causes an empty result set.
      const retrieveCount = topK + VectorStore.ZERO_VEC_BUFFER;

      this.logger?.debug?.(
        `${TAG} [L0-search] START topK=${topK}, retrieveCount=${retrieveCount}, ` +
          `queryEmbeddingDims=${queryEmbedding.length}, ` +
          `queryNorm=${Math.sqrt(Array.from(queryEmbedding).reduce((s, v) => s + v * v, 0)).toFixed(4)}`,
      );

      const rows = this.stmtL0SearchVec!.all(
        Buffer.from(queryEmbedding.buffer),
        retrieveCount,
      ) as Array<{ record_id: string; distance: number }>;

      this.logger?.debug?.(
        `${TAG} [L0-search] vec0 returned ${rows.length} candidate(s)`,
      );

      if (rows.length === 0) return [];

      const results: L0VectorSearchResult[] = [];

      for (const { record_id, distance } of rows) {
        // sqlite-vec returns null distance for zero vectors (cosine undefined when ‖v‖=0).
        // Skip these — they are placeholder vectors from embedding-service-unavailable fallback.
        if (distance == null || Number.isNaN(distance)) {
          this.logger?.warn(
            `${TAG} [L0-search] record_id=${record_id} has null/NaN distance (likely zero vector) — skipping`,
          );
          continue;
        }

        const meta = this.stmtL0GetMeta.get(record_id) as
          | {
              session_key: string;
              session_id: string;
              role: string;
              message_text: string;
              recorded_at: string;
              timestamp: number;
            }
          | undefined;

        if (!meta) {
          this.logger?.warn(
            `${TAG} [L0-search] record_id=${record_id} has vector but NO metadata (orphan)`,
          );
          continue;
        }

        const score = 1.0 - distance;
        this.logger?.debug?.(
          `${TAG} [L0-search] HIT id=${record_id}, distance=${distance.toFixed(4)}, score=${score.toFixed(4)}, ` +
            `role=${meta.role}, session=${meta.session_key}, text="${meta.message_text.slice(0, 60)}..."`,
        );

        results.push({
          record_id,
          session_key: meta.session_key,
          session_id: meta.session_id,
          role: meta.role,
          message_text: meta.message_text,
          score,
          recorded_at: meta.recorded_at,
          timestamp: meta.timestamp ?? 0,
        });
      }

      // Trim back to the caller's requested topK (we over-fetched above).
      const trimmed = results.slice(0, topK);
      this.logger?.info(
        `${TAG} [L0-search] DONE returning ${trimmed.length} result(s) (from ${results.length} valid, ${rows.length} raw)`,
      );
      return trimmed;
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L0-search] FAILED (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Delete a single L0 record (metadata + vector).
   *
   * **Fault-tolerant**: logs a warning on failure, never throws.
   */
  deleteL0(recordId: string): boolean {
    if (this.degraded) return false;
    try {
      this.db.exec("BEGIN");
      try {
        this.stmtL0DeleteMeta.run(recordId);
        if (this.vecTablesReady) this.stmtL0DeleteVec!.run(recordId);
        if (this.ftsAvailable) {
          try {
            this.stmtL0FtsDelete.run(recordId);
          } catch {
            /* non-fatal */
          }
        }
        this.db.exec("COMMIT");
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* ignore rollback errors */
        }
        throw err;
      }
      return true;
    } catch (err) {
      this.logger?.warn(
        `${TAG} deleteL0 failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * TTL cleanup by recorded_at (ISO string) for L0 records.
   *
   * Deletes expired rows from l0_conversations with their vectors (l0_vec) and
   * their index rows (l0_fts) in a single transaction: a record that survives
   * in the index is still searchable, so leaving one there would mean TTL
   * deleted the record but not the text.
   */
  deleteL0Expired(cutoffIso: string): number {
    if (this.degraded) {
      this.logger?.warn(`${TAG} [deleteExpiredL0] SKIPPED (degraded mode)`);
      return 0;
    }

    try {
      const row = this.db
        .prepare(
          "SELECT COUNT(*) AS cnt FROM l0_conversations WHERE recorded_at != '' AND recorded_at < ?",
        )
        .get(cutoffIso) as { cnt: number } | undefined;
      const expiredCount = row?.cnt ?? 0;
      if (expiredCount <= 0) return 0;

      // Ratio protection: refuse to delete > 80% in one pass
      const totalRow = this.db
        .prepare("SELECT COUNT(*) AS cnt FROM l0_conversations")
        .get() as { cnt: number };
      const total = totalRow.cnt;
      const ratio = total > 0 ? expiredCount / total : 0;
      if (ratio > 0.8) {
        this.logger?.warn(
          `${TAG} [L0-deleteExpired] BLOCKED: would delete ${expiredCount}/${total} ` +
            `(${(ratio * 100).toFixed(1)}%) — exceeds 80% safety threshold, cutoff=${cutoffIso}`,
        );
        return 0;
      }

      this.db.exec("BEGIN");
      try {
        if (this.vecTablesReady) {
          this.db
            .prepare(
              "DELETE FROM l0_vec WHERE recorded_at != '' AND recorded_at < ?",
            )
            .run(cutoffIso);
        }
        // The FTS row holds a copy of the message text, so a record deleted
        // here but left in the index is still findable — search would answer
        // with text the store no longer has, and TTL would not be a deletion.
        if (this.ftsAvailable) {
          this.db
            .prepare(
              `DELETE FROM l0_fts WHERE record_id IN (
                 SELECT record_id FROM l0_conversations
                 WHERE recorded_at != '' AND recorded_at < ?
               )`,
            )
            .run(cutoffIso);
        }
        this.db
          .prepare(
            "DELETE FROM l0_conversations WHERE recorded_at != '' AND recorded_at < ?",
          )
          .run(cutoffIso);
        this.db.exec("COMMIT");
        this.logger?.info?.(
          `${TAG} [L0-deleteExpired] Deleted ${expiredCount}/${total} records (cutoff=${cutoffIso})`,
        );
        return expiredCount;
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* ignore rollback errors */
        }
        throw err;
      }
    } catch (err) {
      this.logger?.warn(
        `${TAG} deleteL0ExpiredByRecordedAt failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  /**
   * Get the total number of L0 message records in the store.
   *
   * **Fault-tolerant**: returns 0 on failure.
   */
  countL0(): number {
    if (this.degraded) return 0;
    try {
      const row = this.db
        .prepare("SELECT COUNT(*) AS cnt FROM l0_conversations")
        .get() as { cnt: number };
      this.logger?.debug?.(`${TAG} [L0-count] total=${row.cnt}`);
      return row.cnt;
    } catch (err) {
      this.logger?.warn(
        `${TAG} countL0 failed (non-fatal, returning 0): ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  // ── Re-index operations ──────────────────────────────────

  /**
   * vec-vs-meta consistency snapshot (wave tdai-memory-subagents-2026-08-02,
   * P4 apply-executor post-apply count check).
   *
   * Both COUNTs and the id sets are read inside ONE transaction so the caller
   * sees a single WAL snapshot — a non-transactional COUNT raced against a
   * concurrent L1 dual-write produces a spurious mismatch (ТЗ §5.5/§5.6).
   *
   * Fault-tolerant: on degraded store or any DB failure returns
   * `{ metaCount: 0, vecCount: null, orphanIds: [] }` — the caller must treat
   * `vecCount === null` as "check not possible", NOT as a mismatch.
   */
  consistencyCheck(): {
    metaCount: number;
    vecCount: number | null;
    orphanIds: string[];
    /** meta∖vec — per-row backfill targets (P8 livelock-cap delta). */
    missingIds: string[];
    /** l0_vec logical rows (null when vec0 absent). */
    l0VecCount: number | null;
    /** l0_conversations∖l0_vec — L0 backfill targets (P8 window-skip heal). */
    l0MissingIds: string[];
  } {
    if (this.degraded)
      return {
        metaCount: 0,
        vecCount: null,
        orphanIds: [],
        missingIds: [],
        l0VecCount: null,
        l0MissingIds: [],
      };
    try {
      this.db.exec("BEGIN");
      try {
        const metaCount =
          (
            this.db.prepare("SELECT COUNT(*) AS c FROM l1_records").get() as {
              c: number;
            } | null
          )?.c ?? 0;

        let vecCount: number | null = null;
        const vecIds = new Set<string>();
        if (this.vecTablesReady) {
          const rows = this.db
            .prepare("SELECT record_id FROM l1_vec")
            .all() as Array<{ record_id: string }>;
          for (const row of rows) vecIds.add(row.record_id);
          vecCount = vecIds.size;
        }

        const metaRows = this.db
          .prepare("SELECT record_id FROM l1_records")
          .all() as Array<{ record_id: string }>;
        const metaIds = new Set<string>();
        for (const row of metaRows) metaIds.add(row.record_id);

        const orphanIds: string[] = [];
        const missingIds: string[] = [];
        for (const id of vecIds) {
          if (!metaIds.has(id)) orphanIds.push(id);
        }
        for (const id of metaIds) {
          if (!vecIds.has(id)) missingIds.push(id);
        }

        // L0 side (window-skip heal): l0_vec logical rows via the shadow table
        // (queryable without the extension) vs l0_conversations meta.
        let l0VecCount: number | null = null;
        const l0VecIds = new Set<string>();
        if (this.vecTablesReady) {
          const l0VecRows = this.db
            .prepare("SELECT record_id FROM l0_vec")
            .all() as Array<{ record_id: string }>;
          for (const row of l0VecRows) l0VecIds.add(row.record_id);
          l0VecCount = l0VecIds.size;
        }
        const l0MetaRows = this.db
          .prepare("SELECT record_id FROM l0_conversations")
          .all() as Array<{ record_id: string }>;
        const l0MetaIds = new Set<string>();
        for (const row of l0MetaRows) l0MetaIds.add(row.record_id);
        const l0MissingIds: string[] = [];
        for (const id of l0MetaIds) {
          if (!l0VecIds.has(id)) l0MissingIds.push(id);
        }

        this.db.exec("COMMIT");
        return {
          metaCount,
          vecCount,
          orphanIds,
          missingIds,
          l0VecCount,
          l0MissingIds,
        };
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* ignore rollback errors */
        }
        throw err;
      }
    } catch (err) {
      this.logger?.warn(
        `${TAG} consistencyCheck failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        metaCount: 0,
        vecCount: null,
        orphanIds: [],
        missingIds: [],
        l0VecCount: null,
        l0MissingIds: [],
      };
    }
  }

  /**
   * Delete stray l1_vec rows (record_id has no l1_records row) via the
   * prepared per-id stmtDeleteVec in a single transaction (ТЗ §5.5 orphan
   * purge — in-process reindexAll cannot remove orphans, sqlite.ts:1914).
   *
   * Fault-tolerant: no-op true when the list is empty or vec tables are
   * absent; false (with a warn) when the transaction fails.
   */
  purgeOrphanVectors(orphanIds: string[]): boolean {
    if (this.degraded || !this.vecTablesReady || orphanIds.length === 0)
      return true;
    try {
      this.db.exec("BEGIN");
      try {
        for (const id of orphanIds) {
          this.stmtDeleteVec!.run(id);
        }
        this.db.exec("COMMIT");
        this.logger?.info?.(
          `${TAG} Purged ${orphanIds.length} orphan l1_vec row(s)`,
        );
        return true;
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* ignore rollback errors */
        }
        throw err;
      }
    } catch (err) {
      this.logger?.warn(
        `${TAG} purgeOrphanVectors failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Get all L1 record texts for re-embedding.
   * Returns record_id → content pairs.
   */
  getAllL1Texts(): Array<{
    record_id: string;
    content: string;
    updated_time: string;
  }> {
    if (this.degraded) return [];
    try {
      return this.db
        .prepare("SELECT record_id, content, updated_time FROM l1_records")
        .all() as Array<{
        record_id: string;
        content: string;
        updated_time: string;
      }>;
    } catch (err) {
      this.logger?.warn(
        `${TAG} getAllL1Texts failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Get all L0 message texts for re-embedding.
   * Returns record_id → message_text/recorded_at tuples.
   */
  getAllL0Texts(): Array<{
    record_id: string;
    message_text: string;
    recorded_at: string;
  }> {
    if (this.degraded) return [];
    try {
      return this.db
        .prepare(
          "SELECT record_id, message_text, recorded_at FROM l0_conversations",
        )
        .all() as Array<{
        record_id: string;
        message_text: string;
        recorded_at: string;
      }>;
    } catch (err) {
      this.logger?.warn(
        `${TAG} getAllL0Texts failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Re-embed all existing L1 and L0 texts with a new embedding function.
   *
   * This is called after `init()` returns `needsReindex: true` — the vector
   * tables have already been dropped and re-created with the correct dimensions.
   * This method reads every text from the metadata tables and writes fresh
   * embeddings into the new vector tables.
   *
   * @param embedFn  A function that converts text → Float32Array embedding.
   * @param onProgress  Optional callback for progress reporting.
   */
  /**
   * True while the index is not one this build can be trusted to query.
   *
   * That is a full reindexAll in flight (the ТЗ §5.6 gate), or a segmentation
   * rebuild a lock postponed at open. In both cases read routes answer
   * "rebuilding" rather than an empty result: a session told "memory holds
   * nothing" writes down what it already knows, and that is how duplicates
   * are born (ТЗ R2/S4).
   *
   * Not a pure read: a postponed rebuild is retried here, so the FIRST search
   * after the other process lets go of the lock repairs the index instead of
   * waiting for the next start.
   */
  isReindexing(): boolean {
    if (reindexInProgress) return true;
    if (this.initRetryPending) return !this.tryPostponedInit();
    if (!this.ftsRebuildPending) return false;
    return !this.tryPostponedFtsRebuild();
  }

  /**
   * One cheap attempt at the open a lock refused.
   *
   * Probed with `PRAGMA busy_timeout = 0` and spaced by the same interval as
   * the postponed rebuild, for the same reason: this runs on read paths, and
   * waiting out the busy timeout there would stall every search.
   *
   * @returns whether the store is usable again.
   */
  private tryPostponedInit(): boolean {
    const now = Date.now();
    if (now - this.lastInitRetry < ftsRebuildRetryIntervalMs()) return false;
    this.lastInitRetry = now;

    try {
      this.db.exec("PRAGMA busy_timeout = 0");
      this.initSchema(this.initProviderInfo);
    } catch (err) {
      this.logger?.debug?.(
        `${TAG} store open still refused: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    } finally {
      this.db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    }
    this.degraded = false;
    this.initRetryPending = false;
    this.logger?.info(
      `${TAG} store open that was postponed by a lock has completed`,
    );
    return true;
  }

  /**
   * One cheap attempt at the rebuild a lock postponed.
   *
   * Cheap on purpose: this runs on read paths (`/memory/search`, `/recall`,
   * `/status`), and with the ordinary busy timeout every one of them would
   * park FIVE SECONDS just to find out that the other process is still
   * writing — a polling dashboard would serialise those stalls. So the lock is
   * PROBED (timeout 0) and, when it is held, not probed again for a while.
   *
   * @returns whether the index is now this build's own.
   */
  private tryPostponedFtsRebuild(): boolean {
    const now = Date.now();
    if (now - this.lastFtsRebuildAttempt < ftsRebuildRetryIntervalMs())
      return false;
    this.lastFtsRebuildAttempt = now;

    let rebuilt = false;
    try {
      this.db.exec("PRAGMA busy_timeout = 0");
      rebuilt = this.rebuildFtsIndex();
    } finally {
      this.db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    }
    if (!rebuilt) return false;

    this.writeFtsSchemaVersion(FTS_SCHEMA_VERSION);
    this.writeFtsTokenizer();
    this.ftsRebuildPending = false;
    this.logger?.info(
      `${TAG} FTS5 rebuild that was postponed by a lock has completed`,
    );
    return true;
  }

  async reindexAll(
    embedFn: (text: string) => Promise<Float32Array>,
    onProgress?: (done: number, total: number, layer: "L1" | "L0") => void,
    embedBatchFn?: (texts: string[]) => Promise<Float32Array[]>,
  ): Promise<{ l1Count: number; l0Count: number }> {
    if (this.degraded || !this.vecTablesReady) {
      if (this.degraded)
        this.logger?.warn(
          `${TAG} reindexAll skipped: VectorStore is in degraded mode`,
        );
      return { l1Count: 0, l0Count: 0 };
    }

    // Single-flight + reindex-in-progress flag (ТЗ §5.6): concurrent reindexAll
    // calls serialize; during the run vector dual-writes are skipped and vector
    // reads fail open. reindexAllInner writes via direct stmts (not upsertL1),
    // so the flag never skips the reindex's own rows.
    return withReindexSingleFlight(async () => {
      reindexInProgress = true;
      try {
        return await this.reindexAllInner(embedFn, onProgress, embedBatchFn);
      } finally {
        reindexInProgress = false;
      }
    });
  }

  private async reindexAllInner(
    embedFn: (text: string) => Promise<Float32Array>,
    onProgress?: (done: number, total: number, layer: "L1" | "L0") => void,
    embedBatchFn?: (texts: string[]) => Promise<Float32Array[]>,
  ): Promise<{ l1Count: number; l0Count: number }> {
    const embedMany =
      embedBatchFn ??
      // No batch call offered: one text per request, as before.
      (async (texts: string[]) => {
        const out: Float32Array[] = [];
        for (const text of texts) out.push(await embedFn(text));
        return out;
      });
    try {
      const l1Rows = this.getAllL1Texts();
      const l1Done = await this.reindexLayer({
        rows: l1Rows,
        layer: "L1",
        textOf: (row) => row.content,
        writeVec: (row, embedding) => {
          this.stmtDeleteVec!.run(row.record_id);
          this.stmtInsertVec!.run(
            row.record_id,
            Buffer.from(embedding.buffer),
            row.updated_time,
          );
        },
        embedMany,
        onProgress,
      });

      const l0Rows = this.getAllL0Texts();
      const l0Done = await this.reindexLayer({
        rows: l0Rows,
        layer: "L0",
        textOf: (row) => row.message_text,
        writeVec: (row, embedding) => {
          this.stmtL0DeleteVec!.run(row.record_id);
          this.stmtL0InsertVec!.run(
            row.record_id,
            Buffer.from(embedding.buffer),
            row.recorded_at,
          );
        },
        embedMany,
        onProgress,
      });

      this.logger?.info(
        `${TAG} Reindex complete: L1=${l1Done}/${l1Rows.length}, L0=${l0Done}/${l0Rows.length}`,
      );

      return { l1Count: l1Done, l0Count: l0Done };
    } catch (err) {
      this.logger?.error(
        `${TAG} reindexAll failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return { l1Count: 0, l0Count: 0 };
    }
  }

  /**
   * Re-embed one layer, `REINDEX_EMBED_BATCH` texts per embedding call.
   *
   * The batch is what makes a remote provider usable at all: measured against
   * nvidia/nemotron-3-embed-1b, one text per request runs at ~3 texts/s while
   * 256 texts per request runs at ~35 — the difference between hours and
   * minutes on a memory this size. Each vector is still written in its own
   * transaction, so a failure costs the rows it touched and nothing else.
   *
   * Fault-tolerant per batch and per row: a failed embedding call skips its
   * batch with a warning, exactly as a failed single embed did before.
   */
  private async reindexLayer<T extends { record_id: string }>(params: {
    rows: T[];
    layer: "L1" | "L0";
    textOf: (row: T) => string;
    writeVec: (row: T, embedding: Float32Array) => void;
    embedMany: (texts: string[]) => Promise<Float32Array[]>;
    onProgress?: (done: number, total: number, layer: "L1" | "L0") => void;
  }): Promise<number> {
    const { rows, layer, textOf, writeVec, embedMany, onProgress } = params;
    const batchSize = reindexEmbedBatchSize();
    let done = 0;
    for (let from = 0; from < rows.length; from += batchSize) {
      const batch = rows.slice(from, from + batchSize);
      let embeddings: Float32Array[] = [];
      try {
        embeddings = await embedMany(batch.map(textOf));
      } catch (err) {
        this.logger?.warn?.(
          `${TAG} reindex ${layer} skip ${batch.length} rows from ${batch[0]?.record_id}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        done += batch.length;
        onProgress?.(done, rows.length, layer);
        continue;
      }
      for (let i = 0; i < batch.length; i++) {
        const row = batch[i];
        try {
          // Wrap delete+insert in a transaction to prevent orphan vectors
          this.db.exec("BEGIN");
          try {
            writeVec(row, embeddings[i]);
            this.db.exec("COMMIT");
          } catch (txErr) {
            try {
              this.db.exec("ROLLBACK");
            } catch {
              /* ignore */
            }
            throw txErr;
          }
        } catch (err) {
          this.logger?.warn?.(
            `${TAG} reindex ${layer} skip ${row.record_id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        done++;
        onProgress?.(done, rows.length, layer);
      }
    }
    return done;
  }

  /**
   * Incremental per-row L1 reindex (ТЗ §5.6): for each record_id, per-row
   * `l1_vec` delete+insert (NOT a SQL UPDATE — vec0 has no UPDATE support) via
   * the prepared stmtDeleteVec/stmtInsertVec, each in its own transaction with
   * SQLITE_BUSY retry. Used for: backfill of the count-mismatch delta after the
   * livelock cap, and content-rewrite re-embedding of specific records.
   *
   * Fault-tolerant per row (log + continue) — same posture as reindexAll.
   */
  async reindexL1Records(
    ids: string[],
    embedFn: (text: string) => Promise<Float32Array>,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ done: number; total: number }> {
    if (this.degraded || !this.vecTablesReady || ids.length === 0) {
      return { done: 0, total: ids.length };
    }
    let done = 0;
    for (const id of ids) {
      try {
        const row = this.stmtGetReindexMeta.get(id) as
          { content: string; updated_time: string } | undefined;
        if (row) {
          const embedding = await embedFn(row.content);
          runSqliteBusyRetry(() => {
            this.db.exec("BEGIN");
            try {
              this.stmtDeleteVec!.run(id);
              this.stmtInsertVec!.run(
                id,
                Buffer.from(embedding.buffer),
                row.updated_time,
              );
              this.db.exec("COMMIT");
            } catch (txErr) {
              try {
                this.db.exec("ROLLBACK");
              } catch {
                /* ignore */
              }
              throw txErr;
            }
          });
        }
      } catch (err) {
        this.logger?.warn?.(
          `${TAG} reindexL1Records skip ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      done++;
      onProgress?.(done, ids.length);
    }
    this.logger?.info?.(`${TAG} reindexL1Records done: ${done}/${ids.length}`);
    return { done, total: ids.length };
  }

  /**
   * Incremental per-row L0 reindex (ТЗ §5.6 window-skip heal): per-row
   * `l0_vec` delete+insert for l0_conversations ids whose vector is missing
   * after a full reindex window (updateL0Embedding skips while the flag is
   * set). recorded_at is taken from the metadata row.
   */
  async reindexL0Records(
    ids: string[],
    embedFn: (text: string) => Promise<Float32Array>,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ done: number; total: number }> {
    if (this.degraded || !this.vecTablesReady || ids.length === 0) {
      return { done: 0, total: ids.length };
    }
    let done = 0;
    for (const id of ids) {
      try {
        const meta = this.stmtL0GetMeta.get(id) as
          { message_text: string; recorded_at: string } | undefined;
        if (meta) {
          const embedding = await embedFn(meta.message_text);
          runSqliteBusyRetry(() => {
            this.db.exec("BEGIN");
            try {
              this.stmtL0DeleteVec!.run(id);
              this.stmtL0InsertVec!.run(
                id,
                Buffer.from(embedding.buffer),
                meta.recorded_at,
              );
              this.db.exec("COMMIT");
            } catch (txErr) {
              try {
                this.db.exec("ROLLBACK");
              } catch {
                /* ignore */
              }
              throw txErr;
            }
          });
        }
      } catch (err) {
        this.logger?.warn?.(
          `${TAG} reindexL0Records skip ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      done++;
      onProgress?.(done, ids.length);
    }
    this.logger?.info?.(`${TAG} reindexL0Records done: ${done}/${ids.length}`);
    return { done, total: ids.length };
  }

  // ── L0 query operations (for L1 runner) ──────────────────────────────────

  /**
   * Query L0 messages for a given session key, optionally filtered by recorded_at cursor.
   * Returns messages ordered by recorded_at ASC (chronological write order).
   *
   * Used by L1 runner to read L0 data from DB instead of JSONL files.
   */
  queryL0ForL1(
    sessionKey: string,
    afterRecordedAtMs?: number,
    limit = 50,
  ): Array<{
    record_id: string;
    session_key: string;
    session_id: string;
    role: string;
    message_text: string;
    recorded_at: string;
    timestamp: number;
    project_id: string;
  }> {
    if (this.degraded) {
      this.logger?.warn(`${TAG} [L0-query] SKIPPED (degraded mode)`);
      return [];
    }
    try {
      // Query newest-first (DESC) with LIMIT, then reverse to chronological order
      let rows: Array<Record<string, unknown>>;
      if (afterRecordedAtMs && afterRecordedAtMs > 0) {
        // Convert epoch ms to ISO string for recorded_at comparison
        const afterRecordedAtIso = new Date(afterRecordedAtMs).toISOString();
        rows = this.stmtL0QueryAfter.all(
          sessionKey,
          afterRecordedAtIso,
          limit,
        ) as Array<Record<string, unknown>>;
      } else {
        rows = this.stmtL0QueryAll.all(sessionKey, limit) as Array<
          Record<string, unknown>
        >;
      }

      this.logger?.info(
        `${TAG} [L0-query] session=${sessionKey}, afterRecordedAtMs=${afterRecordedAtMs ?? "(all)"}, ` +
          `limit=${limit}, returned ${rows.length} row(s)`,
      );

      // Reverse: SQL returns newest-first (DESC), callers expect chronological order
      return rows
        .map((r) => ({
          record_id: r.record_id as string,
          session_key: r.session_key as string,
          session_id: (r.session_id as string) || "",
          role: r.role as string,
          message_text: r.message_text as string,
          recorded_at: (r.recorded_at as string) || "",
          timestamp: (r.timestamp as number) || 0,
          project_id: (r.project_id as string) || "",
        }))
        .reverse();
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L0-query] FAILED (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Query L0 messages for a given session key, grouped by session_id.
   * Each group's messages are in chronological order (recorded_at ASC).
   * Groups are sorted by earliest message timestamp.
   *
   * Used by L1 runner to replace readConversationMessagesGroupedBySessionId().
   */
  queryL0GroupedBySessionId(
    sessionKey: string,
    afterRecordedAtMs?: number,
    limit = 50,
  ): Array<{
    sessionId: string;
    projectId: string;
    messages: Array<{
      id: string;
      role: string;
      content: string;
      timestamp: number;
      recordedAtMs: number;
    }>;
  }> {
    if (this.degraded) {
      this.logger?.warn(`${TAG} [L0-query-grouped] SKIPPED (degraded mode)`);
      return [];
    }
    try {
      const rows = this.queryL0ForL1(sessionKey, afterRecordedAtMs, limit);

      // Group by session_id
      const groupMap = new Map<
        string,
        Array<{
          id: string;
          role: string;
          content: string;
          timestamp: number;
          recordedAtMs: number;
        }>
      >();
      for (const row of rows) {
        const sid = row.session_id || "";
        let group = groupMap.get(sid);
        if (!group) {
          group = [];
          groupMap.set(sid, group);
        }
        group.push({
          id: row.record_id,
          role: row.role,
          content: row.message_text,
          timestamp: row.timestamp,
          recordedAtMs: row.recorded_at ? Date.parse(row.recorded_at) || 0 : 0,
        });
      }

      // Project id is a property of the session, not of individual messages —
      // take the first non-empty one seen for this session_id.
      const projectBySid = new Map<string, string>();
      for (const row of rows) {
        const sid = row.session_id || "";
        if (!projectBySid.get(sid) && row.project_id)
          projectBySid.set(sid, row.project_id);
      }

      // Convert to array, sorted by earliest message timestamp
      const groups: Array<{
        sessionId: string;
        projectId: string;
        messages: Array<{
          id: string;
          role: string;
          content: string;
          timestamp: number;
          recordedAtMs: number;
        }>;
      }> = [];
      for (const [sessionId, messages] of groupMap) {
        if (messages.length > 0) {
          groups.push({
            sessionId,
            projectId: projectBySid.get(sessionId) ?? "",
            messages,
          });
        }
      }
      groups.sort((a, b) => a.messages[0].timestamp - b.messages[0].timestamp);

      this.logger?.info(
        `${TAG} [L0-query-grouped] session=${sessionKey}, afterRecordedAtMs=${afterRecordedAtMs ?? "(all)"}, ` +
          `${rows.length} messages across ${groups.length} group(s)`,
      );

      return groups;
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L0-query-grouped] FAILED (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  // ── Cursor-based pagination for migration ──────────────────

  /**
   * Read a page of L1 records using primary key cursor.
   * Returns rows with `record_id > afterId`, ordered by PK, limited to `pageSize`.
   * Pass `""` as `afterId` for the first page.
   */
  queryL1RecordsCursor(afterId: string, pageSize: number): L1RecordRow[] {
    if (this.degraded) return [];
    try {
      return this.stmtL1QueryMigrationCursor.all(
        afterId,
        pageSize,
      ) as unknown as L1RecordRow[];
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L1-query-cursor] FAILED (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Read a page of L0 records using primary key cursor.
   * Returns rows with `record_id > afterId`, ordered by PK, limited to `pageSize`.
   * Pass `""` as `afterId` for the first page.
   */
  queryL0RecordsCursor(afterId: string, pageSize: number): L0RecordRow[] {
    if (this.degraded) return [];
    try {
      return this.stmtL0QueryMigrationCursor.all(
        afterId,
        pageSize,
      ) as unknown as L0RecordRow[];
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L0-query-cursor] FAILED (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  // ── FTS5 search operations ──────────────────────────────────

  /**
   * Whether FTS5 full-text search is available.
   * When `false`, callers should skip keyword-based recall entirely.
   */
  isFtsAvailable(): boolean {
    return this.ftsAvailable;
  }

  /**
   * FTS5 keyword search on L1 records.
   * Returns top-`limit` results sorted by BM25 relevance (highest first).
   *
   * @param ftsQuery  A pre-built FTS5 MATCH expression (from `buildFtsQuery()`).
   * @param limit     Maximum number of results to return.
   *
   * **Fault-tolerant**: returns an empty array on any error.
   */
  searchL1Fts(
    ftsQuery: string,
    limit = 20,
    projectId = "",
    mode: ScopeMode = "hidden",
  ): FtsSearchResult[] {
    if (this.degraded || !this.ftsAvailable) return [];
    try {
      // In decay mode, the scope WHERE is rewritten to admit all rows; the
      // JS-side scopeDecayMultiplier applies the soft penalty.
      const scopeParam = mode === "decay" ? "__decay_all__" : projectId;
      const rows = this.stmtL1FtsSearch.all(
        ftsQuery,
        scopeParam,
        limit,
        mode,
      ) as Array<{
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
        metadata_json: string;
        project_id: string;
        scope: string;
        rank: number;
      }>;

      return rows.map((r) => ({
        record_id: r.record_id,
        content: r.content,
        type: r.type,
        priority: r.priority,
        scene_name: r.scene_name,
        score: bm25RankToScore(r.rank),
        timestamp_str: r.timestamp_str,
        timestamp_start: r.timestamp_start,
        timestamp_end: r.timestamp_end,
        session_key: r.session_key,
        session_id: r.session_id,
        metadata_json: r.metadata_json,
        project_id: r.project_id ?? "",
        scope: r.scope ?? "",
      }));
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L1-fts-search] FAILED (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * FTS5 keyword search on L0 conversation messages.
   * Returns top-`limit` results sorted by BM25 relevance (highest first).
   *
   * @param ftsQuery  A pre-built FTS5 MATCH expression (from `buildFtsQuery()`).
   * @param limit     Maximum number of results to return.
   *
   * **Fault-tolerant**: returns an empty array on any error.
   */
  searchL0Fts(
    ftsQuery: string,
    limit = VectorStore.FTS_DEFAULT_LIMIT,
  ): L0FtsSearchResult[] {
    if (this.degraded || !this.ftsAvailable) return [];
    try {
      const rows = this.stmtL0FtsSearch.all(ftsQuery, limit) as Array<{
        record_id: string;
        message_text: string;
        session_key: string;
        session_id: string;
        role: string;
        recorded_at: string;
        timestamp: number;
        rank: number;
      }>;

      return rows.map((r) => ({
        record_id: r.record_id,
        session_key: r.session_key,
        session_id: r.session_id,
        role: r.role,
        message_text: r.message_text,
        score: bm25RankToScore(r.rank),
        recorded_at: r.recorded_at,
        timestamp: r.timestamp ?? 0,
      }));
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L0-fts-search] FAILED (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  // ── FTS5 migration & rebuild ──────────────────────────────────────────────

  /**
   * Detect old FTS5 v1 schema (no `content_original` column) and drop the
   * tables so they can be recreated with the v2 schema.
   *
   * FTS5 virtual tables do NOT support `ALTER TABLE ADD COLUMN`, so the only
   * migration path is DROP + recreate + repopulate.
   *
   * @returns what the index turned out to be — see `FtsMigrationCheck`.
   * @internal
   */
  private migrateFtsTablesIfNeeded(): FtsMigrationCheck {
    try {
      // BOTH tables are the index, and each is judged on its own. A table of
      // the old SHAPE cannot be repopulated at all — the insert names a column
      // it does not have — so a stale one has to be dropped even when the
      // other is merely absent, or init fails on every open from then on.
      const present = ["l1_fts", "l0_fts"].filter((table) =>
        this.tableExists(table),
      );
      const stale = present.filter((table) => !this.hasCurrentFtsShape(table));

      if (present.length === 2 && stale.length === 0) {
        // The shape is current; the question is whether the CONTENT was
        // written the way this build writes it. v2 applied jieba to every
        // script, and for anything it has no dictionary for jieba returns one
        // token per LETTER — documents were indexed as loose letters, so a
        // query for any Russian word matched nearly every Russian document.
        // Already written rows cannot be repaired in place; the FTS tables are
        // derived from l1_records / l0_conversations, so a rebuild costs time
        // and nothing else.
        // Not `>=`: an index written by a NEWER build holds text this build
        // does not cut the same way, and it would go on writing v4 rows into
        // it while querying v4 — the asymmetry this marker exists to prevent.
        // Any version but this one is rebuilt, then marked with this one.
        if (this.readFtsSchemaVersion() === FTS_SCHEMA_VERSION) {
          const written = this.readFtsTokenizer();
          if (written === currentTokenizerId()) return { kind: "current" };
          this.logger?.info(
            `${TAG} FTS index was written by tokenizer "${written}", this runtime has ` +
              `"${currentTokenizerId()}" — rebuilding so the two sides agree`,
          );
        } else {
          this.logger?.info(
            `${TAG} Migrating FTS5 index to v${FTS_SCHEMA_VERSION} (per-script segmentation)`,
          );
        }
      } else if (stale.length > 0) {
        this.logger?.info(
          `${TAG} Migrating FTS5 tables of the old shape (${stale.join(", ")}) to the segmented schema`,
        );
      } else if (present.length === 0) {
        // Nothing to migrate — but existing records still have to be indexed
        // into the tables init is about to create.
        return this.hasAnyRecords()
          ? { kind: "rebuild-needed", shapeChanged: true }
          : { kind: "current" };
      }

      // One table missing while the other is present, a stale shape, an older
      // version, a different tokenizer: all repaired the same way, and both
      // tables go together so the two halves never disagree about their age.
      // The drop itself is left to the caller, which does it inside the same
      // transaction as the refill — a check must not be able to empty the
      // index on its own.
      return {
        kind: "rebuild-needed",
        dropFirst: true,
        shapeChanged: present.length !== 2 || stale.length > 0,
      };
    } catch (err) {
      this.logger?.warn(
        `${TAG} FTS migration check failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      // What the index holds is now unknown, so nothing is claimed about it:
      // marking it current would retire the repair that never ran.
      return { kind: "unknown" };
    }
  }

  /** @internal */
  private tableExists(name: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(name);
  }

  /** Does this FTS table hold the raw-text column the current schema writes? */
  private hasCurrentFtsShape(table: string): boolean {
    const raw =
      table === "l1_fts" ? "content_original" : "message_text_original";
    const cols = this.db
      .prepare(`SELECT name FROM pragma_table_info('${table}')`)
      .all() as Array<{ name: string }>;
    return cols.some((c) => c.name === raw);
  }

  /** Is there anything to index at all? Either layer counts. */
  private hasAnyRecords(): boolean {
    return ["l1_records", "l0_conversations"].some((table) =>
      this.db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get(),
    );
  }

  /**
   * Rebuild the FTS5 index from scratch by reading all records from the
   * metadata tables and re-inserting them with `segmentForFts()` text.
   *
   * Called automatically after:
   *  - Any FTS schema migration (v1 → v2 → v3)
   *  - Fresh table creation when existing data exists
   *
   * Safe to call multiple times (idempotent — clears FTS tables first).
   *
   * @returns `true` when the index was repopulated. A `false` here is what
   * keeps the schema marker unwritten, so the next open tries again: the
   * tables have already been dropped by then, and a marker over an empty
   * index would freeze that emptiness in forever.
   */
  rebuildFtsIndex(): boolean {
    if (!this.ftsAvailable) return false;

    // One transaction for the whole rebuild. The tables are emptied first, so
    // without it every reader between the DELETE and the last INSERT sees a
    // memory that has forgotten everything, and a crash in the middle leaves it
    // that way. Committing once also spares 18k separate autocommits. `init`
    // has a transaction of its own — the drop and the fresh tables belong in
    // it too — and calls `rebuildFtsRows` directly.
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch (err) {
      this.logger?.warn(
        `${TAG} FTS5 rebuild could not start: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
    try {
      const complete = this.rebuildFtsRows();
      this.db.exec("COMMIT");
      return complete;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The failure already ended the transaction.
      }
      this.logger?.warn(
        `${TAG} FTS5 rebuild failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Refill both FTS tables from the records they are derived from.
   *
   * Assumes an open transaction and a caller that will commit or roll it back:
   * the tables are emptied first, and an index visible in that state is an
   * index that has forgotten everything. Failures are THROWN for that reason —
   * swallowing one here would commit the emptiness.
   *
   * @returns whether every row was indexed.
   * @throws whatever the database raises; the caller must roll back.
   */
  private rebuildFtsRows(): boolean {
    this.logger?.info(
      `${TAG} Rebuilding FTS5 index with per-script segmentation…`,
    );

    // ── Rebuild L1 FTS ──
    this.db.exec("DELETE FROM l1_fts");

    // Streamed, not materialised: L0 alone is tens of MB of text on a real
    // install, and `.all()` held every row of it in memory at once.
    const l1 = this.reindexFtsRows<{
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
      metadata_json: string;
    }>(
      `SELECT record_id, content, type, priority, scene_name,
              session_key, session_id, timestamp_str, timestamp_start,
              timestamp_end, metadata_json
       FROM l1_records`,
      "L1",
      (r) =>
        this.stmtL1FtsInsert.run(
          tokenizeForFts(r.content), // content — segmented
          r.content, // content_original — raw
          r.record_id,
          r.type,
          r.priority,
          r.scene_name,
          r.session_key,
          r.session_id,
          r.timestamp_str,
          r.timestamp_start,
          r.timestamp_end,
          r.metadata_json,
        ),
    );

    // ── Rebuild L0 FTS ──
    this.db.exec("DELETE FROM l0_fts");

    const l0 = this.reindexFtsRows<{
      record_id: string;
      message_text: string;
      session_key: string;
      session_id: string;
      role: string;
      recorded_at: string;
      timestamp: number;
    }>(
      `SELECT record_id, message_text, session_key, session_id, role,
              recorded_at, timestamp
       FROM l0_conversations`,
      "L0",
      (r) =>
        this.stmtL0FtsInsert.run(
          tokenizeForFts(r.message_text), // message_text — segmented
          r.message_text, // message_text_original — raw
          r.record_id,
          r.session_key,
          r.session_id,
          r.role,
          r.recorded_at,
          r.timestamp,
        ),
    );

    const complete = l1.indexed === l1.seen && l0.indexed === l0.seen;
    this.logger?.[complete ? "info" : "warn"](
      `${TAG} FTS5 rebuild ${complete ? "complete" : "INCOMPLETE"}: ` +
        `L1=${l1.indexed}/${l1.seen}, L0=${l0.indexed}/${l0.seen}`,
    );
    // Rows are skipped one by one on error, so a "finished" rebuild can
    // still have holes in it. An index missing rows is not this version's
    // index: leaving the marker unwritten costs one more rebuild attempt,
    // claiming it costs the rows.
    return complete;
  }

  /**
   * Bring the FTS tables into the shape this build indexes with, and refill
   * them when the segmentation they hold is not this one.
   *
   * The drop, the fresh tables, the statements and the refill are ONE
   * transaction: without it a rebuild that fails halfway leaves both tables
   * empty for the rest of the process — search answers "nothing found" over a
   * memory that holds everything, and only the next open repairs it.
   *
   * @returns whether a rebuild ran to completion (the marker follows that).
   * @throws when the index cannot be made usable at all; the caller degrades
   *   to no FTS. A LOCKED database is not that case: the tables are left as
   *   they are, still searchable, and the next open tries the rebuild again.
   */
  private openFtsTables(migration: FtsMigrationCheck): boolean {
    const rebuilding = migration.kind === "rebuild-needed";
    if (rebuilding && !this.beginFtsTransaction(migration)) {
      // Another process holds the write lock — its own rebuild, most likely.
      // The tables are usable, so this process searches the index it finds and
      // leaves the repair to whoever can take the lock.
      this.prepareFtsStatements();
      this.ftsAvailable = true;
      this.ftsRebuildPending = true;
      return false;
    }

    try {
      if (migration.dropFirst) {
        this.db.exec("DROP TABLE IF EXISTS l1_fts");
        this.db.exec("DROP TABLE IF EXISTS l0_fts");
      }
      this.createFtsTables();
      this.prepareFtsStatements();
      this.ftsAvailable = true;
      this.logger?.debug?.(
        `${TAG} FTS5 tables initialized (l1_fts, l0_fts) [schema v${FTS_SCHEMA_VERSION} — per-script segmentation]`,
      );

      if (!rebuilding) return false;
      const didRebuild = this.rebuildFtsRows();
      this.db.exec("COMMIT");
      return didRebuild;
    } catch (err) {
      if (rebuilding) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // The failure already ended the transaction.
        }
      }
      // A rollback restores the tables as they were. When their SHAPE was
      // wrong that is still an index this build cannot write to, so the
      // failure travels on; otherwise the old index is searched as it stands.
      if (migration.shapeChanged || !isDatabaseLocked(err)) throw err;
      this.logger?.warn(
        `${TAG} FTS5 rebuild postponed — the database is locked; searching the existing index`,
      );
      this.prepareFtsStatements();
      this.ftsAvailable = true;
      this.ftsRebuildPending = true;
      return false;
    }
  }

  /**
   * Take the write lock for a rebuild.
   *
   * @returns false when another process holds it and the tables can be used as
   *   they are; throws when they cannot.
   */
  private beginFtsTransaction(migration: FtsMigrationCheck): boolean {
    try {
      this.db.exec("BEGIN IMMEDIATE");
      return true;
    } catch (err) {
      if (migration.shapeChanged || !isDatabaseLocked(err)) throw err;
      this.logger?.warn(
        `${TAG} FTS5 rebuild postponed — the database is locked; searching the existing index`,
      );
      return false;
    }
  }

  /** The statements every FTS read and write goes through. */
  private prepareFtsStatements(): void {
    // L1 FTS prepared statements
    this.stmtL1FtsInsert = this.db.prepare(`
        INSERT INTO l1_fts (content, content_original, record_id, type, priority, scene_name,
          session_key, session_id, timestamp_str, timestamp_start, timestamp_end, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

    this.stmtL1FtsDelete = this.db.prepare(
      "DELETE FROM l1_fts WHERE record_id = ?",
    );

    // NOTE: l1_fts must NOT be aliased — MATCH and bm25() require the real
    // table name (an alias fails at prepare() with "no such column: <alias>",
    // and searchL1Fts swallows that error, silently killing keyword recall).
    // Only l1_records gets an alias.
    this.stmtL1FtsSearch = this.db.prepare(`
        SELECT l1_fts.record_id, l1_fts.content_original AS content, l1_fts.type,
               l1_fts.priority, l1_fts.scene_name, l1_fts.session_key, l1_fts.session_id,
               l1_fts.timestamp_str, l1_fts.timestamp_start, l1_fts.timestamp_end,
               l1_fts.metadata_json,
               r.project_id, COALESCE(r.scope, '') AS scope,
               bm25(l1_fts) AS rank
        FROM l1_fts
        JOIN l1_records r ON r.record_id = l1_fts.record_id
        WHERE l1_fts MATCH ?1
          AND (
            ?2 = '' OR ?2 = '__decay_all__'
            OR (?4 = 'hidden' AND (COALESCE(r.scope, '') <> 'project' OR r.project_id = ?2))
            OR (?4 = 'strict' AND (COALESCE(r.scope, '') = 'global'
                                   OR (COALESCE(r.scope, '') = 'project' AND r.project_id = ?2)))
          )
        ORDER BY rank ASC
        LIMIT ?3
      `);

    // L0 FTS prepared statements
    this.stmtL0FtsInsert = this.db.prepare(`
        INSERT INTO l0_fts (message_text, message_text_original, record_id, session_key, session_id, role, recorded_at, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

    this.stmtL0FtsDelete = this.db.prepare(
      "DELETE FROM l0_fts WHERE record_id = ?",
    );

    this.stmtL0FtsSearch = this.db.prepare(`
        SELECT record_id, message_text_original AS message_text, session_key, session_id, role, recorded_at, timestamp,
               bm25(l0_fts) AS rank
        FROM l0_fts
        WHERE l0_fts MATCH ?
        ORDER BY rank ASC
        LIMIT ?
      `);
  }

  /** The two FTS tables, created only when they are not already there. */
  private createFtsTables(): void {
    // L1 FTS5 virtual table (v2 schema)
    this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS l1_fts USING fts5(
          content,
          content_original UNINDEXED,
          record_id UNINDEXED,
          type UNINDEXED,
          priority UNINDEXED,
          scene_name UNINDEXED,
          session_key UNINDEXED,
          session_id UNINDEXED,
          timestamp_str UNINDEXED,
          timestamp_start UNINDEXED,
          timestamp_end UNINDEXED,
          metadata_json UNINDEXED
        )
      `);

    // L0 FTS5 virtual table (v2 schema)
    this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS l0_fts USING fts5(
          message_text,
          message_text_original UNINDEXED,
          record_id UNINDEXED,
          session_key UNINDEXED,
          session_id UNINDEXED,
          role UNINDEXED,
          recorded_at UNINDEXED,
          timestamp UNINDEXED
        )
      `);
  }

  /**
   * Feed every row of one source table into its FTS table, row by row.
   *
   * A row that cannot be indexed is skipped and counted, not thrown: one
   * unreadable record must not cost the rebuild the other eighteen thousand.
   * The caller compares the two counts to learn whether the index is whole.
   */
  private reindexFtsRows<T extends { record_id: string }>(
    sql: string,
    label: string,
    insert: (row: T) => void,
  ): { seen: number; indexed: number } {
    let seen = 0;
    let indexed = 0;
    for (const row of this.db.prepare(sql).iterate() as Iterable<T>) {
      seen++;
      try {
        insert(row);
        indexed++;
      } catch (err) {
        this.logger?.warn?.(
          `${TAG} FTS rebuild skip ${label} ${row.record_id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { seen, indexed };
  }

  // ============================
  // IMemoryStore interface implementation
  // ============================

  /** Query the store's search capabilities. */
  getCapabilities(): StoreCapabilities {
    return {
      vectorSearch: this.vecTablesReady,
      ftsSearch: this.ftsAvailable,
      nativeHybridSearch: false,
      sparseVectors: false,
    };
  }

  /**
   * Close the database connection.
   * Should be called on shutdown. Idempotent — safe to call multiple times.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} Error closing database: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

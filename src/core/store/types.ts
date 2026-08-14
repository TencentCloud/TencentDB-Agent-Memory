/**
 * Memory Store Abstraction Layer — Core Types & Interfaces.
 *
 * This module defines the storage contracts that all backend implementations
 * (SQLite local, Tencent Cloud VectorDB, etc.) must satisfy.
 *
 * Design principles:
 * 1. **Backend-agnostic**: Upper-layer modules (hooks, tools, pipeline, record)
 *    depend only on these interfaces — never on concrete implementations.
 * 2. **Capability-based**: Features like vector search, FTS, and hybrid search
 *    are expressed as capability flags so callers can gracefully degrade.
 * 3. **Fault-tolerant**: All methods return empty results or `false` on
 *    failure rather than throwing, unless explicitly documented otherwise.
 * 4. **Sync-first**: Matches current SQLite DatabaseSync usage. TCVDB backend
 *    adapts internally without changing these signatures.
 */

import type { MemoryRecord } from "../record/l1-writer.js";
import type { EmbeddingProviderInfo } from "./embedding.js";
import type { Logger } from "../types.js";
import type { ScopeMode } from "../hooks/auto-recall/scope.js";

// Re-export so consumers can import everything from types.ts
export type { MemoryRecord, EmbeddingProviderInfo };

// ============================
// Common Types
// ============================

/** Minimal logger interface accepted by store implementations. */
export type StoreLogger = Logger;

// ============================
// L1 Types (Structured Memories)
// ============================

/** Result from an L1 vector similarity search. */
export interface L1SearchResult {
  record_id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  /** Similarity score (0–1, higher is better). */
  score: number;
  timestamp_str: string;
  timestamp_start: string;
  timestamp_end: string;
  session_key: string;
  session_id: string;
  metadata_json: string;
  /** Project this memory came from (git-root of cwd); '' when unknown. */
  project_id?: string;
  /** 'global' | 'project' | undefined (legacy records and non-sqlite backends predate scoping). */
  scope?: string;
}

/** Result from an L1 FTS keyword search. */
export interface L1FtsResult {
  record_id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  /** BM25-derived score (0–1, higher is better). */
  score: number;
  timestamp_str: string;
  timestamp_start: string;
  timestamp_end: string;
  session_key: string;
  session_id: string;
  metadata_json: string;
  /** Project this memory came from (git-root of cwd); '' when unknown. */
  project_id?: string;
  /** 'global' | 'project' | undefined (legacy records and non-sqlite backends predate scoping). */
  scope?: string;
}

/** Filter options for querying L1 records. */
export interface L1QueryFilter {
  sessionKey?: string;
  sessionId?: string;
  /** Only return records with updated_time strictly after this ISO 8601 UTC timestamp. */
  updatedAfter?: string;
}

/** Row shape returned by L1 query methods. */
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
  /** Project this memory belongs to; '' on legacy rows and non-sqlite backends. */
  project_id?: string;
  scope?: string;
}

// ============================
// L0 Types (Raw Conversations)
// ============================

/** An L0 conversation message record for vector indexing. */
export interface L0Record {
  id: string;
  sessionKey: string;
  sessionId: string;
  role: string;
  messageText: string;
  recordedAt: string;
  /** Original message timestamp (epoch ms). */
  timestamp: number;
  /** Project this message came from; travels to L1 because extraction is async. */
  projectId?: string;
}

/** Result from an L0 vector similarity search. */
export interface L0SearchResult {
  record_id: string;
  session_key: string;
  session_id: string;
  role: string;
  message_text: string;
  /** Similarity score (0–1, higher is better). */
  score: number;
  recorded_at: string;
  timestamp: number;
}

/** Result from an L0 FTS keyword search. */
export interface L0FtsResult {
  record_id: string;
  session_key: string;
  session_id: string;
  role: string;
  message_text: string;
  /** BM25-derived score (0–1, higher is better). */
  score: number;
  recorded_at: string;
  timestamp: number;
}

/** Raw L0 row returned by query methods (used by L1 runner). */
export interface L0QueryRow {
  record_id: string;
  session_key: string;
  session_id: string;
  role: string;
  message_text: string;
  recorded_at: string;
  timestamp: number;
  project_id?: string;
}

/** L0 messages grouped by session ID (for L1 runner). */
export interface L0SessionGroup {
  sessionId: string;
  /** Project this session belongs to; '' when unknown or on backends that don't track it. */
  projectId?: string;
  messages: Array<{
    id: string;
    role: string;
    content: string;
    timestamp: number;
    /** Epoch ms when this message was recorded into L0 (used by L1 cursor). */
    recordedAtMs: number;
  }>;
}

// ============================
// Store Init Result
// ============================

/** Result of store initialization. */
export interface StoreInitResult {
  /** Whether embeddings need to be regenerated (provider/model change). */
  needsReindex: boolean;
  /** Human-readable reason (for logging). */
  reason?: string;
}

// ============================
// Capability Flags
// ============================

/**
 * Describes what search capabilities a store backend supports.
 * Callers use this to select search strategies and degrade gracefully.
 */
export interface StoreCapabilities {
  /** Whether vector (embedding) search is available. */
  vectorSearch: boolean;
  /** Whether FTS (full-text keyword) search is available. */
  ftsSearch: boolean;
  /** Whether native hybrid search is supported (e.g., TCVDB hybridSearch). */
  nativeHybridSearch: boolean;
  /** Whether the store supports sparse vectors (BM25 encoding). */
  sparseVectors: boolean;
}

// ============================
// L2/L3 Profile Sync Types
// ============================

/** Canonical L2/L3 profile row shared between local cache and remote store. */
export interface ProfileRecord {
  /** Stable ID: `profile:v1:${sha256(scope + "\0" + type + "\0" + filename)}`. */
  id: string;
  type: "l2" | "l3";
  filename: string;
  content: string;
  contentMd5: string;
  agentId?: string;
  version: number;
  createdAtMs: number;
  updatedAtMs: number;
}

/** Profile upsert payload with optimistic-lock baseline from the last pull. */
export interface ProfileSyncRecord extends ProfileRecord {
  baselineVersion?: number;
}

// ============================
// IMemoryStore — The Core Abstraction
// ============================

/**
 * Unified memory store interface.
 *
 * Implementations:
 * - `SqliteMemoryStore` (sqlite.ts) — local SQLite + sqlite-vec + FTS5
 * - `TcvdbMemoryStore` (tcvdb.ts) — Tencent Cloud VectorDB (future)
 *
 * All methods are fault-tolerant: they return empty results or `false` on
 * failure rather than throwing, unless explicitly documented otherwise.
 */
/**
 * Helper type: a value that may be sync or async.
 * Callers should always `await` the result — it's safe for both sync and async values.
 */
export type MaybePromise<T> = T | Promise<T>;

export interface IMemoryStore {
  // ── Capabilities ───────────────────────────────────────────

  /**
   * Whether this store supports deferred (background) embedding updates.
   *
   * When `true`, auto-capture writes metadata-only via `upsertL0(record, undefined)`
   * and later calls `updateL0Embedding()` in a fire-and-forget background task.
   * When `false` or absent, embedding is computed inline and passed to `upsertL0()`.
   */
  readonly supportsDeferredEmbedding?: boolean;

  // ── Lifecycle (always sync) ──────────────────────────────

  init(providerInfo?: EmbeddingProviderInfo): MaybePromise<StoreInitResult>;
  isDegraded(): boolean;
  getCapabilities(): StoreCapabilities;
  close(): void;

  // ── L1 Write ─────────────────────────────────────────────

  upsertL1(
    record: MemoryRecord,
    embedding?: Float32Array,
  ): MaybePromise<boolean>;
  deleteL1(recordId: string): MaybePromise<boolean>;
  deleteL1Batch(recordIds: string[]): MaybePromise<boolean>;
  deleteL1Expired(cutoffIso: string): MaybePromise<number>;

  // ── L1 Read ──────────────────────────────────────────────

  countL1(): MaybePromise<number>;
  /** Exact persistence lookup. Returns null only for confirmed absence and
   * throws when the backend cannot establish the result. */
  getL1ById(recordId: string): MaybePromise<L1RecordRow | null>;
  queryL1Records(filter?: L1QueryFilter): MaybePromise<L1RecordRow[]>;
  getAllL1Texts(): MaybePromise<
    Array<{ record_id: string; content: string; updated_time: string }>
  >;

  // ── L1 Search ────────────────────────────────────────────

  searchL1Vector(
    queryEmbedding: Float32Array,
    topK?: number,
    queryText?: string,
    projectId?: string,
    mode?: ScopeMode,
  ): MaybePromise<L1SearchResult[]>;
  searchL1Fts(
    ftsQuery: string,
    limit?: number,
    projectId?: string,
    mode?: ScopeMode,
  ): MaybePromise<L1FtsResult[]>;
  searchL1Hybrid?(params: {
    query?: string;
    queryEmbedding?: Float32Array;
    sparseVector?: Array<[number, number]>;
    topK?: number;
    /** Scope filtering, applied store-side (tz-05 Ф4b). */
    projectId?: string;
    mode?: ScopeMode;
  }): MaybePromise<L1SearchResult[]>;

  // ── L0 Write ─────────────────────────────────────────────

  upsertL0(record: L0Record, embedding?: Float32Array): MaybePromise<boolean>;
  /** Update only the vector embedding for an existing L0 record (sqlite background path). */
  updateL0Embedding?(
    recordId: string,
    embedding: Float32Array,
  ): MaybePromise<boolean>;
  deleteL0(recordId: string): MaybePromise<boolean>;
  deleteL0Expired(cutoffIso: string): MaybePromise<number>;

  // ── L0 Read ──────────────────────────────────────────────

  countL0(): MaybePromise<number>;
  queryL0ForL1(
    sessionKey: string,
    afterRecordedAtMs?: number,
    limit?: number,
    afterRecordId?: string,
  ): MaybePromise<L0QueryRow[]>;
  queryL0GroupedBySessionId(
    sessionKey: string,
    afterRecordedAtMs?: number,
    limit?: number,
    afterRecordId?: string,
  ): MaybePromise<L0SessionGroup[]>;
  getAllL0Texts(): MaybePromise<
    Array<{ record_id: string; message_text: string; recorded_at: string }>
  >;

  // ── L0 Search ────────────────────────────────────────────

  searchL0Vector(
    queryEmbedding: Float32Array,
    topK?: number,
    queryText?: string,
  ): MaybePromise<L0SearchResult[]>;
  searchL0Fts(ftsQuery: string, limit?: number): MaybePromise<L0FtsResult[]>;

  pullProfiles?(): Promise<ProfileRecord[]>;
  syncProfiles?(records: ProfileSyncRecord[]): Promise<void>;
  deleteProfiles?(recordIds: string[]): Promise<void>;

  // ── Re-index ─────────────────────────────────────────────

  reindexAll(
    embedFn: (text: string) => Promise<Float32Array>,
    onProgress?: (done: number, total: number, layer: "L1" | "L0") => void,
    /**
     * Embed a whole batch in one call. Optional: without it every text goes
     * on its own, which is what a local model wants and what a remote one
     * cannot afford (~3 texts/s versus ~35 measured against NVIDIA).
     */
    embedBatchFn?: (texts: string[]) => Promise<Float32Array[]>,
  ): Promise<{ l1Count: number; l0Count: number }>;

  // ── Consistency (wave tdai-memory-subagents-2026-08-02, P4 apply-executor) ──

  /**
   * vec-vs-meta consistency snapshot: both COUNTs and the orphan vector id set
   * (vec ∖ meta) computed in a single transaction (ТЗ §5.5 post-apply count check).
   *
   * Optional — backends that cannot count vectors omit it. Fault-tolerant:
   * `vecCount: null` means no vec0 tables / degraded store (check must be
   * skipped, NOT treated as mismatch); an empty `orphanIds` means consistent.
   */
  consistencyCheck?(): MaybePromise<{
    metaCount: number;
    vecCount: number | null;
    orphanIds: string[];
    /** meta∖vec — per-row backfill targets (P8 livelock-cap delta). Optional: backends without it fall back to needsReindex. */
    missingIds?: string[];
    /** l0_vec logical rows (null when vec0 absent). Optional (P8 L0 window-skip heal). */
    l0VecCount?: number | null;
    /** l0_conversations∖l0_vec — L0 per-row backfill targets. Optional. */
    l0MissingIds?: string[];
  }>;

  /**
   * Incremental per-row L1 reindex (ТЗ §5.6): per-row `l1_vec` delete+insert
   * for the given record ids (NOT a SQL UPDATE). Used for the count-mismatch
   * delta backfill after the reindex livelock cap and for content-rewrite
   * re-embedding. Optional — backends without it fall back to needsReindex.
   */
  reindexL1Records?(
    ids: string[],
    embedFn: (text: string) => Promise<Float32Array>,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ done: number; total: number }>;

  /**
   * Incremental per-row L0 reindex (ТЗ §5.6 window-skip heal): per-row
   * `l0_vec` delete+insert for l0_conversations ids whose vector is missing
   * after a full reindex window. Optional.
   */
  reindexL0Records?(
    ids: string[],
    embedFn: (text: string) => Promise<Float32Array>,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ done: number; total: number }>;

  /**
   * True while a full reindexAll is in flight. Read routes (recall, memory
   * search, conversation search) must fail OPEN with an empty result, never an
   * error (reindex-in-progress gate, ТЗ §5.6). Optional.
   */
  isReindexing?(): boolean;

  /**
   * Delete stray l1_vec rows whose record_id has no l1_records row, one
   * transaction (per-id via the prepared stmtDeleteVec). No-op true when the
   * list is empty or vec tables are absent. Fault-tolerant: false on failure.
   */
  purgeOrphanVectors?(orphanIds: string[]): MaybePromise<boolean>;

  // ── FTS (always sync — cached flag) ──────────────────────

  isFtsAvailable(): boolean;
}

// ============================
// IEmbeddingService — re-exported from embedding.ts for convenience
// ============================

/**
 * Re-export EmbeddingService as IEmbeddingService for backward compatibility.
 * The canonical definition lives in `./embedding.ts`. All concrete implementations
 * (LocalEmbeddingService, OpenAIEmbeddingService, NoopEmbeddingService) implement
 * the EmbeddingService interface from embedding.ts.
 */
export type { EmbeddingService as IEmbeddingService } from "./embedding.js";

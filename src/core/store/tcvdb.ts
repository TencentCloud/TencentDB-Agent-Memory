/**
 * TcvdbMemoryStore: Tencent Cloud VectorDB backend implementing IMemoryStore.
 *
 * Features:
 * - Server-side dense embedding (embeddingItems via Collection embedding config)
 * - Client-side sparse vectors (BM25 local encoder for hybridSearch)
 * - Native hybridSearch (dense + sparse + RRFRerank)
 * - Filter expressions for scalar field queries
 * - Time fields stored as uint64 epoch ms (ISO ↔ epoch conversion internal)
 *
 * All methods are fault-tolerant: return empty/false on error, never throw.
 */

import type { MemoryRecord } from "../record/l1-writer.js";
import type { EmbeddingProviderInfo } from "./embedding.js";
import type {
  IMemoryStore,
  StoreCapabilities,
  StoreInitResult,
  L1SearchResult,
  L1FtsResult,
  L1RecordRow,
  L1QueryFilter,
  L0SearchResult,
  L0FtsResult,
  L0QueryRow,
  L0SessionGroup,
  ProfileRecord,
  ProfileSyncRecord,
  StoreLogger,
} from "./types.js";
import { TcvdbClient, TcvdbApiError } from "./tcvdb-client.js";
import type { BM25LocalEncoder } from "./bm25-local.js";
import type { SparseVector } from "@tencentdb-agent-memory/tcvdb-text";

// ============================
// Config & Constants
// ============================

export interface TcvdbMemoryStoreConfig {
  url: string;
  username: string;
  apiKey: string;
  database: string;
  embeddingModel: string;
  timeout: number;
  /** Path to CA certificate PEM file (for HTTPS connections) */
  caPemPath?: string;
  logger?: StoreLogger;
  bm25Encoder?: BM25LocalEncoder;
}

const TAG = "[memory-tdai][tcvdb]";

/**
 * Escape a string for use as a literal inside a VectorDB filter expression's
 * double-quoted value. Without this, a session key containing `"` could break
 * out of the quoted literal and inject arbitrary filter predicates, leaking
 * records across sessions. Backslash is escaped first so an injected `\"`
 * sequence can't neutralize the quote escaping.
 */
function escapeTcvdbFilterString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Base collection suffixes (prefixed with database name at construction time). */
const L1_COLLECTION_SUFFIX = "l1_memories";
const L0_COLLECTION_SUFFIX = "l0_conversations";
const PROFILES_COLLECTION_SUFFIX = "profiles";

/** Max documents per /document/query page (VectorDB API limit). */
const QUERY_PAGE_SIZE = 100;

/** All L1 output fields returned by query/search (excludes vector/sparse_vector). */
const L1_OUTPUT_FIELDS = [
  "id", "text", "type", "priority", "scene_name",
  "session_key", "session_id", "timestamp_str", "timestamp_start",
  "timestamp_end", "metadata_json", "created_time_ms", "updated_time_ms",
];

/** All L0 output fields returned by query/search. */
const L0_OUTPUT_FIELDS = [
  "id", "message_text", "agent_id", "session_key", "session_id", "role",
  "recorded_at_ms", "timestamp",
];

const PROFILE_OUTPUT_FIELDS = [
  "id", "type", "filename", "content", "content_md5", "agent_id",
  "version", "created_at_ms", "updated_at_ms",
];

const PROFILE_METADATA_OUTPUT_FIELDS = [
  "id", "type", "filename", "content_md5", "agent_id",
  "version", "created_at_ms", "updated_at_ms",
];

// ============================
// Helpers
// ============================

function isoToEpochMs(iso: string): number {
  if (!iso) return 0;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function epochMsToIso(ms: number): string {
  if (!ms || ms <= 0) return "";
  return new Date(ms).toISOString();
}

/**
 * Extract agent ID from a sessionKey like `agent:<agentId>:<channel>`.
 * Returns empty string if the format doesn't match.
 */
function extractAgentId(sessionKey: string): string {
  if (!sessionKey) return "";
  const parts = sessionKey.split(":");
  // Format: "agent:<agentId>:..." → parts[1]
  if (parts.length >= 2 && parts[0] === "agent") {
    return parts[1];
  }
  return "";
}

// ============================
// TcvdbMemoryStore
// ============================

export class TcvdbMemoryStore implements IMemoryStore {
  private readonly client: TcvdbClient;
  private readonly embeddingModel: string;
  private readonly logger?: StoreLogger;
  private readonly bm25Encoder?: BM25LocalEncoder;
  private readonly l1Collection: string;
  private readonly l0Collection: string;
  private readonly profilesCollection: string;
  private degraded = false;

  /** Promise that resolves when async init completes. */
  private _initPromise: Promise<void> | undefined;

  constructor(config: TcvdbMemoryStoreConfig) {
    this.client = new TcvdbClient({
      url: config.url,
      username: config.username,
      apiKey: config.apiKey,
      database: config.database,
      timeout: config.timeout,
      caPemPath: config.caPemPath,
    }, config.logger);
    this.embeddingModel = config.embeddingModel;
    this.logger = config.logger;
    this.bm25Encoder = config.bm25Encoder;

    // Collection names are globally unique within a TCVDB instance,
    // so prefix with database name to avoid cross-database collisions.
    this.l1Collection = `${config.database}_${L1_COLLECTION_SUFFIX}`;
    this.l0Collection = `${config.database}_${L0_COLLECTION_SUFFIX}`;
    this.profilesCollection = `${config.database}_${PROFILES_COLLECTION_SUFFIX}`;
  }

  // ── Lifecycle ────────────────────────────────────────────

  async init(_providerInfo?: EmbeddingProviderInfo): Promise<StoreInitResult> {
    // TCVDB init is async (HTTP). We store the promise so _ensureInit()
    // can also await it as a defensive fallback in each data method.
    this._initPromise = this._initAsync();
    try {
      await this._initPromise;
    } catch (err) {
      this.logger?.error(`${TAG} Async init failed: ${err instanceof Error ? err.message : String(err)}`);
      this.degraded = true;
    }
    return { needsReindex: false };
  }

  /**
   * Await async initialization. Call at the start of every async method.
   * If init already completed (or failed → degraded), returns immediately.
   */
  private async _ensureInit(): Promise<void> {
    if (this._initPromise) {
      await this._initPromise;
    }
  }

  // ── Vector index definitions ─────────────────────────────
  //
  // Preferred: DISK_FLAT (lower memory, suitable for large-scale recall).
  // Fallback:  HNSW (for instances whose storage engine doesn't support DISK_FLAT).

  private static readonly VECTOR_INDEX_DISK_FLAT: Record<string, unknown> = {
    fieldName: "vector", fieldType: "vector", indexType: "DISK_FLAT",
    dimension: 1024, metricType: "COSINE",
  };

  private static readonly VECTOR_INDEX_HNSW: Record<string, unknown> = {
    fieldName: "vector", fieldType: "vector", indexType: "HNSW",
    dimension: 1024, metricType: "COSINE",
    params: { M: 16, efConstruction: 200 },
  };

  /**
   * Detect whether a createCollection error indicates DISK_FLAT is unsupported.
   * Matches on apiCode 15113 OR message containing "DISK_FLAT" + "not support".
   */
  private static isDiskFlatUnsupported(err: unknown): boolean {
    if (!(err instanceof TcvdbApiError)) return false;
    if (err.apiCode === 15113) return true;
    const msg = err.message.toLowerCase();
    return msg.includes("disk_flat") && (msg.includes("not support") || msg.includes("unsupported"));
  }

  /**
   * Create a collection with DISK_FLAT vector index, falling back to HNSW
   * if the storage engine doesn't support DISK_FLAT.
   */
  private async _createCollectionWithVectorFallback(
    params: Record<string, unknown>,
    filterIndexes: Array<Record<string, unknown>>,
  ): Promise<void> {
    const buildIndexes = (vectorIndex: Record<string, unknown>) => [
      { fieldName: "id", fieldType: "string", indexType: "primaryKey" },
      vectorIndex,
      { fieldName: "sparse_vector", fieldType: "sparseVector", indexType: "inverted", metricType: "IP" },
      ...filterIndexes,
    ];

    try {
      await this.client.createCollection({ ...params, indexes: buildIndexes(TcvdbMemoryStore.VECTOR_INDEX_DISK_FLAT) });
    } catch (err) {
      if (TcvdbMemoryStore.isDiskFlatUnsupported(err)) {
        this.logger?.debug?.(`${TAG} DISK_FLAT not supported for ${String(params.collection)}, falling back to HNSW`);
        await this.client.createCollection({ ...params, indexes: buildIndexes(TcvdbMemoryStore.VECTOR_INDEX_HNSW) });
      } else {
        throw err;
      }
    }
  }

  private async _initAsync(): Promise<void> {
    try {
      // Create database (idempotent — returns true if just created, false if already existed)
      const dbCreated = await this.client.createDatabase();

      if (dbCreated) {
        // TCVDB requires ~3s after database creation before collections can be created.
        // TODO: defer collection creation to first use to avoid blocking plugin startup.
        this.logger?.debug?.(`${TAG} Waiting 5s for database to become ready...`);
        await new Promise((r) => setTimeout(r, 5_000));
      }

      // Create L1 collection (DISK_FLAT preferred, HNSW fallback)
      await this._createCollectionWithVectorFallback(
        {
          collection: this.l1Collection,
          shardNum: 1,
          replicaNum: 2,
          description: "L1 结构化记忆",
          embedding: {
            status: "enabled",
            field: "text",
            vectorField: "vector",
            model: this.embeddingModel,
          },
        },
        [
          { fieldName: "type",            fieldType: "string", indexType: "filter" },
          { fieldName: "priority",        fieldType: "uint64", indexType: "filter" },
          { fieldName: "scene_name",      fieldType: "string", indexType: "filter" },
          { fieldName: "agent_id",        fieldType: "string", indexType: "filter" },
          { fieldName: "session_key",     fieldType: "string", indexType: "filter" },
          { fieldName: "session_id",      fieldType: "string", indexType: "filter" },
          { fieldName: "timestamp_start", fieldType: "string", indexType: "filter" },
          { fieldName: "timestamp_end",   fieldType: "string", indexType: "filter" },
          { fieldName: "created_time_ms", fieldType: "uint64", indexType: "filter" },
          { fieldName: "updated_time_ms", fieldType: "uint64", indexType: "filter" },
        ],
      );

      // Create L0 collection (DISK_FLAT preferred, HNSW fallback)
      await this._createCollectionWithVectorFallback(
        {
          collection: this.l0Collection,
          shardNum: 1,
          replicaNum: 2,
          description: "L0 原始对话消息",
          embedding: {
            status: "enabled",
            field: "message_text",
            vectorField: "vector",
            model: this.embeddingModel,
          },
        },
        [
          { fieldName: "agent_id",       fieldType: "string", indexType: "filter" },
          { fieldName: "session_key",    fieldType: "string", indexType: "filter" },
          { fieldName: "session_id",     fieldType: "string", indexType: "filter" },
          { fieldName: "role",           fieldType: "string", indexType: "filter" },
          { fieldName: "recorded_at_ms", fieldType: "uint64", indexType: "filter" },
          { fieldName: "timestamp",      fieldType: "int64",  indexType: "filter" },
        ],
      );

      await this.client.createCollection({
        collection: this.profilesCollection,
        shardNum: 1,
        replicaNum: 2,
        description: "L2 场景块 + L3 用户画像",
        embedding: { status: "disabled" },
        indexes: [
          { fieldName: "id",            fieldType: "string", indexType: "primaryKey" },
          { fieldName: "vector",        fieldType: "vector", indexType: "FLAT",
            dimension: 1, metricType: "COSINE" },
          { fieldName: "type",          fieldType: "string", indexType: "filter" },
          { fieldName: "filename",      fieldType: "string", indexType: "filter" },
          { fieldName: "content_md5",   fieldType: "string", indexType: "filter" },
          { fieldName: "agent_id",      fieldType: "string", indexType: "filter" },
          { fieldName: "created_at_ms", fieldType: "uint64", indexType: "filter" },
          { fieldName: "updated_at_ms", fieldType: "uint64", indexType: "filter" },
          { fieldName: "version",       fieldType: "uint64", indexType: "filter" },
        ],
      });

      this.logger?.debug?.(`${TAG} Initialized: db=${this.client.getDatabase()}, model=${this.embeddingModel}`);
    } catch (err) {
      // 15201 = database already exists — benign race in createDatabase().
      // 15202 (collection already exists) is now handled inside TcvdbClient.createCollection(),
      // so it should no longer reach here.
      if (err instanceof TcvdbApiError && err.apiCode === 15201) {
        this.logger?.debug?.(`${TAG} Init (benign): ${err.message}`);
        return;
      }
      this.logger?.error(`${TAG} Init failed: ${err instanceof Error ? err.message : String(err)}`);
      this.degraded = true;
    }
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  getCapabilities(): StoreCapabilities {
    const hasBm25 = !!this.bm25Encoder;
    return {
      vectorSearch: true,
      ftsSearch: hasBm25,
      nativeHybridSearch: hasBm25,
      sparseVectors: hasBm25,
    };
  }

  close(): void {
    // Close the undici dispatcher's keep-alive connection pool (best-effort,
    // async) so hot-reload doesn't leak sockets until GC.
    void this.client.close().catch(() => { /* best-effort */ });
  }

  // ── Internal: paginated query helper ────────────────────

  /**
   * Paginated /document/query that fetches all matching docs.
   * TCVDB query API returns at most `limit` docs per call.
   * We loop with offset until fewer docs than page size are returned.
   */
  private async _queryAllDocs(
    collection: string,
    filter?: string,
    outputFields?: string[],
    limit?: number,
    sort?: Array<Record<string, unknown>>,
  ): Promise<Array<Record<string, unknown>>> {
    const allDocs: Array<Record<string, unknown>> = [];
    let offset = 0;
    const pageSize = limit && limit < QUERY_PAGE_SIZE ? limit : QUERY_PAGE_SIZE;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const queryParams: Record<string, unknown> = {
        retrieveVector: false,
        limit: pageSize,
        offset,
      };
      if (filter) queryParams.filter = filter;
      if (outputFields) queryParams.outputFields = outputFields;
      if (sort) queryParams.sort = sort;

      const resp = await this.client.query(collection, queryParams);
      const docs = resp.documents ?? [];
      allDocs.push(...docs);

      // Stop if: we got fewer than page size (last page), or we hit caller's limit
      if (docs.length < pageSize) break;
      if (limit && allDocs.length >= limit) break;

      offset += docs.length;
    }

    // Trim to caller's limit if specified
    return limit ? allDocs.slice(0, limit) : allDocs;
  }

  // ── L1 Write Operations ──────────────────────────────────

  async upsertL1(record: MemoryRecord, _embedding?: Float32Array): Promise<boolean> {
    try {
      await this._upsertL1Async(record);
      return true;
    } catch (err) {
      this.logger?.warn(`${TAG} [L1-upsert] FAILED id=${record.id}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private async _upsertL1Async(record: MemoryRecord): Promise<void> {
    await this._ensureInit();
    if (this.degraded) return;

    const tsStr = record.timestamps[0] ?? "";
    const tsStart = record.timestamps.length > 0
      ? record.timestamps.reduce((a, b) => (a < b ? a : b)) : tsStr;
    const tsEnd = record.timestamps.length > 0
      ? record.timestamps.reduce((a, b) => (a > b ? a : b)) : tsStr;

    const doc: Record<string, unknown> = {
      id: record.id,
      text: record.content,
      type: record.type,
      priority: record.priority,
      scene_name: record.scene_name,
      agent_id: extractAgentId(record.sessionKey),
      session_key: record.sessionKey,
      session_id: record.sessionId,
      timestamp_str: tsStr,
      timestamp_start: tsStart,
      timestamp_end: tsEnd,
      created_time_ms: isoToEpochMs(record.createdAt),
      updated_time_ms: isoToEpochMs(record.updatedAt),
      metadata_json: JSON.stringify(record.metadata),
    };

    // BM25 sparse vector (if sidecar available)
    if (this.bm25Encoder) {
      const sparse = this.bm25Encoder.encodeTexts([record.content]);
      if (sparse.length > 0 && sparse[0].length > 0) {
        doc.sparse_vector = sparse[0];
      }
    }

    await this.client.upsert(this.l1Collection, [doc]);
  }

  /**
   * Batch upsert multiple L1 records in a single API call.
   * Used by migration scripts to reduce request count.
   */
  async upsertL1Batch(records: MemoryRecord[]): Promise<number> {
    if (records.length === 0) return 0;
    try {
      await this._ensureInit();
      if (this.degraded) return 0;

      const docs = records.map((record) => {
        const tsStr = record.timestamps[0] ?? "";
        const tsStart = record.timestamps.length > 0
          ? record.timestamps.reduce((a, b) => (a < b ? a : b)) : tsStr;
        const tsEnd = record.timestamps.length > 0
          ? record.timestamps.reduce((a, b) => (a > b ? a : b)) : tsStr;

        const doc: Record<string, unknown> = {
          id: record.id,
          text: record.content,
          type: record.type,
          priority: record.priority,
          scene_name: record.scene_name,
          agent_id: extractAgentId(record.sessionKey),
          session_key: record.sessionKey,
          session_id: record.sessionId,
          timestamp_str: tsStr,
          timestamp_start: tsStart,
          timestamp_end: tsEnd,
          created_time_ms: isoToEpochMs(record.createdAt),
          updated_time_ms: isoToEpochMs(record.updatedAt),
          metadata_json: JSON.stringify(record.metadata),
        };

        if (this.bm25Encoder) {
          const sparse = this.bm25Encoder.encodeTexts([record.content]);
          if (sparse.length > 0 && sparse[0].length > 0) {
            doc.sparse_vector = sparse[0];
          }
        }
        return doc;
      });

      await this.client.upsert(this.l1Collection, docs);
      return records.length;
    } catch (err) {
      this.logger?.warn(`${TAG} [L1-upsertBatch] FAILED (${records.length} records): ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  async deleteL1(recordId: string): Promise<boolean> {
    try {
      await this._ensureInit();
      if (this.degraded) return false;
      await this.client.deleteDoc(this.l1Collection, {
        query: { documentIds: [recordId] },
      });
      return true;
    } catch (err) {
      this.logger?.warn(`${TAG} [L1-delete] FAILED id=${recordId}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async deleteL1Batch(recordIds: string[]): Promise<boolean> {
    if (recordIds.length === 0) return true;
    try {
      await this._ensureInit();
      if (this.degraded) return false;
      await this.client.deleteDoc(this.l1Collection, {
        query: { documentIds: recordIds },
      });
      return true;
    } catch (err) {
      this.logger?.warn(`${TAG} [L1-deleteBatch] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async deleteL1Expired(cutoffIso: string): Promise<number> {
    const cutoffMs = isoToEpochMs(cutoffIso);
    if (cutoffMs <= 0) return 0;
    try {
      await this._ensureInit();
      if (this.degraded) return 0;

      const filter = `updated_time_ms < ${cutoffMs}`;
      const toDelete = await this.client.count(this.l1Collection, filter);
      if (toDelete === 0) return 0;

      const total = await this.client.count(this.l1Collection);
      const ratio = total > 0 ? toDelete / total : 0;

      if (ratio > 0.8) {
        this.logger?.warn(
          `${TAG} [L1-deleteExpired] BLOCKED: would delete ${toDelete}/${total} ` +
          `(${(ratio * 100).toFixed(1)}%) — exceeds 80% safety threshold, cutoff=${cutoffIso}`,
        );
        return 0;
      }

      await this.client.deleteDoc(this.l1Collection, {
        query: { filter },
      });
      this.logger?.info?.(
        `${TAG} [L1-deleteExpired] Deleted ~${toDelete}/${total} records (cutoff=${cutoffIso})`,
      );
      return toDelete;
    } catch (err) {
      this.logger?.warn(`${TAG} [L1-deleteExpired] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  // ── L1 Read Operations ───────────────────────────────────

  async countL1(): Promise<number> {
    try {
      await this._ensureInit();
      if (this.degraded) return 0;
      return await this.client.count(this.l1Collection);
    } catch (err) {
      this.logger?.warn(`${TAG} [L1-count] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  async queryL1Records(filter?: L1QueryFilter): Promise<L1RecordRow[]> {
    try {
      await this._ensureInit();
      if (this.degraded) return [];

      // Build TCVDB filter expression from L1QueryFilter
      const conditions: string[] = [];
      if (filter?.sessionKey) conditions.push(`session_key = "${escapeTcvdbFilterString(filter.sessionKey)}"`);
      if (filter?.sessionId) conditions.push(`session_id = "${escapeTcvdbFilterString(filter.sessionId)}"`);
      if (filter?.updatedAfter) {
        const afterMs = isoToEpochMs(filter.updatedAfter);
        if (afterMs > 0) conditions.push(`updated_time_ms > ${afterMs}`);
      }
      const filterExpr = conditions.length > 0 ? conditions.join(" and ") : undefined;

      const docs = await this._queryAllDocs(
        this.l1Collection,
        filterExpr,
        L1_OUTPUT_FIELDS,
        undefined, // no limit — fetch all matching
        [{ fieldName: "updated_time_ms", direction: "asc" }],
      );

      return docs.map((doc) => ({
        record_id: String(doc.id ?? ""),
        content: String(doc.text ?? ""),
        type: String(doc.type ?? ""),
        priority: Number(doc.priority ?? 0),
        scene_name: String(doc.scene_name ?? ""),
        session_key: String(doc.session_key ?? ""),
        session_id: String(doc.session_id ?? ""),
        timestamp_str: String(doc.timestamp_str ?? ""),
        timestamp_start: String(doc.timestamp_start ?? ""),
        timestamp_end: String(doc.timestamp_end ?? ""),
        created_time: epochMsToIso(Number(doc.created_time_ms ?? 0)),
        updated_time: epochMsToIso(Number(doc.updated_time_ms ?? 0)),
        metadata_json: String(doc.metadata_json ?? "{}"),
      }));
    } catch (err) {
      this.logger?.warn(`${TAG} [L1-query] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async getAllL1Texts(): Promise<Array<{ record_id: string; content: string; updated_time: string }>> {
    try {
      await this._ensureInit();
      if (this.degraded) return [];

      const docs = await this._queryAllDocs(
        this.l1Collection,
        undefined,
        ["id", "text", "updated_time_ms"],
      );

      return docs.map((doc) => ({
        record_id: String(doc.id ?? ""),
        content: String(doc.text ?? ""),
        updated_time: epochMsToIso(Number(doc.updated_time_ms ?? 0)),
      }));
    } catch (err) {
      this.logger?.warn(`${TAG} [L1-getAllTexts] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  // ── L1 Search Operations ─────────────────────────────────

  async searchL1Vector(_queryEmbedding: Float32Array, topK?: number, queryText?: string): Promise<L1SearchResult[]> {
    // TCVDB uses server-side embedding — delegate to hybrid search with text
    if (queryText) {
      return this.searchL1HybridAsync({ queryText, topK });
    }
    // No queryText and TCVDB can't use client embeddings directly via embeddingItems
    // Return empty — callers should pass queryText for TCVDB
    return [];
  }

  async searchL1Fts(ftsQuery: string, limit?: number): Promise<L1FtsResult[]> {
    // TCVDB has no pure FTS — use hybrid search with sparse-only path
    // The ftsQuery is raw text, use it as queryText for hybrid
    if (!ftsQuery) return [];
    const results = await this.searchL1HybridAsync({ queryText: ftsQuery, topK: limit });
    // L1SearchResult and L1FtsResult have identical shapes
    return results;
  }

  async searchL1Hybrid(params: {
    query?: string;
    queryEmbedding?: Float32Array;
    sparseVector?: SparseVector;
    topK?: number;
  }): Promise<L1SearchResult[]> {
    const queryText = params.query;
    if (!queryText) return [];
    return this.searchL1HybridAsync({ queryText, topK: params.topK });
  }

  /**
   * Async L1 hybrid search — the real implementation.
   * Call this directly from async contexts (hooks, tools).
   */
  async searchL1HybridAsync(params: {
    queryText: string;
    topK?: number;
  }): Promise<L1SearchResult[]> {
    const { queryText, topK = 10 } = params;
    if (!queryText) return [];

    try {
      await this._ensureInit();
      if (this.degraded) return [];

      // Build search params
      const searchParams: Record<string, unknown> = {
        limit: topK,
        outputFields: L1_OUTPUT_FIELDS,
      };

      // ann: use embedding field name "text" for server-side embedding
      // (per SDK: AnnSearch(field_name="text", data='query string'))
      const ann = [{
        fieldName: "text",
        data: [queryText], // embeddingItems — server-side embedding
        limit: topK,
      }];

      let match: Array<Record<string, unknown>> | undefined;
      if (this.bm25Encoder) {
        const sparse = this.bm25Encoder.encodeQueries([queryText]);
        if (sparse.length > 0 && sparse[0].length > 0) {
          match = [{
            fieldName: "sparse_vector",
            data: [sparse[0]], // SDK wraps single sparse vector in array
            limit: topK,
          }];
        }
      }

      if (match) {
        // Full hybrid: dense + sparse + RRF
        searchParams.ann = ann;
        searchParams.match = match;
        searchParams.rerank = { method: "rrf", k: 60 };

        const resp = await this.client.hybridSearch(this.l1Collection, searchParams);
        return this._parseL1SearchResults(resp.documents);
      } else {
        // Dense-only fallback (BM25 unavailable) — use /document/search with embeddingItems
        const denseSearch: Record<string, unknown> = {
          embeddingItems: [queryText],
          limit: topK,
          retrieveVector: false,
          outputFields: L1_OUTPUT_FIELDS,
        };
        const resp = await this.client.search(this.l1Collection, denseSearch);
        return this._parseL1SearchResults(resp.documents);
      }
    } catch (err) {
      this.logger?.warn(`${TAG} [L1-hybridSearch] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  // ── L0 Write Operations ──────────────────────────────────

  async upsertL0(record: { id: string; sessionKey: string; sessionId: string; role: string; messageText: string; recordedAt: string; timestamp: number }, _embedding?: Float32Array): Promise<boolean> {
    try {
      await this._upsertL0Async(record);
      return true;
    } catch (err) {
      this.logger?.warn(`${TAG} [L0-upsert] FAILED id=${record.id}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private async _upsertL0Async(record: { id: string; sessionKey: string; sessionId: string; role: string; messageText: string; recordedAt: string; timestamp: number }): Promise<void> {
    await this._ensureInit();
    if (this.degraded) return;

    const doc: Record<string, unknown> = {
      id: record.id,
      message_text: record.messageText,
      agent_id: extractAgentId(record.sessionKey),
      session_key: record.sessionKey,
      session_id: record.sessionId,
      role: record.role,
      recorded_at_ms: isoToEpochMs(record.recordedAt),
      timestamp: record.timestamp,
    };

    if (this.bm25Encoder) {
      const sparse = this.bm25Encoder.encodeTexts([record.messageText]);
      if (sparse.length > 0 && sparse[0].length > 0) {
        doc.sparse_vector = sparse[0];
      }
    }

    await this.client.upsert(this.l0Collection, [doc]);
  }

  /**
   * Batch upsert multiple L0 records in a single API call.
   * Used by migration scripts to reduce request count.
   */
  async upsertL0Batch(records: Array<{ id: string; sessionKey: string; sessionId: string; role: string; messageText: string; recordedAt: string; timestamp: number }>): Promise<number> {
    if (records.length === 0) return 0;
    try {
      await this._ensureInit();
      if (this.degraded) return 0;

      const docs = records.map((record) => {
        const doc: Record<string, unknown> = {
          id: record.id,
          message_text: record.messageText,
          agent_id: extractAgentId(record.sessionKey),
          session_key: record.sessionKey,
          session_id: record.sessionId,
          role: record.role,
          recorded_at_ms: isoToEpochMs(record.recordedAt),
          timestamp: record.timestamp,
        };

        if (this.bm25Encoder) {
          const sparse = this.bm25Encoder.encodeTexts([record.messageText]);
          if (sparse.length > 0 && sparse[0].length > 0) {
            doc.sparse_vector = sparse[0];
          }
        }
        return doc;
      });

      await this.client.upsert(this.l0Collection, docs);
      return records.length;
    } catch (err) {
      this.logger?.warn(`${TAG} [L0-upsertBatch] FAILED (${records.length} records): ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  async deleteL0(recordId: string): Promise<boolean> {
    try {
      await this._ensureInit();
      if (this.degraded) return false;
      await this.client.deleteDoc(this.l0Collection, {
        query: { documentIds: [recordId] },
      });
      return true;
    } catch (err) {
      this.logger?.warn(`${TAG} [L0-delete] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async deleteL0Expired(cutoffIso: string): Promise<number> {
    const cutoffMs = isoToEpochMs(cutoffIso);
    if (cutoffMs <= 0) return 0;
    try {
      await this._ensureInit();
      if (this.degraded) return 0;

      const filter = `recorded_at_ms < ${cutoffMs}`;
      const toDelete = await this.client.count(this.l0Collection, filter);
      if (toDelete === 0) return 0;

      const total = await this.client.count(this.l0Collection);
      const ratio = total > 0 ? toDelete / total : 0;

      if (ratio > 0.8) {
        this.logger?.warn(
          `${TAG} [L0-deleteExpired] BLOCKED: would delete ${toDelete}/${total} ` +
          `(${(ratio * 100).toFixed(1)}%) — exceeds 80% safety threshold, cutoff=${cutoffIso}`,
        );
        return 0;
      }

      await this.client.deleteDoc(this.l0Collection, {
        query: { filter },
      });
      this.logger?.info?.(
        `${TAG} [L0-deleteExpired] Deleted ~${toDelete}/${total} records (cutoff=${cutoffIso})`,
      );
      return toDelete;
    } catch (err) {
      this.logger?.warn(`${TAG} [L0-deleteExpired] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  // ── L0 Read Operations ───────────────────────────────────

  async countL0(): Promise<number> {
    try {
      await this._ensureInit();
      if (this.degraded) return 0;
      return await this.client.count(this.l0Collection);
    } catch (err) {
      this.logger?.warn(`${TAG} [L0-count] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  async queryL0ForL1(sessionKey: string, afterRecordedAtMs?: number, limit = 50): Promise<L0QueryRow[]> {
    try {
      await this._ensureInit();
      if (this.degraded) return [];

      const conditions: string[] = [`session_key = "${escapeTcvdbFilterString(sessionKey)}"`];
      if (afterRecordedAtMs && afterRecordedAtMs > 0) {
        conditions.push(`recorded_at_ms > ${afterRecordedAtMs}`);
      }
      const filterExpr = conditions.join(" and ");

      const docs = await this._queryAllDocs(
        this.l0Collection,
        filterExpr,
        L0_OUTPUT_FIELDS,
        limit,
        [{ fieldName: "recorded_at_ms", direction: "desc" }],
      );

      // Convert to L0QueryRow and reverse to chronological order (query is DESC, callers expect ASC)
      const rows: L0QueryRow[] = docs.map((doc) => ({
        record_id: String(doc.id ?? ""),
        session_key: String(doc.session_key ?? ""),
        session_id: String(doc.session_id ?? ""),
        role: String(doc.role ?? ""),
        message_text: String(doc.message_text ?? ""),
        recorded_at: epochMsToIso(Number(doc.recorded_at_ms ?? 0)),
        timestamp: Number(doc.timestamp ?? 0),
      }));

      return rows.reverse();
    } catch (err) {
      this.logger?.warn(`${TAG} [L0-queryForL1] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async queryL0GroupedBySessionId(sessionKey: string, afterRecordedAtMs?: number, limit = 50): Promise<L0SessionGroup[]> {
    try {
      const rows = await this.queryL0ForL1(sessionKey, afterRecordedAtMs, limit);

      // Group by session_id
      const groupMap = new Map<string, Array<{ id: string; role: string; content: string; timestamp: number; recordedAtMs: number }>>();
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

      // Convert to array, sorted by earliest message timestamp
      const groups: L0SessionGroup[] = [];
      for (const [sessionId, messages] of groupMap) {
        if (messages.length > 0) {
          groups.push({ sessionId, messages });
        }
      }
      groups.sort((a, b) => a.messages[0].timestamp - b.messages[0].timestamp);

      return groups;
    } catch (err) {
      this.logger?.warn(`${TAG} [L0-queryGrouped] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async getAllL0Texts(): Promise<Array<{ record_id: string; message_text: string; recorded_at: string }>> {
    try {
      await this._ensureInit();
      if (this.degraded) return [];

      const docs = await this._queryAllDocs(
        this.l0Collection,
        undefined,
        ["id", "message_text", "recorded_at_ms"],
      );

      return docs.map((doc) => ({
        record_id: String(doc.id ?? ""),
        message_text: String(doc.message_text ?? ""),
        recorded_at: epochMsToIso(Number(doc.recorded_at_ms ?? 0)),
      }));
    } catch (err) {
      this.logger?.warn(`${TAG} [L0-getAllTexts] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  // ── L0 Search Operations ─────────────────────────────────

  async searchL0Vector(_queryEmbedding: Float32Array, topK?: number, queryText?: string): Promise<L0SearchResult[]> {
    // TCVDB uses server-side embedding — delegate to hybrid search with text
    if (queryText) {
      return this.searchL0HybridAsync({ queryText, topK });
    }
    return [];
  }

  async searchL0Fts(ftsQuery: string, limit?: number): Promise<L0FtsResult[]> {
    if (!ftsQuery) return [];
    // Use hybrid search; L0SearchResult and L0FtsResult have identical shapes
    return this.searchL0HybridAsync({ queryText: ftsQuery, topK: limit });
  }

  /**
   * Async L0 hybrid search.
   */
  async searchL0HybridAsync(params: {
    queryText: string;
    topK?: number;
  }): Promise<L0SearchResult[]> {
    const { queryText, topK = 10 } = params;
    if (!queryText) return [];

    try {
      await this._ensureInit();
      if (this.degraded) return [];

      const searchParams: Record<string, unknown> = {
        limit: topK,
        outputFields: L0_OUTPUT_FIELDS,
      };

      // ann: use embedding field name "message_text" for L0 server-side embedding
      const ann = [{
        fieldName: "message_text",
        data: [queryText],
        limit: topK,
      }];

      let match: Array<Record<string, unknown>> | undefined;
      if (this.bm25Encoder) {
        const sparse = this.bm25Encoder.encodeQueries([queryText]);
        if (sparse.length > 0 && sparse[0].length > 0) {
          match = [{
            fieldName: "sparse_vector",
            data: [sparse[0]],
            limit: topK,
          }];
        }
      }

      if (match) {
        searchParams.ann = ann;
        searchParams.match = match;
        searchParams.rerank = { method: "rrf", k: 60 };
        const resp = await this.client.hybridSearch(this.l0Collection, searchParams);
        return this._parseL0SearchResults(resp.documents);
      } else {
        const denseSearch: Record<string, unknown> = {
          embeddingItems: [queryText],
          limit: topK,
          retrieveVector: false,
          outputFields: L0_OUTPUT_FIELDS,
        };
        const resp = await this.client.search(this.l0Collection, denseSearch);
        return this._parseL0SearchResults(resp.documents);
      }
    } catch (err) {
      this.logger?.warn(`${TAG} [L0-hybridSearch] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async pullProfiles(): Promise<ProfileRecord[]> {
    try {
      await this._ensureInit();
      if (this.degraded) return [];

      const docs = await this._queryAllDocs(
        this.profilesCollection,
        undefined,
        PROFILE_OUTPUT_FIELDS,
      );

      return docs.map((doc) => ({
        id: String(doc.id ?? ""),
        type: doc.type === "l3" ? "l3" : "l2",
        filename: String(doc.filename ?? ""),
        content: String(doc.content ?? ""),
        contentMd5: String(doc.content_md5 ?? ""),
        agentId: String(doc.agent_id ?? "") || undefined,
        version: Number(doc.version ?? 0),
        createdAtMs: Number(doc.created_at_ms ?? 0),
        updatedAtMs: Number(doc.updated_at_ms ?? 0),
      }));
    } catch (err) {
      this.logger?.warn(`${TAG} [profiles-pull] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async syncProfiles(records: ProfileSyncRecord[]): Promise<void> {
    if (records.length === 0) return;

    try {
      await this._ensureInit();
      if (this.degraded) return;

      const remoteDocs = await this._queryAllDocs(
        this.profilesCollection,
        undefined,
        PROFILE_METADATA_OUTPUT_FIELDS,
      );
      const remoteMap = new Map(
        remoteDocs.map((doc) => [String(doc.id ?? ""), doc] as const),
      );
      const now = Date.now();
      const upserts: Array<Record<string, unknown>> = [];

      for (const record of records) {
        const current = remoteMap.get(record.id);
        if (!current) {
          const createdAtMs = record.createdAtMs > 0 ? record.createdAtMs : now;
          upserts.push({
            id: record.id,
            vector: [0],
            type: record.type,
            filename: record.filename,
            content: record.content,
            content_md5: record.contentMd5,
            agent_id: record.agentId ?? "",
            version: 1,
            created_at_ms: createdAtMs,
            updated_at_ms: now,
          });
          continue;
        }

        const currentMd5 = String(current.content_md5 ?? "");
        const currentVersion = Number(current.version ?? 0);
        const currentCreatedAtMs = Number(current.created_at_ms ?? 0) || now;

        if (currentMd5 === record.contentMd5) {
          continue;
        }

        if ((record.baselineVersion ?? 0) !== currentVersion) {
          this.logger?.warn(
            `${TAG} [profiles-sync] Conflict for ${record.filename}: remote version advanced from ${record.baselineVersion ?? 0} to ${currentVersion}, skipping sync`,
          );
          continue;
        }

        upserts.push({
          id: record.id,
          vector: [0],
          type: record.type,
          filename: record.filename,
          content: record.content,
          content_md5: record.contentMd5,
          agent_id: record.agentId ?? "",
          version: currentVersion + 1,
          created_at_ms: currentCreatedAtMs,
          updated_at_ms: now,
        });
      }

      if (upserts.length > 0) {
        await this.client.upsert(this.profilesCollection, upserts);
      }
    } catch (err) {
      this.logger?.warn(`${TAG} [profiles-sync] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async deleteProfiles(recordIds: string[]): Promise<void> {
    if (recordIds.length === 0) return;

    try {
      await this._ensureInit();
      if (this.degraded) return;
      await this.client.deleteDoc(this.profilesCollection, {
        query: { documentIds: recordIds },
      });
    } catch (err) {
      this.logger?.warn(`${TAG} [profiles-delete] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Re-index ─────────────────────────────────────────────

  async reindexAll(
    _embedFn: (text: string) => Promise<Float32Array>,
    _onProgress?: (done: number, total: number, layer: "L1" | "L0") => void,
  ): Promise<{ l1Count: number; l0Count: number }> {
    // TCVDB uses server-side embedding — reindex means rebuild Collection.
    // Not implemented in Phase 2-3 (requires drop + recreate + re-upsert from JSONL).
    this.logger?.info(`${TAG} reindexAll: TCVDB uses server-side embedding, skipping`);
    return { l1Count: 0, l0Count: 0 };
  }

  isFtsAvailable(): boolean {
    return !!this.bm25Encoder;
  }

  // ── Internal: parse search results ───────────────────────

  private _parseL1SearchResults(docArrays: Array<Array<Record<string, unknown>>>): L1SearchResult[] {
    const results: L1SearchResult[] = [];
    // hybridSearch/search returns [[doc, doc, ...]] (one array per query)
    const docs = docArrays?.[0] ?? [];
    for (const doc of docs) {
      results.push({
        record_id: String(doc.id ?? ""),
        content: String(doc.text ?? ""),
        type: String(doc.type ?? ""),
        priority: Number(doc.priority ?? 0),
        scene_name: String(doc.scene_name ?? ""),
        score: Number(doc.score ?? 0),
        timestamp_str: String(doc.timestamp_str ?? ""),
        timestamp_start: String(doc.timestamp_start ?? ""),
        timestamp_end: String(doc.timestamp_end ?? ""),
        session_key: String(doc.session_key ?? ""),
        session_id: String(doc.session_id ?? ""),
        metadata_json: String(doc.metadata_json ?? "{}"),
      });
    }
    return results;
  }

  private _parseL0SearchResults(docArrays: Array<Array<Record<string, unknown>>>): L0SearchResult[] {
    const results: L0SearchResult[] = [];
    const docs = docArrays?.[0] ?? [];
    for (const doc of docs) {
      results.push({
        record_id: String(doc.id ?? ""),
        session_key: String(doc.session_key ?? ""),
        session_id: String(doc.session_id ?? ""),
        role: String(doc.role ?? ""),
        message_text: String(doc.message_text ?? ""),
        score: Number(doc.score ?? 0),
        recorded_at: epochMsToIso(Number(doc.recorded_at_ms ?? 0)),
        timestamp: Number(doc.timestamp ?? 0),
      });
    }
    return results;
  }
}

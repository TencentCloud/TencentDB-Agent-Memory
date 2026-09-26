/**
 * TcvdbMemoryStore: Tencent Cloud VectorDB backend implementing IMemoryStore.
 *
 * Features:
 * - Optional server-side dense embedding (embeddingItems via Collection embedding config)
 * - Client-side sparse vectors (BM25 local encoder; can run BM25-only without dense embedding)
 * - Native hybridSearch (dense + sparse + RRFRerank) when dense embedding is enabled
 * - Filter expressions for scalar field queries
 * - Time fields stored as uint64 epoch ms (ISO ↔ epoch conversion internal)
 *
 * All methods are fault-tolerant: return empty/false on error, never throw —
 * except appendMemoryEvent, which rethrows after logging so the ledger writer
 * can count the failure and leave the event for outbox backfill.
 */

import type { MemoryRecord } from "../../record/l1-writer.js";
import type { EmbeddingProviderInfo } from "../embedding.js";
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
  L0PaginatedFilter,
  L0PaginatedResult,
  L0CountFilter,
  L1CountFilter,
  L1PaginatedFilter,
  L1PaginatedResult,
  ProfileFilter,
  IsolationFilter,
  L0Record,
  AuditEntry,
  AuditQueryFilter,
  MemoryEvent,
  MemoryEventFilter,
  MemoryEventRedactFilter,
  KnowledgeEntity,
  KnowledgeType,
  KnowledgeListResult,
  BatchDeleteResult,
  MemoryContentClearFilter,
  MemoryContentClearResult,
} from "../types.js";
import { DEFAULT_ISOLATION_ID } from "../types.js";
import { TcvdbClient, TcvdbApiError } from "./client.js";
import { canonEventBound, canonIsoTs, canonRecordTs, healIsoId, isValidRedactFilter, newMemoryEventId } from "../memory-event-id.js";
import type { BM25LocalEncoder } from "../bm25-local.js";
import type { SparseVector } from "@tencentdb-agent-memory/tcvdb-text";
import type {
  MemoryPromptListFilter,
  MemoryPromptRecord,
  MemoryPromptSettingListFilter,
  MemoryPromptSettingLogFilter,
  MemoryPromptSettingLogRecord,
  MemoryPromptSettingRecord,
  MemoryPromptTargetType,
} from "../../memory-prompt/types.js";
import {
  buildMemoryGenerationRefId,
  type MemoryGenerationLayer,
  type MemoryGenerationRefRecord,
} from "../../memory-generation-log/types.js";

// ============================
// Config & Constants
// ============================

export interface TcvdbMemoryStoreConfig {
  url: string;
  username: string;
  apiKey: string;
  database: string;
  /** Enable VectorDB server-side dense embedding/vector index. Default false: BM25 sparse-only. */
  embeddingEnabled?: boolean;
  embeddingModel: string;
  timeout: number;
  /** Path to CA certificate PEM file (for HTTPS connections) */
  caPemPath?: string;
  logger?: StoreLogger;
  bm25Encoder?: BM25LocalEncoder;
}

const TAG = "[memory-tdai][tcvdb]";

/** Base collection suffixes (prefixed with database name at construction time). */
const L1_COLLECTION_SUFFIX = "l1_memories";
const L0_COLLECTION_SUFFIX = "l0_conversations";
const PROFILES_COLLECTION_SUFFIX = "profiles";
const AUDIT_COLLECTION_SUFFIX = "memory_audit";
const MEMORY_EVENTS_COLLECTION_SUFFIX = "memory_events";
/** entity_knowledge 明细注册表（见 docs/design/vdb-knowledge-collection.md）。 */
const KNOWLEDGE_COLLECTION_SUFFIX = "knowledge";
const MEMORY_PROMPTS_COLLECTION_SUFFIX = "memory_prompts";
const MEMORY_PROMPT_SETTINGS_COLLECTION_SUFFIX = "memory_prompt_settings";
const MEMORY_PROMPT_SETTING_LOGS_COLLECTION_SUFFIX = "memory_prompt_setting_logs";
const MEMORY_GENERATION_REFS_COLLECTION_SUFFIX = "memory_generation_refs";

const MEMORY_GENERATION_REF_OUTPUT_FIELDS = [
  "id", "layer", "memory_id", "generation_id", "generation_log_id", "generation_log_key",
  "memory_prompt_id", "memory_prompt_version", "memory_prompt_source", "created_at_ms",
];

const MEMORY_PROMPT_OUTPUT_FIELDS = [
  "id", "name", "layer", "prompt", "version", "status",
  "created_by", "updated_by", "created_at_ms", "updated_at_ms",
];
const MEMORY_PROMPT_SETTING_OUTPUT_FIELDS = [
  "id", "target_type", "team_id", "agent_id", "layer",
  "memory_prompt_id", "updated_by", "updated_at_ms",
];
const MEMORY_PROMPT_SETTING_LOG_OUTPUT_FIELDS = [
  "id", "target_type", "team_id", "agent_id", "layer", "action", "reason",
  "before_memory_prompt_id", "after_memory_prompt_id", "operator_id", "operated_at_ms",
];

const KNOWLEDGE_OUTPUT_FIELDS = [
  "id", "type", "team_id", "agent_id", "name", "user_id",
  "service_url", "summary", "metadata", "created_at_ms", "updated_at_ms",
];

/**
 * Memory type 预埋字段默认值。预留给后续区分同 agent 不同记忆类型（如对话、技能、偏好等），
 * 当前所有 L1/profile 写入都填这个默认值，读路径暂不消费 memory_type 字段。
 */
const DEFAULT_MEMORY_TYPE = "default";

/** Max documents per /document/query page (VectorDB API limit). */
const QUERY_PAGE_SIZE = 100;

/** All L1 output fields returned by query/search (excludes vector/sparse_vector). */
const L1_OUTPUT_FIELDS = [
  "id", "text", "type", "priority", "scene_name",
  "team_id", "user_id", "agent_id", "session_key", "session_id", "task_id", "version", "timestamp_str", "timestamp_start",
  "timestamp_end", "metadata_json", "created_time_ms", "updated_time_ms",
];

/** All L0 output fields returned by query/search. */
const L0_OUTPUT_FIELDS = [
  "id", "message_text", "team_id", "user_id", "agent_id", "session_key", "session_id", "task_id", "role",
  "recorded_at_ms", "timestamp",
];

const PROFILE_OUTPUT_FIELDS = [
  "id", "type", "filename", "content", "content_md5", "team_id", "user_id", "agent_id",
  "version", "created_at_ms", "updated_at_ms",
];

const PROFILE_METADATA_OUTPUT_FIELDS = [
  "id", "type", "filename", "content_md5", "team_id", "user_id", "agent_id",
  "version", "created_at_ms", "updated_at_ms",
];

/** memory_audit 字段：每行一条修改事件（L1/L2/L3 的 update/delete）。 */
const AUDIT_OUTPUT_FIELDS = [
  "id", "record_id", "layer", "action",
  "team_id", "agent_id", "user_id", "task_id",
  "version", "updated_at_ms", "request_id",
];

/** memory_events 字段：统一变更账。content/supersedes/snapshot_json 体积可能大，不建 filter 索引但可输出。 */
const MEMORY_EVENTS_OUTPUT_FIELDS = [
  "id", "event_ts", "session_key", "session_id", "origin_session_id", "origin_session_key",
  "team_id", "agent_id", "user_id", "task_id",
  "op", "record_id", "content", "memory_type", "version",
  "supersedes", "superseded_by", "snapshot_json", "reviewer_id",
  "layer", "source", "request_id", "event_id",
  "reason", "target_event_id", "scope", "until",
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

function escapeFilterString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function eqFilter(field: string, value: string): string {
  return `${field} = "${escapeFilterString(value)}"`;
}

/**
 * Isolation-id match for memory_events queries/redacts: a defined value
 * heals "" → "default" (see healIsoId) and "default" matches BOTH stored
 * forms — legacy/foreign rows may carry "" while contract writes store
 * "default". Other values compare by plain equality.
 */
function isoCond(field: string, v: string | undefined): string | undefined {
  const healed = healIsoId(v);
  if (healed === undefined) return undefined;
  return healed === DEFAULT_ISOLATION_ID
    ? `(${field} = "" or ${field} = "${DEFAULT_ISOLATION_ID}")`
    : eqFilter(field, healed);
}

function buildIsolationConditions(filter?: IsolationFilter): string[] {
  const conditions: string[] = [];
  if (!filter) return conditions;
  // teamId 与 isolation.ts buildIsolationWhere 对齐：team 级隔离过滤必须最先出现，
  // 否则跨 team 的 L0/L1 记录会在 search/query 时漏过滤（团队记忆隔离失效）。
  if (filter.teamId !== undefined) conditions.push(eqFilter("team_id", filter.teamId));
  if (filter.userId !== undefined) conditions.push(eqFilter("user_id", filter.userId));
  if (filter.agentId !== undefined) conditions.push(eqFilter("agent_id", filter.agentId));
  if (filter.sessionId !== undefined) conditions.push(eqFilter("session_id", filter.sessionId));
  if (filter.taskId !== undefined) conditions.push(eqFilter("task_id", filter.taskId));
  if (filter.sessionKey !== undefined) conditions.push(eqFilter("session_key", filter.sessionKey));
  return conditions;
}

function joinFilter(conditions: string[]): string | undefined {
  return conditions.length > 0 ? conditions.join(" and ") : undefined;
}

/**
 * 破坏性删除前的护栏：确认 filter 表达式非空且含所有必需的隔离字段。
 *
 * 背景：TCVDB `/document/delete` 在 filter 为空时会删掉**整个 collection**。
 * 任何按条件批量删除的调用都必须先过这一关—— 与其在生产上静默清库，
 * 不如在发请求前抛错。
 *
 * @param filter        joinFilter 的结果（可能是 undefined）
 * @param op            操作名，用于错误信息定位
 * @param requiredFields 必须出现在 filter 里的字段名（如 team_id / agent_id）
 */
function assertDeleteFilterSafe(
  filter: string | undefined,
  op: string,
  requiredFields: string[],
): void {
  if (typeof filter !== "string" || filter.trim().length === 0) {
    throw new Error(
      `[tcvdb] refusing ${op}: empty delete filter would wipe the whole collection`,
    );
  }
  for (const field of requiredFields) {
    if (!filter.includes(`${field} = "`)) {
      throw new Error(
        `[tcvdb] refusing ${op}: delete filter missing required scope field "${field}"`,
      );
    }
  }
}

// ============================
// TcvdbMemoryStore
// ============================

export class TcvdbMemoryStore implements IMemoryStore {
  private readonly client: TcvdbClient;
  private readonly embeddingEnabled: boolean;
  private readonly embeddingModel: string;
  private readonly logger?: StoreLogger;
  private readonly bm25Encoder?: BM25LocalEncoder;
  private readonly l1Collection: string;
  private readonly l0Collection: string;
  private readonly profilesCollection: string;
  private readonly auditCollection: string;
  private readonly eventsCollection: string;
  private readonly knowledgeCollection: string;
  private readonly memoryPromptsCollection: string;
  private readonly memoryPromptSettingsCollection: string;
  private readonly memoryPromptSettingLogsCollection: string;
  private readonly memoryGenerationRefsCollection: string;
  private degraded = false;
  private _warnedNoInit = false;

  /** Promise that resolves when async init completes. */
  private _initPromise: Promise<void> | undefined;

  constructor(config: TcvdbMemoryStoreConfig) {
    this.client = new TcvdbClient(Object.fromEntries([
      ["url", config.url],
      ["username", config.username],
      ["apiKey", config.apiKey],
      ["database", config.database],
      ["timeout", config.timeout],
      ["caPemPath", config.caPemPath],
    ]) as ConstructorParameters<typeof TcvdbClient>[0], config.logger);
    this.embeddingEnabled = config.embeddingEnabled === true;
    this.embeddingModel = config.embeddingModel;
    this.logger = config.logger;
    this.bm25Encoder = config.bm25Encoder;

    // Collection names are globally unique within a TCVDB instance,
    // so prefix with database name to avoid cross-database collisions.
    this.l1Collection = `${config.database}_${L1_COLLECTION_SUFFIX}`;
    this.l0Collection = `${config.database}_${L0_COLLECTION_SUFFIX}`;
    this.profilesCollection = `${config.database}_${PROFILES_COLLECTION_SUFFIX}`;
    this.auditCollection = `${config.database}_${AUDIT_COLLECTION_SUFFIX}`;
    this.eventsCollection = `${config.database}_${MEMORY_EVENTS_COLLECTION_SUFFIX}`;
    this.knowledgeCollection = `${config.database}_${KNOWLEDGE_COLLECTION_SUFFIX}`;
    this.memoryPromptsCollection = `${config.database}_${MEMORY_PROMPTS_COLLECTION_SUFFIX}`;
    this.memoryPromptSettingsCollection = `${config.database}_${MEMORY_PROMPT_SETTINGS_COLLECTION_SUFFIX}`;
    this.memoryPromptSettingLogsCollection = `${config.database}_${MEMORY_PROMPT_SETTING_LOGS_COLLECTION_SUFFIX}`;
    this.memoryGenerationRefsCollection = `${config.database}_${MEMORY_GENERATION_REFS_COLLECTION_SUFFIX}`;
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
      return;
    }
    // init() 只能由 store-pool 显式调用；直接 new 的 store 会跳过建表裸写。
    // 真实例上写路径会 API 报错、吞错读路径会静默空——warn 一次让误用现形。
    if (!this._warnedNoInit) {
      this._warnedNoInit = true;
      this.logger?.warn(`${TAG} store used before init() — collections were never created`);
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
   * Create a BM25 sparse collection. When embeddingEnabled=true, the dense
   * vector index uses DISK_FLAT → HNSW fallback and VDB server-side embedding.
   * When false, embedding is disabled but a dim=1 placeholder vector index is
   * still required by VDB hybridSearch; semantic signal comes from BM25 only.
   */
  private async _createCollectionWithVectorFallback(
    params: Record<string, unknown>,
    filterIndexes: Array<Record<string, unknown>>,
  ): Promise<void> {
    const buildIndexes = (vectorIndex?: Record<string, unknown>) => [
      { fieldName: "id", fieldType: "string", indexType: "primaryKey" },
      ...(vectorIndex ? [vectorIndex] : []),
      { fieldName: "sparse_vector", fieldType: "sparseVector", indexType: "inverted", metricType: "IP" },
      ...filterIndexes,
    ];

    if (!this.embeddingEnabled) {
      await this.client.createCollection({
        ...params,
        embedding: { status: "disabled" },
        indexes: buildIndexes({
          fieldName: "vector", fieldType: "vector", indexType: "FLAT",
          dimension: 1, metricType: "COSINE",
        }),
      });
      return;
    }

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
          { fieldName: "team_id",       fieldType: "string", indexType: "filter" },
          { fieldName: "user_id",         fieldType: "string", indexType: "filter" },
          { fieldName: "agent_id",        fieldType: "string", indexType: "filter" },
          { fieldName: "session_key",     fieldType: "string", indexType: "filter" },
          { fieldName: "session_id",      fieldType: "string", indexType: "filter" },
          { fieldName: "task_id",         fieldType: "string", indexType: "filter" },
          { fieldName: "version",         fieldType: "uint64", indexType: "filter" },
          { fieldName: "timestamp_start", fieldType: "string", indexType: "filter" },
          { fieldName: "timestamp_end",   fieldType: "string", indexType: "filter" },
          { fieldName: "created_time_ms", fieldType: "uint64", indexType: "filter" },
          { fieldName: "updated_time_ms", fieldType: "uint64", indexType: "filter" },
          // memory_type: 预埋字段，区分同 agent 不同记忆类型。当前一律 "default"，读路径暂不消费
          { fieldName: "memory_type",     fieldType: "string", indexType: "filter" },
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
          { fieldName: "team_id",        fieldType: "string", indexType: "filter" },
          { fieldName: "user_id",        fieldType: "string", indexType: "filter" },
          { fieldName: "agent_id",       fieldType: "string", indexType: "filter" },
          { fieldName: "session_key",    fieldType: "string", indexType: "filter" },
          { fieldName: "session_id",     fieldType: "string", indexType: "filter" },
          { fieldName: "task_id",        fieldType: "string", indexType: "filter" },
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
          { fieldName: "team_id",       fieldType: "string", indexType: "filter" },
          { fieldName: "user_id",       fieldType: "string", indexType: "filter" },
          { fieldName: "agent_id",      fieldType: "string", indexType: "filter" },
          { fieldName: "created_at_ms", fieldType: "uint64", indexType: "filter" },
          { fieldName: "updated_at_ms", fieldType: "uint64", indexType: "filter" },
          { fieldName: "version",       fieldType: "uint64", indexType: "filter" },
          // memory_type: 预埋字段，区分同 agent 不同记忆类型。当前一律 "default"，读路径暂不消费
          { fieldName: "memory_type",   fieldType: "string", indexType: "filter" },
        ],
      });

      // memory_audit collection — 修改审计事件流（L1/L2/L3 update/delete）
      // 不需向量检索，固定 dim=1 占位；所有过滤字段建 filter 索引便于查询
      await this.client.createCollection({
        collection: this.auditCollection,
        shardNum: 1,
        replicaNum: 2,
        description: "Memory 修改审计：L1/L2/L3 update/delete 事件流",
        embedding: { status: "disabled" },
        indexes: [
          { fieldName: "id",            fieldType: "string", indexType: "primaryKey" },
          { fieldName: "vector",        fieldType: "vector", indexType: "FLAT",
            dimension: 1, metricType: "COSINE" },
          { fieldName: "record_id",     fieldType: "string", indexType: "filter" },
          { fieldName: "layer",         fieldType: "string", indexType: "filter" },
          { fieldName: "action",        fieldType: "string", indexType: "filter" },
          { fieldName: "team_id",       fieldType: "string", indexType: "filter" },
          { fieldName: "agent_id",      fieldType: "string", indexType: "filter" },
          { fieldName: "user_id",       fieldType: "string", indexType: "filter" },
          { fieldName: "task_id",       fieldType: "string", indexType: "filter" },
          { fieldName: "version",       fieldType: "uint64", indexType: "filter" },
          { fieldName: "updated_at_ms", fieldType: "uint64", indexType: "filter" },
        ],
      });

      // memory_events collection — 统一变更账（extraction / api_mutation / review）
      // dim=1 占位（不需向量检索）；过滤字段建 filter 索引。
      // content/supersedes/snapshot_json 体积可能大，存普通字段不建索引。
      await this.client.createCollection({
        collection: this.eventsCollection,
        shardNum: 1,
        replicaNum: 2,
        description: "Memory 统一变更事件流（含 session diff / 审阅驳回 / 管理 mutation）",
        embedding: { status: "disabled" },
        indexes: [
          { fieldName: "id",                 fieldType: "string", indexType: "primaryKey" },
          { fieldName: "vector",             fieldType: "vector", indexType: "FLAT",
            dimension: 1, metricType: "COSINE" },
          { fieldName: "event_ts",           fieldType: "string", indexType: "filter" },
          { fieldName: "session_id",         fieldType: "string", indexType: "filter" },
          { fieldName: "session_key",        fieldType: "string", indexType: "filter" },
          { fieldName: "origin_session_id",  fieldType: "string", indexType: "filter" },
          { fieldName: "origin_session_key", fieldType: "string", indexType: "filter" },
          { fieldName: "team_id",            fieldType: "string", indexType: "filter" },
          { fieldName: "agent_id",           fieldType: "string", indexType: "filter" },
          { fieldName: "user_id",            fieldType: "string", indexType: "filter" },
          { fieldName: "task_id",            fieldType: "string", indexType: "filter" },
          { fieldName: "op",                 fieldType: "string", indexType: "filter" },
          { fieldName: "record_id",          fieldType: "string", indexType: "filter" },
          { fieldName: "layer",              fieldType: "string", indexType: "filter" },
          { fieldName: "source",             fieldType: "string", indexType: "filter" },
          { fieldName: "request_id",         fieldType: "string", indexType: "filter" },
        ],
      });

      // knowledge_entities registry — 明细表（dim=1 占位；metadata 用 JSON 类型收类型专属字段）
      // 见 docs/design/vdb-knowledge-collection.md
      await this.client.createCollection({
        collection: this.knowledgeCollection,
        shardNum: 1,
        replicaNum: 2,
        description: "Knowledge entity metadata registry",
        embedding: { status: "disabled" },
        indexes: [
          { fieldName: "id",            fieldType: "string", indexType: "primaryKey" },
          { fieldName: "vector",        fieldType: "vector", indexType: "FLAT",
            dimension: 1, metricType: "COSINE" },
          { fieldName: "type",          fieldType: "string", indexType: "filter" },
          { fieldName: "team_id",       fieldType: "string", indexType: "filter" },
          { fieldName: "agent_id",      fieldType: "string", indexType: "filter" },
          { fieldName: "name",          fieldType: "string", indexType: "filter" },
          { fieldName: "user_id",       fieldType: "string", indexType: "filter" },
          { fieldName: "metadata",      fieldType: "json",   indexType: "filter" },
          { fieldName: "created_at_ms", fieldType: "uint64", indexType: "filter" },
          { fieldName: "updated_at_ms", fieldType: "uint64", indexType: "filter" },
        ],
      });

      const scalarCollection = async (
        collection: string,
        description: string,
        filterIndexes: Array<Record<string, unknown>>,
      ) => this.client.createCollection({
        collection,
        shardNum: 1,
        replicaNum: 2,
        description,
        embedding: { status: "disabled" },
        indexes: [
          { fieldName: "id", fieldType: "string", indexType: "primaryKey" },
          { fieldName: "vector", fieldType: "vector", indexType: "FLAT", dimension: 1, metricType: "COSINE" },
          ...filterIndexes,
        ],
      });

      await scalarCollection(this.memoryPromptsCollection, "Memory custom prompts", [
        { fieldName: "layer", fieldType: "string", indexType: "filter" },
        { fieldName: "status", fieldType: "string", indexType: "filter" },
        { fieldName: "version", fieldType: "uint64", indexType: "filter" },
        { fieldName: "updated_at_ms", fieldType: "uint64", indexType: "filter" },
      ]);
      await scalarCollection(this.memoryPromptSettingsCollection, "Memory prompt target settings", [
        { fieldName: "target_type", fieldType: "string", indexType: "filter" },
        { fieldName: "team_id", fieldType: "string", indexType: "filter" },
        { fieldName: "agent_id", fieldType: "string", indexType: "filter" },
        { fieldName: "layer", fieldType: "string", indexType: "filter" },
        { fieldName: "memory_prompt_id", fieldType: "string", indexType: "filter" },
        { fieldName: "updated_at_ms", fieldType: "uint64", indexType: "filter" },
      ]);
      await scalarCollection(this.memoryPromptSettingLogsCollection, "Memory prompt setting history", [
        { fieldName: "target_type", fieldType: "string", indexType: "filter" },
        { fieldName: "team_id", fieldType: "string", indexType: "filter" },
        { fieldName: "agent_id", fieldType: "string", indexType: "filter" },
        { fieldName: "layer", fieldType: "string", indexType: "filter" },
        { fieldName: "action", fieldType: "string", indexType: "filter" },
        { fieldName: "before_memory_prompt_id", fieldType: "string", indexType: "filter" },
        { fieldName: "after_memory_prompt_id", fieldType: "string", indexType: "filter" },
        { fieldName: "operated_at_ms", fieldType: "uint64", indexType: "filter" },
      ]);
      await scalarCollection(this.memoryGenerationRefsCollection, "Memory generation provenance references", [
        { fieldName: "layer", fieldType: "string", indexType: "filter" },
        { fieldName: "memory_id", fieldType: "string", indexType: "filter" },
        { fieldName: "generation_id", fieldType: "string", indexType: "filter" },
        { fieldName: "generation_log_id", fieldType: "string", indexType: "filter" },
        { fieldName: "memory_prompt_id", fieldType: "string", indexType: "filter" },
        { fieldName: "created_at_ms", fieldType: "uint64", indexType: "filter" },
      ]);

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
      vectorSearch: this.embeddingEnabled,
      ftsSearch: hasBm25,
      nativeHybridSearch: this.embeddingEnabled && hasBm25,
      sparseVectors: hasBm25,
      profileRows: true,
    };
  }

  close(): void {
    // HTTP client — nothing to close
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
    // VDB resolves sort ties arbitrarily per request — a tie spanning an
    // internal page boundary can return the same doc twice. Dedupe by doc id.
    const seenIds = new Set<string>();
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
      for (const d of docs) {
        const id = String(d.id ?? "");
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        allDocs.push(d);
      }

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
    if (this.degraded) throw new Error("L1 upsert rejected: tcvdb store is degraded");
    // created_time/updated_time feed the _ms TTL/cursor compares — canonical
    // instants or the "" sentinel only (same contract as sqlite/mongo).
    if (canonRecordTs(record.createdAt) === null || canonRecordTs(record.updatedAt) === null) {
      throw new Error(
        `timestamps outside the instant contract (createdAt="${record.createdAt}" updatedAt="${record.updatedAt}")`,
      );
    }

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
      team_id: record.teamId ?? "",
      user_id: record.userId ?? "",
      agent_id: record.agentId ?? "",
      version: record.version ?? 0,
      session_key: record.sessionKey,
      session_id: record.sessionId,
      task_id: record.taskId ?? "",
      timestamp_str: tsStr,
      timestamp_start: tsStart,
      timestamp_end: tsEnd,
      created_time_ms: isoToEpochMs(record.createdAt),
      updated_time_ms: isoToEpochMs(record.updatedAt),
      metadata_json: JSON.stringify(record.metadata),
      memory_type: DEFAULT_MEMORY_TYPE,
    };
    if (!this.embeddingEnabled) doc.vector = [1];

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

      const ok = records.filter((record) => {
        if (canonRecordTs(record.createdAt) === null || canonRecordTs(record.updatedAt) === null) {
          this.logger?.warn?.(
            `${TAG} [L1-batch] SKIPPED id=${record.id}: timestamps outside the instant contract`,
          );
          return false;
        }
        return true;
      });
      if (ok.length === 0) return 0;

      const docs = ok.map((record) => {
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
          team_id: record.teamId ?? "",
          user_id: record.userId ?? "",
          agent_id: record.agentId ?? "",
          version: record.version ?? 0,
          session_key: record.sessionKey,
          session_id: record.sessionId,
          task_id: record.taskId ?? "",
          timestamp_str: tsStr,
          timestamp_start: tsStart,
          timestamp_end: tsEnd,
          created_time_ms: isoToEpochMs(record.createdAt),
          updated_time_ms: isoToEpochMs(record.updatedAt),
          metadata_json: JSON.stringify(record.metadata),
          memory_type: DEFAULT_MEMORY_TYPE,
        };
        if (!this.embeddingEnabled) doc.vector = [1];

        if (this.bm25Encoder) {
          const sparse = this.bm25Encoder.encodeTexts([record.content]);
          if (sparse.length > 0 && sparse[0].length > 0) {
            doc.sparse_vector = sparse[0];
          }
        }
        return doc;
      });

      await this.client.upsert(this.l1Collection, docs);
      return docs.length;
    } catch (err) {
      this.logger?.warn(`${TAG} [L1-upsertBatch] FAILED (${records.length} records): ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  async deleteL1(recordId: string, filter?: IsolationFilter): Promise<boolean> {
    try {
      await this._ensureInit();
      if (this.degraded) return false;
      // Same as deleteL0: the isolation filter must reach the backend — a bare
      // documentIds delete would let one tenant remove another's row.
      const filterExpr = joinFilter(buildIsolationConditions(filter));
      const query: Record<string, unknown> = { documentIds: [recordId] };
      if (filterExpr) query.filter = filterExpr;
      const affected = await this.client.deleteDoc(this.l1Collection, {
        query,
      });
      return affected > 0;
    } catch (err) {
      this.logger?.warn(`${TAG} [L1-delete] FAILED id=${recordId}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async deleteL1Batch(recordIds: string[], filter?: IsolationFilter): Promise<boolean> {
    if (recordIds.length === 0) return true;
    try {
      await this._ensureInit();
      if (this.degraded) return false;
      const filterExpr = joinFilter(buildIsolationConditions(filter));
      const query: Record<string, unknown> = { documentIds: recordIds };
      if (filterExpr) query.filter = filterExpr;
      await this.client.deleteDoc(this.l1Collection, {
        query,
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

      // `_ms > 0` mirrors sqlite's `updated_time != ''`: an absent timestamp
      // (stored as 0) is an immortal sentinel, not "expired since epoch".
      const filter = `updated_time_ms > 0 and updated_time_ms < ${cutoffMs}`;
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

  async countL1(filter?: L1CountFilter): Promise<number> {
    try {
      await this._ensureInit();
      if (this.degraded) return 0;
      const conditions: string[] = [];
      if (filter?.type) conditions.push(eqFilter("type", filter.type));
      conditions.push(...buildIsolationConditions({
        teamId: filter?.teamId,
        userId: filter?.userId,
        agentId: filter?.agentId,
        sessionId: filter?.sessionId,
        taskId: filter?.taskId,
      }));
      if (filter?.timeStart) {
        const ms = isoToEpochMs(filter.timeStart);
        if (ms > 0) conditions.push(`updated_time_ms >= ${ms}`);
      }
      if (filter?.timeEnd) {
        const ms = isoToEpochMs(filter.timeEnd);
        if (ms > 0) conditions.push(`updated_time_ms <= ${ms}`);
      }
      return await this.client.count(this.l1Collection, joinFilter(conditions));
    } catch (err) {
      this.logger?.warn(`${TAG} [L1-count] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  async queryL1Records(filter?: L1QueryFilter, opts?: { strict?: boolean }): Promise<L1RecordRow[]> {
    try {
      await this._ensureInit();
      if (this.degraded) {
        if (opts?.strict) throw new Error("L1 query rejected: tcvdb store is degraded");
        return [];
      }

      // Build filter expression
      const conditions = buildIsolationConditions(filter);
      if (filter?.updatedAfter) {
        const afterMs = isoToEpochMs(filter.updatedAfter);
        if (afterMs > 0) conditions.push(`updated_time_ms > ${afterMs}`);
      }
      const filterExpr = joinFilter(conditions);

      // Primary key lookup: use documentIds (fast, no full scan)
      if (filter?.recordIds && filter.recordIds.length > 0) {
        const queryParams: Record<string, unknown> = {
          retrieveVector: false,
          documentIds: filter.recordIds,
          outputFields: L1_OUTPUT_FIELDS,
        };
        if (filterExpr) queryParams.filter = filterExpr;
        const resp = await this.client.query(this.l1Collection, queryParams);
        const docs = resp.documents ?? [];
        return docs.map((doc: Record<string, unknown>) => ({
          record_id: String(doc.id ?? ""),
          content: String(doc.text ?? ""),
          type: String(doc.type ?? ""),
          priority: Number(doc.priority ?? 0),
          scene_name: String(doc.scene_name ?? ""),
          session_key: String(doc.session_key ?? ""),
          session_id: String(doc.session_id ?? ""),
          task_id: String(doc.task_id ?? ""),
          team_id: String(doc.team_id ?? ""),
          user_id: String(doc.user_id ?? ""),
          agent_id: String(doc.agent_id ?? ""),
          version: Number(doc.version ?? 0),
          timestamp_str: String(doc.timestamp_str ?? ""),
          timestamp_start: String(doc.timestamp_start ?? ""),
          timestamp_end: String(doc.timestamp_end ?? ""),
          created_time: epochMsToIso(Number(doc.created_time_ms ?? 0)),
          updated_time: epochMsToIso(Number(doc.updated_time_ms ?? 0)),
          metadata_json: String(doc.metadata_json ?? "{}"),
        }));
      }

      // Full scan with optional filter

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
        task_id: String(doc.task_id ?? ""),
        team_id: String(doc.team_id ?? ""),
        user_id: String(doc.user_id ?? ""),
        agent_id: String(doc.agent_id ?? ""),
        version: Number(doc.version ?? 0),
        timestamp_str: String(doc.timestamp_str ?? ""),
        timestamp_start: String(doc.timestamp_start ?? ""),
        timestamp_end: String(doc.timestamp_end ?? ""),
        created_time: epochMsToIso(Number(doc.created_time_ms ?? 0)),
        updated_time: epochMsToIso(Number(doc.updated_time_ms ?? 0)),
        metadata_json: String(doc.metadata_json ?? "{}"),
      }));
    } catch (err) {
      this.logger?.warn(`${TAG} [L1-query] FAILED${opts?.strict ? " (strict, rethrowing)" : ""}: ${err instanceof Error ? err.message : String(err)}`);
      if (opts?.strict) throw err;
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

  async searchL1Vector(_queryEmbedding: Float32Array, topK?: number, queryText?: string, filter?: IsolationFilter): Promise<L1SearchResult[]> {
    // TCVDB uses server-side embedding — delegate to hybrid search with text
    if (queryText) {
      return this.searchL1HybridAsync({ queryText, topK, filter });
    }
    // No queryText and TCVDB can't use client embeddings directly via embeddingItems
    // Return empty — callers should pass queryText for TCVDB
    return [];
  }

  async searchL1Fts(ftsQuery: string, limit?: number, filter?: IsolationFilter): Promise<L1FtsResult[]> {
    // TCVDB has no pure FTS — use hybrid search with sparse-only path
    // The ftsQuery is raw text, use it as queryText for hybrid
    if (!ftsQuery) return [];
    const results = await this.searchL1HybridAsync({ queryText: ftsQuery, topK: limit, filter });
    // L1SearchResult and L1FtsResult have identical shapes
    return results;
  }

  async searchL1Hybrid(params: {
    query?: string;
    queryEmbedding?: Float32Array;
    sparseVector?: SparseVector;
    topK?: number;
    filter?: IsolationFilter;
  }): Promise<L1SearchResult[]> {
    const queryText = params.query;
    if (!queryText) return [];
    return this.searchL1HybridAsync({ queryText, topK: params.topK, filter: params.filter });
  }

  /**
   * Async L1 hybrid search — the real implementation.
   * Call this directly from async contexts (hooks, tools).
   */
  async searchL1HybridAsync(params: {
    queryText: string;
    topK?: number;
    filter?: IsolationFilter;
  }): Promise<L1SearchResult[]> {
    const { queryText, topK = 10, filter } = params;
    if (!queryText) return [];

    try {
      await this._ensureInit();
      if (this.degraded) return [];

      const filterExpr = joinFilter(buildIsolationConditions(filter));

      // Build search params
      const searchParams: Record<string, unknown> = {
        limit: topK,
        outputFields: L1_OUTPUT_FIELDS,
      };
      if (filterExpr) searchParams.filter = filterExpr;

      const sparse = this.bm25Encoder?.encodeQueries([queryText]) ?? [];
      const sparseVec = sparse.length > 0 && sparse[0].length > 0 ? sparse[0] : undefined;

      if (!this.embeddingEnabled) {
        if (!sparseVec) return [];
        searchParams.ann = [{ fieldName: "vector", data: [[1]], limit: topK }];
        searchParams.match = [{
          fieldName: "sparse_vector",
          data: [sparseVec],
          limit: topK,
        }];
        searchParams.rerank = { method: "rrf", k: 60 };
        const resp = await this.client.hybridSearch(this.l1Collection, searchParams);
        return this._parseL1SearchResults(resp.documents);
      }

      // ann: use embedding field name "text" for server-side embedding
      // (per SDK: AnnSearch(field_name="text", data='query string'))
      const ann = [{
        fieldName: "text",
        data: [queryText], // embeddingItems — server-side embedding
        limit: topK,
      }];

      if (sparseVec) {
        // Full hybrid: dense + sparse + RRF
        searchParams.ann = ann;
        searchParams.match = [{
          fieldName: "sparse_vector",
          data: [sparseVec], // hybridSearch wraps single sparse vector in array
          limit: topK,
        }];
        searchParams.rerank = { method: "rrf", k: 60 };

        const resp = await this.client.hybridSearch(this.l1Collection, searchParams);
        return this._parseL1SearchResults(resp.documents);
      }

      // Dense-only fallback (BM25 unavailable) — use /document/search with embeddingItems
      const denseSearch: Record<string, unknown> = {
        embeddingItems: [queryText],
        limit: topK,
        retrieveVector: false,
        outputFields: L1_OUTPUT_FIELDS,
      };
      if (filterExpr) denseSearch.filter = filterExpr;
      const resp = await this.client.search(this.l1Collection, denseSearch);
      return this._parseL1SearchResults(resp.documents);
    } catch (err) {
      this.logger?.warn(`${TAG} [L1-hybridSearch] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  // ── L0 Write Operations ──────────────────────────────────

  async upsertL0(record: L0Record, _embedding?: Float32Array): Promise<boolean> {
    try {
      await this._upsertL0Async(record);
      return true;
    } catch (err) {
      this.logger?.warn(`${TAG} [L0-upsert] FAILED id=${record.id}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private async _upsertL0Async(record: L0Record): Promise<void> {
    await this._ensureInit();
    if (this.degraded) throw new Error("L0 upsert rejected: tcvdb store is degraded");
    if (canonRecordTs(record.recordedAt) === null) {
      throw new Error(`recordedAt "${record.recordedAt}" outside the instant contract`);
    }

    const doc: Record<string, unknown> = {
      id: record.id,
      message_text: record.messageText,
      team_id: record.teamId ?? "",
      user_id: record.userId || DEFAULT_ISOLATION_ID,
      agent_id: record.agentId || DEFAULT_ISOLATION_ID,
      session_key: record.sessionKey,
      session_id: record.sessionId || DEFAULT_ISOLATION_ID,
      task_id: record.taskId ?? "",
      role: record.role,
      recorded_at_ms: isoToEpochMs(record.recordedAt),
      timestamp: record.timestamp,
    };
    if (!this.embeddingEnabled) doc.vector = [1];

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
  async upsertL0Batch(records: L0Record[]): Promise<number> {
    if (records.length === 0) return 0;
    try {
      await this._ensureInit();
      if (this.degraded) return 0;

      const ok = records.filter((record) => {
        if (canonRecordTs(record.recordedAt) === null) {
          this.logger?.warn?.(
            `${TAG} [L0-batch] SKIPPED id=${record.id}: recordedAt "${record.recordedAt}" outside the instant contract`,
          );
          return false;
        }
        return true;
      });
      if (ok.length === 0) return 0;

      const docs = ok.map((record) => {
        const doc: Record<string, unknown> = {
          id: record.id,
          message_text: record.messageText,
          team_id: record.teamId ?? "",
          user_id: record.userId || DEFAULT_ISOLATION_ID,
          agent_id: record.agentId || DEFAULT_ISOLATION_ID,
          session_key: record.sessionKey,
          session_id: record.sessionId || DEFAULT_ISOLATION_ID,
          task_id: record.taskId ?? "",
          role: record.role,
          recorded_at_ms: isoToEpochMs(record.recordedAt),
          timestamp: record.timestamp,
        };
        if (!this.embeddingEnabled) doc.vector = [1];

        if (this.bm25Encoder) {
          const sparse = this.bm25Encoder.encodeTexts([record.messageText]);
          if (sparse.length > 0 && sparse[0].length > 0) {
            doc.sparse_vector = sparse[0];
          }
        }
        return doc;
      });

      await this.client.upsert(this.l0Collection, docs);
      return docs.length;
    } catch (err) {
      this.logger?.warn(`${TAG} [L0-upsertBatch] FAILED (${records.length} records): ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  async deleteL0(recordId: string, filter?: IsolationFilter): Promise<boolean> {
    try {
      await this._ensureInit();
      if (this.degraded) return false;
      const filterExpr = joinFilter(buildIsolationConditions(filter));
      const query: Record<string, unknown> = { documentIds: [recordId] };
      if (filterExpr) query.filter = filterExpr;
      const affected = await this.client.deleteDoc(this.l0Collection, {
        query,
      });
      return affected > 0;
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

      const filter = `recorded_at_ms > 0 and recorded_at_ms < ${cutoffMs}`;
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

  async countL0(filter?: L0CountFilter): Promise<number> {
    try {
      await this._ensureInit();
      if (this.degraded) return 0;
      const conditions: string[] = [];
      if (filter?.sessionId) {
        const sid = escapeFilterString(filter.sessionId);
        conditions.push(`(session_key = "${sid}" or session_id = "${sid}")`);
      }
      conditions.push(...buildIsolationConditions({
        teamId: filter?.teamId,
        userId: filter?.userId,
        agentId: filter?.agentId,
        taskId: filter?.taskId,
      }));
      if (filter?.timeStartMs !== undefined) {
        conditions.push(`recorded_at_ms >= ${filter.timeStartMs}`);
      }
      if (filter?.timeEndMs !== undefined) {
        conditions.push(`recorded_at_ms <= ${filter.timeEndMs}`);
      }
      return await this.client.count(this.l0Collection, joinFilter(conditions));
    } catch (err) {
      this.logger?.warn(`${TAG} [L0-count] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  async queryL0ForL1(sessionKey: string, afterRecordedAtMs?: number, limit = 50): Promise<L0QueryRow[]> {
    try {
      await this._ensureInit();
      if (this.degraded) return [];

      const conditions: string[] = [eqFilter("session_key", sessionKey)];
      if (afterRecordedAtMs && afterRecordedAtMs > 0) {
        conditions.push(`recorded_at_ms > ${afterRecordedAtMs}`);
      }
      const filterExpr = conditions.join(" and ");

      // Query oldest-first (ASC) — preserves backlog ordering so callers that
      // advance a recorded_at cursor never skip older rows. See sqlite.ts
      // queryL0ForL1 for the full rationale.
      const docs = await this._queryAllDocs(
        this.l0Collection,
        filterExpr,
        L0_OUTPUT_FIELDS,
        limit,
        [{ fieldName: "recorded_at_ms", direction: "asc" }],
      );

      const rows: L0QueryRow[] = docs.map((doc) => ({
        record_id: String(doc.id ?? ""),
        session_key: String(doc.session_key ?? ""),
        // Normalize legacy/imported empty values at the Service L0 read boundary
        // so grouping, L1 writes, and L2 queries share one session identity.
        session_id: String(doc.session_id ?? "").trim() || DEFAULT_ISOLATION_ID,
        team_id: String(doc.team_id ?? ""),
        task_id: String(doc.task_id ?? ""),
        user_id: String(doc.user_id ?? ""),
        agent_id: String(doc.agent_id ?? ""),
        role: String(doc.role ?? ""),
        message_text: String(doc.message_text ?? ""),
        recorded_at: epochMsToIso(Number(doc.recorded_at_ms ?? 0)),
        timestamp: Number(doc.timestamp ?? 0),
      }));

      return rows;
    } catch (err) {
      this.logger?.warn(`${TAG} [L0-queryForL1] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async queryL0GroupedBySessionId(sessionKey: string, afterRecordedAtMs?: number, limit = 50): Promise<L0SessionGroup[]> {
    try {
      const rows = await this.queryL0ForL1(sessionKey, afterRecordedAtMs, limit);

      // Group by full isolation tuple + session_id to avoid cross-tenant merging.
      // 注意：必须把 teamId / taskId 带进 group。L2 scope (team:T|agent:A) 依赖
      // L1 record 的 teamId 正确透传；缺失会退化到 team:${userId}|... 写错位。
      const groupMap = new Map<string, L0SessionGroup>();
      for (const row of rows) {
        const sid = row.session_id || DEFAULT_ISOLATION_ID;
        const teamId = row.team_id || "";
        const userId = row.user_id || "";
        const agentId = row.agent_id || "";
        const taskId = row.task_id || "";
        const groupKey = `${teamId}\u0000${userId}\u0000${agentId}\u0000${taskId}\u0000${sid}`;
        let group = groupMap.get(groupKey);
        if (!group) {
          group = { sessionId: sid, teamId, userId, agentId, taskId, messages: [] };
          groupMap.set(groupKey, group);
        }
        group.messages.push({
          id: row.record_id,
          role: row.role,
          content: row.message_text,
          timestamp: row.timestamp,
          recordedAtMs: row.recorded_at ? Date.parse(row.recorded_at) || 0 : 0,
        });
      }

      // Convert to array, sorted by earliest message timestamp
      const groups: L0SessionGroup[] = [];
      for (const group of groupMap.values()) {
        if (group.messages.length > 0) {
          groups.push(group);
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

  async searchL0Vector(_queryEmbedding: Float32Array, topK?: number, queryText?: string, filter?: IsolationFilter): Promise<L0SearchResult[]> {
    // TCVDB uses server-side embedding — delegate to hybrid search with text
    if (queryText) {
      return this.searchL0HybridAsync({ queryText, topK, filter });
    }
    return [];
  }

  async searchL0Fts(ftsQuery: string, limit?: number, filter?: IsolationFilter): Promise<L0FtsResult[]> {
    if (!ftsQuery) return [];
    // Use hybrid search; L0SearchResult and L0FtsResult have identical shapes
    return this.searchL0HybridAsync({ queryText: ftsQuery, topK: limit, filter });
  }

  async searchL0Hybrid(params: {
    query?: string;
    queryEmbedding?: Float32Array;
    sparseVector?: SparseVector;
    topK?: number;
    filter?: IsolationFilter;
  }): Promise<L0SearchResult[]> {
    const queryText = params.query;
    if (!queryText) return [];
    return this.searchL0HybridAsync({ queryText, topK: params.topK, filter: params.filter });
  }

  /**
   * Async L0 hybrid search.
   */
  async searchL0HybridAsync(params: {
    queryText: string;
    topK?: number;
    filter?: IsolationFilter;
  }): Promise<L0SearchResult[]> {
    const { queryText, topK = 10, filter } = params;
    if (!queryText) return [];

    try {
      await this._ensureInit();
      if (this.degraded) return [];

      const filterExpr = joinFilter(buildIsolationConditions(filter));

      const searchParams: Record<string, unknown> = {
        limit: topK,
        outputFields: L0_OUTPUT_FIELDS,
      };
      if (filterExpr) searchParams.filter = filterExpr;

      const sparse = this.bm25Encoder?.encodeQueries([queryText]) ?? [];
      const sparseVec = sparse.length > 0 && sparse[0].length > 0 ? sparse[0] : undefined;

      if (!this.embeddingEnabled) {
        if (!sparseVec) return [];
        searchParams.ann = [{ fieldName: "vector", data: [[1]], limit: topK }];
        searchParams.match = [{
          fieldName: "sparse_vector",
          data: [sparseVec],
          limit: topK,
        }];
        searchParams.rerank = { method: "rrf", k: 60 };
        const resp = await this.client.hybridSearch(this.l0Collection, searchParams);
        return this._parseL0SearchResults(resp.documents);
      }

      // ann: use embedding field name "message_text" for L0 server-side embedding
      const ann = [{
        fieldName: "message_text",
        data: [queryText],
        limit: topK,
      }];

      if (sparseVec) {
        searchParams.ann = ann;
        searchParams.match = [{
          fieldName: "sparse_vector",
          data: [sparseVec],
          limit: topK,
        }];
        searchParams.rerank = { method: "rrf", k: 60 };
        const resp = await this.client.hybridSearch(this.l0Collection, searchParams);
        return this._parseL0SearchResults(resp.documents);
      }

      const denseSearch: Record<string, unknown> = {
        embeddingItems: [queryText],
        limit: topK,
        retrieveVector: false,
        outputFields: L0_OUTPUT_FIELDS,
      };
      if (filterExpr) denseSearch.filter = filterExpr;
      const resp = await this.client.search(this.l0Collection, denseSearch);
      return this._parseL0SearchResults(resp.documents);
    } catch (err) {
      this.logger?.warn(`${TAG} [L0-hybridSearch] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** Map a raw profiles-collection document to a {@link ProfileRecord}. */
  private _docToProfile(doc: Record<string, unknown>): ProfileRecord {
    return {
      id: String(doc.id ?? ""),
      type: doc.type === "l3" ? "l3" : "l2",
      filename: String(doc.filename ?? ""),
      content: String(doc.content ?? ""),
      contentMd5: String(doc.content_md5 ?? ""),
      teamId: String(doc.team_id ?? "") || undefined,
      agentId: String(doc.agent_id ?? "") || undefined,
      userId: String(doc.user_id ?? "") || undefined,
      sessionId: undefined,
      version: Number(doc.version ?? 0),
      createdAtMs: Number(doc.created_at_ms ?? 0),
      updatedAtMs: Number(doc.updated_at_ms ?? 0),
    };
  }

  /**
   * Scope conditions for a {@link ProfileFilter} (D10).
   *
   * `pathPrefix` is deliberately excluded: TCVDB's filter language has no
   * prefix operator, so callers post-filter on `filename` in JS.
   */
  private _profileFilterExpr(filter?: ProfileFilter): string | undefined {
    const conditions: string[] = [];
    if (filter?.type) conditions.push(eqFilter("type", filter.type));
    if (filter?.teamId !== undefined) conditions.push(eqFilter("team_id", filter.teamId));
    if (filter?.userId !== undefined) conditions.push(eqFilter("user_id", filter.userId));
    if (filter?.agentId !== undefined) conditions.push(eqFilter("agent_id", filter.agentId));
    return joinFilter(conditions);
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

      return docs.map((doc) => this._docToProfile(doc));
    } catch (err) {
      this.logger?.warn(`${TAG} [profiles-pull] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async queryProfiles(filter?: ProfileFilter): Promise<ProfileRecord[]> {
    try {
      await this._ensureInit();
      if (this.degraded) return [];

      const docs = await this._queryAllDocs(
        this.profilesCollection,
        this._profileFilterExpr(filter),
        PROFILE_OUTPUT_FIELDS,
      );

      const rows = docs.map((doc) => this._docToProfile(doc));
      return filter?.pathPrefix
        ? rows.filter((r) => r.filename.startsWith(filter.pathPrefix!))
        : rows;
    } catch (err) {
      this.logger?.warn(`${TAG} [profiles-query] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async queryProfilesByIds(ids: string[]): Promise<ProfileRecord[]> {
    if (ids.length === 0) return [];
    try {
      await this._ensureInit();
      if (this.degraded) return [];

      const resp = await this.client.query(this.profilesCollection, {
        retrieveVector: false,
        documentIds: ids,
        outputFields: PROFILE_OUTPUT_FIELDS,
        limit: ids.length,
      });
      const docs = resp.documents ?? [];
      return docs.map((doc) => this._docToProfile(doc));
    } catch (err) {
      this.logger?.warn(`${TAG} [profiles-query-by-ids] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async countProfiles(filter?: ProfileFilter): Promise<number> {
    try {
      await this._ensureInit();
      if (this.degraded) return 0;
      const filterExpr = this._profileFilterExpr(filter);

      if (filter?.pathPrefix) {
        const docs = await this._queryAllDocs(
          this.profilesCollection,
          filterExpr,
          ["id", "filename"],
        );
        return docs.filter((doc) => String(doc.filename ?? "").startsWith(filter.pathPrefix!)).length;
      }

      return await this.client.count(this.profilesCollection, filterExpr);
    } catch (err) {
      this.logger?.warn(`${TAG} [profiles-count] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  async syncProfiles(records: ProfileSyncRecord[]): Promise<void> {
    if (records.length === 0) return;

    try {
      await this._ensureInit();
      if (this.degraded) return;

      const ids = [...new Set(records.map((record) => record.id).filter(Boolean))];
      const remoteResp = ids.length > 0
        ? await this.client.query(this.profilesCollection, {
          retrieveVector: false,
          documentIds: ids,
          outputFields: PROFILE_METADATA_OUTPUT_FIELDS,
          limit: ids.length,
        })
        : { documents: [] };
      const remoteMap = new Map(
        (remoteResp.documents ?? []).map((doc) => [String(doc.id ?? ""), doc] as const),
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
            team_id: record.teamId ?? "",
            user_id: record.userId ?? "",
            agent_id: record.agentId ?? "",
            version: record.version ?? 0,
            created_at_ms: createdAtMs,
            updated_at_ms: now,
            memory_type: DEFAULT_MEMORY_TYPE,
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
          team_id: record.teamId ?? "",
          user_id: record.userId ?? "",
          agent_id: record.agentId ?? "",
          version: currentVersion + 1,
          created_at_ms: currentCreatedAtMs,
          updated_at_ms: now,
          memory_type: DEFAULT_MEMORY_TYPE,
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

  // ── Knowledge entity (wiki / code-graph metadata) ─────────
  //
  // 明细注册表：Proxy 按 knowledge_id 联查渲染。类型专属字段（repo_url/branch…）
  // 收进 JSON 类型字段 metadata（见 docs/design/vdb-knowledge-collection.md）。

  private _knowledgeToDoc(e: Omit<KnowledgeEntity, "created_at" | "updated_at">, createdAtMs: number, updatedAtMs: number): Record<string, unknown> {
    const metadata: Record<string, unknown> = {};
    if (e.repo_url !== undefined) metadata.repo_url = e.repo_url;
    if (e.branch !== undefined) metadata.branch = e.branch;
    return {
      id: e.knowledge_id,
      vector: [0],
      type: e.type,
      team_id: e.team_id,
      agent_id: e.agent_id ?? "",
      name: e.name,
      user_id: e.user_id ?? "",
      service_url: e.service_url,
      summary: e.summary ?? "",
      metadata,
      created_at_ms: createdAtMs,
      updated_at_ms: updatedAtMs,
    };
  }

  private _docToKnowledge(doc: Record<string, unknown>): KnowledgeEntity {
    const metadata = (doc.metadata ?? {}) as Record<string, unknown>;
    const repoUrl = metadata.repo_url !== undefined ? String(metadata.repo_url) : undefined;
    const branch = metadata.branch !== undefined ? String(metadata.branch) : undefined;
    return {
      knowledge_id: String(doc.id ?? ""),
      type: (doc.type as KnowledgeType) ?? "wiki",
      service_url: String(doc.service_url ?? ""),
      name: String(doc.name ?? ""),
      summary: doc.summary ? String(doc.summary) : null,
      team_id: String(doc.team_id ?? ""),
      agent_id: String(doc.agent_id ?? ""),
      user_id: doc.user_id ? String(doc.user_id) : null,
      repo_url: repoUrl,
      branch,
      created_at: epochMsToIso(Number(doc.created_at_ms ?? 0)),
      updated_at: epochMsToIso(Number(doc.updated_at_ms ?? 0)),
    };
  }

  async createKnowledge(input: Omit<KnowledgeEntity, "created_at" | "updated_at">): Promise<KnowledgeEntity> {
    await this._ensureInit();
    if (this.degraded) throw new Error("tcvdb store degraded");
    // upsert：保留已有 created_at_ms
    let createdAtMs = Date.now();
    try {
      const existing = await this.client.query(this.knowledgeCollection, {
        retrieveVector: false, documentIds: [input.knowledge_id],
        outputFields: ["id", "created_at_ms"], limit: 1,
      });
      const prev = existing.documents?.[0];
      if (prev?.created_at_ms) createdAtMs = Number(prev.created_at_ms);
    } catch { /* 视为新建 */ }
    const now = Date.now();
    const doc = this._knowledgeToDoc(input, createdAtMs, now);
    await this.client.upsert(this.knowledgeCollection, [doc]);
    return this._docToKnowledge(doc);
  }

  async getKnowledge(knowledgeId: string): Promise<KnowledgeEntity | null> {
    await this._ensureInit();
    if (this.degraded) return null;
    const resp = await this.client.query(this.knowledgeCollection, {
      retrieveVector: false, documentIds: [knowledgeId],
      outputFields: KNOWLEDGE_OUTPUT_FIELDS, limit: 1,
    });
    const doc = resp.documents?.[0];
    return doc ? this._docToKnowledge(doc) : null;
  }

  async updateKnowledge(
    knowledgeId: string,
    patch: Partial<Pick<KnowledgeEntity, "name" | "summary" | "service_url" | "repo_url" | "branch">>,
  ): Promise<KnowledgeEntity | null> {
    const current = await this.getKnowledge(knowledgeId);
    if (!current) return null;
    const merged: Omit<KnowledgeEntity, "created_at" | "updated_at"> = {
      knowledge_id: current.knowledge_id,
      type: current.type,
      service_url: patch.service_url ?? current.service_url,
      name: patch.name ?? current.name,
      summary: patch.summary !== undefined ? patch.summary : current.summary,
      team_id: current.team_id,
      agent_id: current.agent_id ?? "",
      user_id: current.user_id,
      repo_url: patch.repo_url !== undefined ? patch.repo_url : current.repo_url,
      branch: patch.branch !== undefined ? patch.branch : current.branch,
    };
    return this.createKnowledge(merged);
  }

  async deleteKnowledge(knowledgeIds: string[], teamId?: string): Promise<BatchDeleteResult> {
    await this._ensureInit();
    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    if (this.degraded) {
      for (const id of knowledgeIds) result.failed.push({ id, reason: "degraded" });
      return result;
    }
    for (const id of knowledgeIds) {
      const row = await this.getKnowledge(id);
      if (!row) { result.failed.push({ id, reason: "not_found" }); continue; }
      if (teamId && row.team_id !== teamId) { result.failed.push({ id, reason: "team_mismatch" }); continue; }
      await this.client.deleteDoc(this.knowledgeCollection, { query: { documentIds: [id] } });
      result.deleted_ids.push(id);
    }
    return result;
  }

  async listKnowledge(input: { team_id: string; type?: KnowledgeType; knowledge_ids?: string[]; limit?: number; offset?: number }): Promise<KnowledgeListResult> {
    await this._ensureInit();
    if (this.degraded) return { items: [], total: 0 };
    if (input.knowledge_ids && input.knowledge_ids.length === 0) return { items: [], total: 0 };

    if (input.knowledge_ids && input.knowledge_ids.length > 0) {
      // TCVDB primary key `id` is not a normal filter field in /document/query;
      // filtering with `id in (...)` fails with "Field Not Found:id".
      // Use documentIds for primary-key lookup, then apply team/type guards in memory
      // to preserve tenant isolation and optional type filtering.
      const resp = await this.client.query(this.knowledgeCollection, {
        retrieveVector: false,
        documentIds: input.knowledge_ids,
        outputFields: KNOWLEDGE_OUTPUT_FIELDS,
        limit: input.knowledge_ids.length,
      });
      const items = (resp.documents ?? [])
        .map((d) => this._docToKnowledge(d))
        .filter((item) => item.team_id === input.team_id)
        .filter((item) => !input.type || item.type === input.type);
      return { items, total: items.length };
    }

    const parts = [`team_id = "${escapeFilterString(input.team_id)}"`];
    if (input.type) parts.push(`type = "${escapeFilterString(input.type)}"`);
    const filter = parts.join(" and ");

    const docs = await this._queryAllDocs(
      this.knowledgeCollection,
      filter,
      KNOWLEDGE_OUTPUT_FIELDS,
      input.limit,
      [{ fieldName: "updated_at_ms", direction: "desc" }],
    );
    let items = docs.map((d) => this._docToKnowledge(d));
    // 分页（_queryAllDocs 不含 offset 语义时在此裁剪）
    const offset = Math.max(input.offset ?? 0, 0);
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 1000);
    const total = items.length;
    items = items.slice(offset, offset + limit);
    return { items, total };
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

  // ── v2 API: Paginated queries ─────────────────────────────

  async queryL0Paginated(filter: L0PaginatedFilter): Promise<L0PaginatedResult> {
    await this._ensureInit();
    if (this.degraded) return { rows: [], total: 0 };

    try {
      const conditions: string[] = [];
      if (filter.sessionId) {
        const sid = escapeFilterString(filter.sessionId);
        conditions.push(`(session_key = "${sid}" or session_id = "${sid}")`);
      }
      conditions.push(...buildIsolationConditions({
        teamId: filter.teamId,
        userId: filter.userId,
        agentId: filter.agentId,
        taskId: filter.taskId,
      }));
      if (filter.timeStartMs !== undefined) {
        conditions.push(`recorded_at_ms >= ${filter.timeStartMs}`);
      }
      if (filter.timeEndMs !== undefined) {
        conditions.push(`recorded_at_ms <= ${filter.timeEndMs}`);
      }
      const filterExpr = joinFilter(conditions);

      // Get total count
      const total = await this.client.count(this.l0Collection, filterExpr);

      // Get page
      const resp = await this.client.query(this.l0Collection, {
        retrieveVector: false,
        limit: filter.limit,
        offset: filter.offset,
        filter: filterExpr,
        outputFields: L0_OUTPUT_FIELDS,
        sort: [{ fieldName: "recorded_at_ms", direction: "desc" }],
      });
      const docs = resp.documents ?? [];

      const rows: L0QueryRow[] = docs.map((d: any) => ({
        record_id: d.id,
        session_key: d.session_key ?? "",
        session_id: d.session_id ?? "",
        team_id: d.team_id ?? "",
        task_id: d.task_id ?? "",
        user_id: d.user_id ?? "",
        agent_id: d.agent_id ?? "",
        role: d.role ?? "",
        message_text: d.message_text ?? "",
        recorded_at: d.recorded_at_ms ? new Date(d.recorded_at_ms).toISOString() : "",
        timestamp: d.timestamp ?? d.recorded_at_ms ?? 0,
      }));

      return { rows, total };
    } catch (err) {
      this.logger?.warn(`${TAG} [L0-queryPaginated] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return { rows: [], total: 0 };
    }
  }

  async queryL1Paginated(filter: L1PaginatedFilter): Promise<L1PaginatedResult> {
    await this._ensureInit();
    if (this.degraded) return { rows: [], total: 0 };

    try {
      const conditions: string[] = [];
      if (filter.type) {
        conditions.push(eqFilter("type", filter.type));
      }
      conditions.push(...buildIsolationConditions({
        teamId: filter.teamId,
        userId: filter.userId,
        agentId: filter.agentId,
        sessionId: filter.sessionId,
        taskId: filter.taskId,
      }));
      if (filter.timeStart) {
        const ms = new Date(filter.timeStart).getTime();
        conditions.push(`updated_time_ms >= ${ms}`);
      }
      if (filter.timeEnd) {
        const ms = new Date(filter.timeEnd).getTime();
        conditions.push(`updated_time_ms <= ${ms}`);
      }
      const filterExpr = joinFilter(conditions);

      // Get total count
      const total = await this.client.count(this.l1Collection, filterExpr);

      // Get page
      const resp = await this.client.query(this.l1Collection, {
        retrieveVector: false,
        limit: filter.limit,
        offset: filter.offset,
        filter: filterExpr,
        outputFields: L1_OUTPUT_FIELDS,
        sort: [{ fieldName: "updated_time_ms", direction: "desc" }],
      });
      const docs = resp.documents ?? [];

      const rows: L1RecordRow[] = docs.map((d: any) => ({
        record_id: d.id,
        content: d.text ?? "",
        type: d.type ?? "",
        priority: d.priority ?? 50,
        scene_name: d.scene_name ?? "",
        session_key: d.session_key ?? "",
        session_id: d.session_id ?? "",
        team_id: d.team_id ?? "",
        task_id: d.task_id ?? "",
        user_id: d.user_id ?? "",
        agent_id: d.agent_id ?? "",
        version: Number(d.version ?? 0),
        timestamp_str: d.timestamp_str ?? "",
        timestamp_start: d.timestamp_start ?? "",
        timestamp_end: d.timestamp_end ?? "",
        created_time: d.created_time_ms ? new Date(d.created_time_ms).toISOString() : "",
        updated_time: d.updated_time_ms ? new Date(d.updated_time_ms).toISOString() : "",
        metadata_json: d.metadata_json ?? "{}",
      }));

      return { rows, total };
    } catch (err) {
      this.logger?.warn(`${TAG} [L1-queryPaginated] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return { rows: [], total: 0 };
    }
  }

  async deleteL0BySession(sessionId: string, filter?: IsolationFilter): Promise<number> {
    // 空 sessionId 会生成 `(session_key = "" or session_id = "")` —— 这是个
    // **合法非空** filter，会把所有 session 字段为空的历史/legacy 记录删掉。
    // 空 session 不是有效的删除目标，直接拒绝，不能靠下游护栏兜。
    const sessionIdTrimmed = (sessionId ?? "").trim();
    if (!sessionIdTrimmed) {
      throw new Error("[tcvdb] deleteL0BySession requires a non-empty sessionId");
    }

    await this._ensureInit();
    if (this.degraded) return 0;
    try {
      const sid = escapeFilterString(sessionIdTrimmed);
      const conditions = [`(session_key = "${sid}" or session_id = "${sid}")`, ...buildIsolationConditions(filter)];
      const filterExpr = joinFilter(conditions);
      // 护栏：filter 为空会删掉整个 collection。这里 session 条件恒存在，
      // 但仍显式断言，防止将来重构改坏条件拼装。
      assertDeleteFilterSafe(filterExpr, "deleteL0BySession", []);
      const affected = await this.client.deleteDoc(this.l0Collection, {
        query: { filter: filterExpr },
      });
      return affected;
    } catch (err) {
      this.logger?.warn(`[tcvdb] deleteL0BySession failed: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  /**
   * 清空某个 (team, agent) 下的全部记忆内容：L0 + L1 + L2/L3 profile 行。
   * 向量与 sparse_vector 随文档一起删除，无需单独清理。
   *
   * 不触碰 meta_* 资产表：asset_id、Owner、绑定、ACL、可见性、名称全部保留。
   * 幂等：已清空的 memory 再次调用返回全 0。
   *
   * 失败语义：任一层删除失败直接抛出，由调用方标记该 memory 清空失败，
   * 避免"部分删除但报告成功"。
   */
  async clearMemoryContent(filter: MemoryContentClearFilter): Promise<MemoryContentClearResult> {
    const teamId = (filter?.teamId ?? "").trim();
    const agentId = (filter?.agentId ?? "").trim();
    if (!teamId || !agentId) {
      throw new Error("clearMemoryContent requires non-empty teamId and agentId");
    }
    const userId = filter.userId?.trim() || undefined;

    await this._ensureInit();
    if (this.degraded) return { l0Deleted: 0, l1Deleted: 0, profilesDeleted: 0 };

    // L0/L1 按 (team, agent[, user]) 过滤；不带 session 维度，覆盖该 agent 全部会话。
    const contentFilter = joinFilter(buildIsolationConditions({
      teamId,
      agentId,
      ...(userId ? { userId } : {}),
    }));
    // profiles(L2/L3) 是 team+agent 粒度（见 buildProfileIsolationScope），
    // 不按 user 收窄，否则会漏删 user_id 为空的历史 profile 行。
    const profileFilter = joinFilter([eqFilter("team_id", teamId), eqFilter("agent_id", agentId)]);

    // ⚠️ 最后一道护栏：filter 为空时VDB /document/delete 会删掉**整个
    // collection**。上面的 teamId/agentId 非空校验已能保证 filter 非空，
    // 但那是"间接"保证（依赖 buildIsolationConditions 的实现细节）。
    // 破坏性操作不能依赖间接推导，这里直接断言，任何将来的重构把
    // filter 弄空都会在发请求前炸掉，而不是静默清库。
    assertDeleteFilterSafe(contentFilter, "clearMemoryContent/content", ["team_id", "agent_id"]);
    assertDeleteFilterSafe(profileFilter, "clearMemoryContent/profiles", ["team_id", "agent_id"]);

    const l0Deleted = await this.client.deleteDoc(this.l0Collection, { query: { filter: contentFilter } });
    const l1Deleted = await this.client.deleteDoc(this.l1Collection, { query: { filter: contentFilter } });
    const profilesDeleted = await this.client.deleteDoc(this.profilesCollection, { query: { filter: profileFilter } });

    return { l0Deleted, l1Deleted, profilesDeleted };
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
        team_id: String(doc.team_id ?? ""),
        task_id: String(doc.task_id ?? ""),
        user_id: String(doc.user_id ?? ""),
        agent_id: String(doc.agent_id ?? ""),
        version: Number(doc.version ?? 0),
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
        team_id: String(doc.team_id ?? ""),
        task_id: String(doc.task_id ?? ""),
        user_id: String(doc.user_id ?? ""),
        agent_id: String(doc.agent_id ?? ""),
        role: String(doc.role ?? ""),
        message_text: String(doc.message_text ?? ""),
        score: Number(doc.score ?? 0),
        recorded_at: epochMsToIso(Number(doc.recorded_at_ms ?? 0)),
        timestamp: Number(doc.timestamp ?? 0),
      });
    }
    return results;
  }

  // ─────────────────────────────────────────────────────────
  // Memory Generation Provenance References
  // ─────────────────────────────────────────────────────────

  async upsertMemoryGenerationRefs(records: MemoryGenerationRefRecord[]): Promise<void> {
    await this._ensureInit();
    for (let offset = 0; offset < records.length; offset += 100) {
      await this.client.upsert(this.memoryGenerationRefsCollection, records.slice(offset, offset + 100).map((record) => ({
        id: record.generation_ref_id,
        vector: [0],
        layer: record.layer,
        memory_id: record.memory_id,
        generation_id: record.generation_id,
        generation_log_id: record.generation_log_id,
        generation_log_key: record.generation_log_key,
        memory_prompt_id: record.memory_prompt_id,
        memory_prompt_version: record.memory_prompt_version,
        memory_prompt_source: record.memory_prompt_source,
        created_at_ms: record.created_at_ms,
      })));
    }
  }

  async getMemoryGenerationRef(layer: MemoryGenerationLayer, memoryId: string): Promise<MemoryGenerationRefRecord | null> {
    await this._ensureInit();
    const id = buildMemoryGenerationRefId(layer, memoryId);
    const resp = await this.client.query(this.memoryGenerationRefsCollection, {
      documentIds: [id],
      retrieveVector: false,
      outputFields: MEMORY_GENERATION_REF_OUTPUT_FIELDS,
      limit: 1,
    });
    const doc = resp.documents?.[0];
    if (!doc || String(doc.memory_id ?? "") !== memoryId || doc.layer !== layer) return null;
    return {
      generation_ref_id: String(doc.id ?? ""),
      layer,
      memory_id: memoryId,
      generation_id: String(doc.generation_id ?? ""),
      generation_log_id: String(doc.generation_log_id ?? ""),
      generation_log_key: String(doc.generation_log_key ?? ""),
      memory_prompt_id: String(doc.memory_prompt_id ?? ""),
      memory_prompt_version: Number(doc.memory_prompt_version ?? 1),
      memory_prompt_source: doc.memory_prompt_source === "agent" || doc.memory_prompt_source === "team" || doc.memory_prompt_source === "instance"
        ? doc.memory_prompt_source
        : "system",
      created_at_ms: Number(doc.created_at_ms ?? 0),
    };
  }

  // ─────────────────────────────────────────────────────────
  // Custom Memory Prompt
  // ─────────────────────────────────────────────────────────

  private promptFromDoc(doc: Record<string, unknown>): MemoryPromptRecord {
    return {
      memory_prompt_id: String(doc.id ?? ""),
      name: String(doc.name ?? ""),
      layer: (doc.layer === "l2" || doc.layer === "l3" ? doc.layer : "l1"),
      prompt: String(doc.prompt ?? ""),
      version: Number(doc.version ?? 1),
      status: doc.status === "deleting" ? "deleting" : "active",
      created_by: String(doc.created_by ?? "") || undefined,
      updated_by: String(doc.updated_by ?? "") || undefined,
      created_at_ms: Number(doc.created_at_ms ?? 0),
      updated_at_ms: Number(doc.updated_at_ms ?? 0),
    };
  }

  private settingFromDoc(doc: Record<string, unknown>): MemoryPromptSettingRecord {
    return {
      setting_id: String(doc.id ?? ""),
      target_type: doc.target_type === "agent" || doc.target_type === "team" ? doc.target_type : "instance",
      team_id: String(doc.team_id ?? "") || undefined,
      agent_id: String(doc.agent_id ?? "") || undefined,
      layer: doc.layer === "l2" || doc.layer === "l3" ? doc.layer : "l1",
      memory_prompt_id: String(doc.memory_prompt_id ?? ""),
      updated_by: String(doc.updated_by ?? "") || undefined,
      updated_at_ms: Number(doc.updated_at_ms ?? 0),
    };
  }

  private promptLogFromDoc(doc: Record<string, unknown>): MemoryPromptSettingLogRecord {
    return {
      setting_log_id: String(doc.id ?? ""),
      target_type: doc.target_type === "agent" || doc.target_type === "team" ? doc.target_type : "instance",
      team_id: String(doc.team_id ?? "") || undefined,
      agent_id: String(doc.agent_id ?? "") || undefined,
      layer: doc.layer === "l2" || doc.layer === "l3" ? doc.layer : "l1",
      action: doc.action === "replace" || doc.action === "clear" ? doc.action : "apply",
      reason: doc.reason === "prompt_deleted" ? "prompt_deleted" : "explicit",
      before_memory_prompt_id: String(doc.before_memory_prompt_id ?? "") || undefined,
      after_memory_prompt_id: String(doc.after_memory_prompt_id ?? "") || undefined,
      operator_id: String(doc.operator_id ?? "") || undefined,
      operated_at_ms: Number(doc.operated_at_ms ?? 0),
    };
  }

  private promptDoc(record: MemoryPromptRecord): Record<string, unknown> {
    return {
      id: record.memory_prompt_id,
      vector: [0],
      name: record.name,
      layer: record.layer,
      prompt: record.prompt,
      version: record.version,
      status: record.status,
      created_by: record.created_by ?? "",
      updated_by: record.updated_by ?? "",
      created_at_ms: record.created_at_ms,
      updated_at_ms: record.updated_at_ms,
    };
  }

  async countMemoryPrompts(): Promise<number> {
    await this._ensureInit();
    return this.client.count(this.memoryPromptsCollection);
  }

  async createMemoryPrompt(record: MemoryPromptRecord): Promise<MemoryPromptRecord> {
    await this._ensureInit();
    await this.client.upsert(this.memoryPromptsCollection, [this.promptDoc(record)]);
    return record;
  }

  async getMemoryPrompts(ids: string[]): Promise<MemoryPromptRecord[]> {
    await this._ensureInit();
    const records: MemoryPromptRecord[] = [];
    for (let offset = 0; offset < ids.length; offset += 100) {
      const chunk = ids.slice(offset, offset + 100);
      const resp = await this.client.query(this.memoryPromptsCollection, {
        documentIds: chunk,
        retrieveVector: false,
        outputFields: MEMORY_PROMPT_OUTPUT_FIELDS,
        limit: chunk.length,
      });
      records.push(...(resp.documents ?? []).map((doc) => this.promptFromDoc(doc)));
    }
    return records;
  }

  async listMemoryPrompts(filter: MemoryPromptListFilter): Promise<MemoryPromptRecord[]> {
    await this._ensureInit();
    const conds = [eqFilter("status", "active")];
    if (filter.layer) conds.push(eqFilter("layer", filter.layer));
    const resp = await this.client.query(this.memoryPromptsCollection, {
      filter: joinFilter(conds),
      retrieveVector: false,
      outputFields: MEMORY_PROMPT_OUTPUT_FIELDS,
      limit: Math.min(Math.max(filter.limit ?? 20, 1), 100),
      offset: Math.max(filter.offset ?? 0, 0),
      sort: [{ fieldName: "updated_at_ms", direction: filter.timeOrder === "asc" ? "asc" : "desc" }],
    });
    return (resp.documents ?? []).map((doc) => this.promptFromDoc(doc));
  }

  async updateMemoryPrompt(
    id: string,
    patch: { name?: string; prompt?: string; updated_by?: string; updated_at_ms: number },
  ): Promise<MemoryPromptRecord | null> {
    const current = (await this.getMemoryPrompts([id]))[0];
    if (!current || current.status !== "active") return null;
    const sameName = patch.name === undefined || patch.name === current.name;
    const samePrompt = patch.prompt === undefined || patch.prompt === current.prompt;
    if (sameName && samePrompt) return current;

    const updated: MemoryPromptRecord = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
      updated_by: patch.updated_by,
      updated_at_ms: patch.updated_at_ms,
      version: current.version + 1,
    };
    await this.client.upsert(this.memoryPromptsCollection, [this.promptDoc(updated)]);
    return updated;
  }

  async getMemoryPromptSettings(ids: string[]): Promise<MemoryPromptSettingRecord[]> {
    await this._ensureInit();
    const records: MemoryPromptSettingRecord[] = [];
    for (let offset = 0; offset < ids.length; offset += 100) {
      const chunk = ids.slice(offset, offset + 100);
      const resp = await this.client.query(this.memoryPromptSettingsCollection, {
        documentIds: chunk,
        retrieveVector: false,
        outputFields: MEMORY_PROMPT_SETTING_OUTPUT_FIELDS,
        limit: chunk.length,
      });
      records.push(...(resp.documents ?? []).map((doc) => this.settingFromDoc(doc)));
    }
    return records;
  }

  async listMemoryPromptSettings(filter: MemoryPromptSettingListFilter): Promise<MemoryPromptSettingRecord[]> {
    await this._ensureInit();
    const conds: string[] = [];
    if (filter.memoryPromptId) conds.push(eqFilter("memory_prompt_id", filter.memoryPromptId));
    if (filter.targetType) conds.push(eqFilter("target_type", filter.targetType));
    if (filter.teamId) conds.push(eqFilter("team_id", filter.teamId));
    if (filter.agentId) conds.push(eqFilter("agent_id", filter.agentId));
    if (filter.layer) conds.push(eqFilter("layer", filter.layer));
    const resp = await this.client.query(this.memoryPromptSettingsCollection, {
      ...(conds.length > 0 ? { filter: joinFilter(conds) } : {}),
      retrieveVector: false,
      outputFields: MEMORY_PROMPT_SETTING_OUTPUT_FIELDS,
      limit: Math.min(Math.max(filter.limit ?? 20, 1), 100),
      offset: Math.max(filter.offset ?? 0, 0),
      sort: [{ fieldName: "updated_at_ms", direction: filter.timeOrder === "asc" ? "asc" : "desc" }],
    });
    return (resp.documents ?? []).map((doc) => this.settingFromDoc(doc));
  }

  private settingDoc(record: MemoryPromptSettingRecord): Record<string, unknown> {
    return {
      id: record.setting_id,
      vector: [0],
      target_type: record.target_type,
      team_id: record.team_id ?? "",
      agent_id: record.agent_id ?? "",
      layer: record.layer,
      memory_prompt_id: record.memory_prompt_id,
      updated_by: record.updated_by ?? "",
      updated_at_ms: record.updated_at_ms,
    };
  }

  private promptLogDoc(log: MemoryPromptSettingLogRecord): Record<string, unknown> {
    return {
      id: log.setting_log_id,
      vector: [0],
      target_type: log.target_type,
      team_id: log.team_id ?? "",
      agent_id: log.agent_id ?? "",
      layer: log.layer,
      action: log.action,
      reason: log.reason,
      before_memory_prompt_id: log.before_memory_prompt_id ?? "",
      after_memory_prompt_id: log.after_memory_prompt_id ?? "",
      operator_id: log.operator_id ?? "",
      operated_at_ms: log.operated_at_ms,
    };
  }

  async upsertMemoryPromptSettings(
    records: MemoryPromptSettingRecord[],
    logs: MemoryPromptSettingLogRecord[],
  ): Promise<void> {
    await this._ensureInit();
    for (let offset = 0; offset < records.length; offset += 100) {
      await this.client.upsert(
        this.memoryPromptSettingsCollection,
        records.slice(offset, offset + 100).map((record) => this.settingDoc(record)),
      );
    }
    for (let offset = 0; offset < logs.length; offset += 100) {
      await this.client.upsert(
        this.memoryPromptSettingLogsCollection,
        logs.slice(offset, offset + 100).map((log) => this.promptLogDoc(log)),
      );
    }
  }

  async clearMemoryPromptSettings(ids: string[], logs: MemoryPromptSettingLogRecord[]): Promise<void> {
    await this._ensureInit();
    for (let offset = 0; offset < ids.length; offset += 100) {
      await this.client.deleteDoc(this.memoryPromptSettingsCollection, {
        query: { documentIds: ids.slice(offset, offset + 100) },
      });
    }
    for (let offset = 0; offset < logs.length; offset += 100) {
      await this.client.upsert(
        this.memoryPromptSettingLogsCollection,
        logs.slice(offset, offset + 100).map((log) => this.promptLogDoc(log)),
      );
    }
  }

  async deleteMemoryPrompts(ids: string[], operatorId?: string): Promise<{
    deleted_prompt_ids: string[];
    cleared_settings: Record<MemoryPromptTargetType, number>;
  }> {
    await this._ensureInit();
    const prompts = await this.getMemoryPrompts(ids);
    if (prompts.length !== ids.length) {
      return { deleted_prompt_ids: [], cleared_settings: { instance: 0, team: 0, agent: 0 } };
    }

    const now = Date.now();
    await this.client.upsert(this.memoryPromptsCollection, prompts.map((prompt) => this.promptDoc({
      ...prompt,
      status: "deleting",
      updated_at_ms: now,
    })));

    const settingFilter = ids.map((id) => eqFilter("memory_prompt_id", id)).join(" or ");
    const settingDocs = await this._queryAllDocs(
      this.memoryPromptSettingsCollection,
      settingFilter,
      MEMORY_PROMPT_SETTING_OUTPUT_FIELDS,
    );
    const settings = settingDocs.map((doc) => this.settingFromDoc(doc));
    const cleared: Record<MemoryPromptTargetType, number> = { instance: 0, team: 0, agent: 0 };
    const logs = settings.map((setting): MemoryPromptSettingLogRecord => {
      cleared[setting.target_type] += 1;
      return {
        setting_log_id: `mpsl:delete:${setting.setting_id}:${setting.memory_prompt_id}`,
        target_type: setting.target_type,
        team_id: setting.team_id,
        agent_id: setting.agent_id,
        layer: setting.layer,
        action: "clear",
        reason: "prompt_deleted",
        before_memory_prompt_id: setting.memory_prompt_id,
        operator_id: operatorId,
        operated_at_ms: now,
      };
    });
    const settingIds = settings.map((setting) => setting.setting_id);
    for (let offset = 0; offset < settingIds.length; offset += 100) {
      await this.client.deleteDoc(this.memoryPromptSettingsCollection, {
        query: { documentIds: settingIds.slice(offset, offset + 100) },
      });
    }
    for (let offset = 0; offset < logs.length; offset += 100) {
      await this.client.upsert(
        this.memoryPromptSettingLogsCollection,
        logs.slice(offset, offset + 100).map((log) => this.promptLogDoc(log)),
      );
    }
    await this.client.deleteDoc(this.memoryPromptsCollection, { query: { documentIds: ids } });
    return { deleted_prompt_ids: ids, cleared_settings: cleared };
  }

  async queryMemoryPromptSettingLogs(filter: MemoryPromptSettingLogFilter): Promise<MemoryPromptSettingLogRecord[]> {
    await this._ensureInit();
    const conds: string[] = [];
    if (filter.memoryPromptId) {
      const id = escapeFilterString(filter.memoryPromptId);
      conds.push(`(before_memory_prompt_id = "${id}" or after_memory_prompt_id = "${id}")`);
    }
    if (filter.teamId) conds.push(eqFilter("team_id", filter.teamId));
    if (filter.agentId) conds.push(eqFilter("agent_id", filter.agentId));
    if (filter.action) conds.push(eqFilter("action", filter.action));
    if (filter.startTimeMs !== undefined) conds.push(`operated_at_ms >= ${filter.startTimeMs}`);
    if (filter.endTimeMs !== undefined) conds.push(`operated_at_ms <= ${filter.endTimeMs}`);
    const resp = await this.client.query(this.memoryPromptSettingLogsCollection, {
      ...(conds.length > 0 ? { filter: joinFilter(conds) } : {}),
      retrieveVector: false,
      outputFields: MEMORY_PROMPT_SETTING_LOG_OUTPUT_FIELDS,
      limit: Math.min(Math.max(filter.limit ?? 20, 1), 100),
      offset: Math.max(filter.offset ?? 0, 0),
      sort: [{ fieldName: "operated_at_ms", direction: filter.timeOrder === "asc" ? "asc" : "desc" }],
    });
    return (resp.documents ?? []).map((doc) => this.promptLogFromDoc(doc));
  }

  // ─────────────────────────────────────────────────────────
  // Memory Audit (修改审计)
  // ─────────────────────────────────────────────────────────

  async appendAudit(entry: AuditEntry): Promise<void> {
    await this._ensureInit();
    if (this.degraded) return;

    // dim=1 占位向量（audit 不需向量检索，仅用 filter 查询）
    const doc: Record<string, unknown> = {
      id:            entry.audit_id,
      vector:        [0],
      record_id:     entry.record_id,
      layer:         entry.layer,
      action:        entry.action,
      team_id:       entry.team_id ?? "",
      agent_id:      entry.agent_id ?? "",
      user_id:       entry.user_id ?? "",
      task_id:       entry.task_id ?? "",
      version:       entry.version,
      updated_at_ms: entry.updated_at_ms,
      request_id:    entry.request_id ?? "",
    };

    try {
      await this.client.upsert(this.auditCollection, [doc]);
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [audit-append] FAILED audit_id=${entry.audit_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async queryAudit(filter: AuditQueryFilter): Promise<AuditEntry[]> {
    await this._ensureInit();
    if (this.degraded) return [];

    const conds: string[] = [];
    if (filter.record_id !== undefined) conds.push(eqFilter("record_id", filter.record_id));
    if (filter.layer !== undefined)     conds.push(eqFilter("layer", filter.layer));
    if (filter.action !== undefined)    conds.push(eqFilter("action", filter.action));
    if (filter.team_id !== undefined)   conds.push(eqFilter("team_id", filter.team_id));
    if (filter.agent_id !== undefined)  conds.push(eqFilter("agent_id", filter.agent_id));
    if (filter.user_id !== undefined)   conds.push(eqFilter("user_id", filter.user_id));
    if (filter.task_id !== undefined)   conds.push(eqFilter("task_id", filter.task_id));
    if (filter.since_ms !== undefined)  conds.push(`updated_at_ms >= ${filter.since_ms}`);
    if (filter.until_ms !== undefined)  conds.push(`updated_at_ms <= ${filter.until_ms}`);

    const filterExpr = joinFilter(conds);
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000);

    try {
      const docs = await this._queryAllDocs(
        this.auditCollection,
        filterExpr,
        AUDIT_OUTPUT_FIELDS,
        limit,
        [{ fieldName: "updated_at_ms", direction: "desc" }],
      );

      return docs.map((doc) => ({
        audit_id:      String(doc.id ?? ""),
        record_id:     String(doc.record_id ?? ""),
        layer:         (doc.layer === "L1" || doc.layer === "L2" || doc.layer === "L3")
                       ? doc.layer : "L1",
        action:        (doc.action === "delete" ? "delete" : "update") as "update" | "delete",
        team_id:       String(doc.team_id ?? "") || undefined,
        agent_id:      String(doc.agent_id ?? "") || undefined,
        user_id:       String(doc.user_id ?? "") || undefined,
        task_id:       String(doc.task_id ?? "") || undefined,
        version:       Number(doc.version ?? 0),
        updated_at_ms: Number(doc.updated_at_ms ?? 0),
        request_id:    String(doc.request_id ?? "") || undefined,
      }));
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [audit-query] FAILED: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────
  // Memory events（统一变更账：extraction / api_mutation / review）
  // ─────────────────────────────────────────────────────────

  async appendMemoryEvent(event: MemoryEvent): Promise<void> {
    await this._ensureInit();
    if (this.degraded) throw new Error("memory_events append rejected: tcvdb store is degraded");

    // id = event_id：写入点生成的稳定身份（36 字符，远低于 TCVDB 文档 id
    // 上限 128）。不能拼 record_id 等业务字段——管理面 asset_id 之类的长
    // record_id 会把 id 撑过上限、upsert 被拒、事件静默丢失。upsert 对同 id
    // 整体替换是安全的：回放写进来的一定是已被 marker 骨架化的事件
    // （replayLedgerEvents 先应用 redact 标记再落库），ledger 侧的
    // appendLedgerEvent 也对已知 marker 覆盖的事件写骨架 + 补定向擦除，
    // 不存在"明文事件覆盖已擦骨架"的路径。
    // Defense-in-depth (same as sqlite/mongo): non-canonical event_ts must
    // never reach a lexical compare.
    const eventTs = canonIsoTs(event.event_ts);
    if (eventTs === null) {
      throw new Error(`memory_events append rejected: non-canonical event_ts "${event.event_ts}" event_id=${event.event_id}`);
    }
    const id = event.event_id || newMemoryEventId();
    // dim=1 占位向量（events 不需向量检索，仅用 filter 查询）
    const doc: Record<string, unknown> = {
      id,
      vector: [0],
      event_id: id,
      event_ts: eventTs,
      session_key: event.session_key,
      session_id: event.session_id,
      origin_session_id: event.origin_session_id ?? "",
      origin_session_key: event.origin_session_key ?? "",
      team_id: event.team_id ?? "",
      agent_id: event.agent_id ?? "",
      user_id: event.user_id ?? "",
      task_id: event.task_id ?? "",
      op: event.op,
      record_id: event.record_id,
      content: event.content,
      memory_type: event.memory_type ?? "",
      version: event.version ?? 0,
      supersedes: JSON.stringify(event.supersedes ?? []),
      superseded_by: event.superseded_by ?? "",
      snapshot_json: event.snapshot_json ?? "",
      reviewer_id: event.reviewer_id ?? "",
      layer: event.layer ?? "l1",
      source: event.source ?? "",
      request_id: event.request_id ?? "",
      reason: event.reason ?? "",
      target_event_id: event.target_event_id ?? "",
      scope: event.scope ?? "",
      until: event.until ?? "",
    };

    try {
      await this.client.upsert(this.eventsCollection, [doc]);
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [events-append] FAILED record_id=${event.record_id} op=${event.op}: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Surface to the ledger writer so the failure is counted (degraded
      // status) and left for outbox backfill.
      throw err;
    }
  }

  async queryMemoryEvents(filter: MemoryEventFilter): Promise<MemoryEvent[]> {
    await this._ensureInit();
    if (this.degraded) throw new Error("memory_events query rejected: tcvdb store is degraded");

    const conds: string[] = [];
    if (filter.session_id !== undefined) conds.push(eqFilter("session_id", filter.session_id));
    if (filter.session_key !== undefined) conds.push(eqFilter("session_key", filter.session_key));
    if (filter.origin_session_id !== undefined) conds.push(eqFilter("origin_session_id", filter.origin_session_id));
    if (filter.origin_session_key !== undefined) conds.push(eqFilter("origin_session_key", filter.origin_session_key));
    if (filter.record_id !== undefined) conds.push(eqFilter("record_id", filter.record_id));
    if (filter.op !== undefined) conds.push(eqFilter("op", filter.op));
    if (filter.layer !== undefined) conds.push(eqFilter("layer", filter.layer));
    if (filter.source !== undefined) conds.push(eqFilter("source", filter.source));
    if (filter.request_id !== undefined) conds.push(eqFilter("request_id", filter.request_id));
    const teamCond = isoCond("team_id", filter.team_id);
    const agentCond = isoCond("agent_id", filter.agent_id);
    const userCond = isoCond("user_id", filter.user_id);
    if (teamCond !== undefined) conds.push(teamCond);
    if (agentCond !== undefined) conds.push(agentCond);
    if (userCond !== undefined) conds.push(userCond);
    if (filter.task_id !== undefined) conds.push(eqFilter("task_id", filter.task_id));
    // event_ts 是 ISO 8601 字符串，字典序即时间序（与 sqlite 实现一致）。
    if (filter.since !== undefined) conds.push(`event_ts >= "${escapeFilterString(canonEventBound(filter.since))}"`);
    if (filter.until !== undefined) conds.push(`event_ts <= "${escapeFilterString(canonEventBound(filter.until))}"`);

    const filterExpr = joinFilter(conds);
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000);
    const offset = Math.max(filter.offset ?? 0, 0);

    try {
      // _queryAllDocs 只支持从头取 N 条；要 offset 语义就多取 offset+limit 再切片。
      const docs = await this._queryAllDocs(
        this.eventsCollection,
        filterExpr,
        MEMORY_EVENTS_OUTPUT_FIELDS,
        offset + limit,
        [{ fieldName: "event_ts", direction: filter.order === "desc" ? "desc" : "asc" }],
      );
      // TCVDB sort has no tiebreaker for equal event_ts; re-sort by the
      // unique document id so page contents are at least deterministic.
      docs.sort((a, b) => {
        const t = String(a.event_ts ?? "").localeCompare(String(b.event_ts ?? ""));
        if (t !== 0) return filter.order === "desc" ? -t : t;
        const i = String(a.id ?? "").localeCompare(String(b.id ?? ""));
        return filter.order === "desc" ? -i : i;
      });
      const page = docs.slice(offset, offset + limit);

      return page.map((doc) => {
        let supersedes: string[] = [];
        try { supersedes = JSON.parse(String(doc.supersedes ?? "[]")) as string[]; } catch { /* keep [] */ }
        return {
          event_id: String(doc.event_id ?? "") || String(doc.id ?? "") || undefined,
          event_ts: String(doc.event_ts ?? ""),
          session_key: String(doc.session_key ?? ""),
          session_id: String(doc.session_id ?? ""),
          origin_session_id: String(doc.origin_session_id ?? "") || undefined,
          origin_session_key: String(doc.origin_session_key ?? "") || undefined,
          team_id: String(doc.team_id ?? "") || undefined,
          agent_id: String(doc.agent_id ?? "") || undefined,
          user_id: String(doc.user_id ?? "") || undefined,
          task_id: String(doc.task_id ?? "") || undefined,
          op: doc.op as MemoryEvent["op"],
          record_id: String(doc.record_id ?? ""),
          content: String(doc.content ?? ""),
          memory_type: String(doc.memory_type ?? "") || undefined,
          version: Number(doc.version ?? 0),
          supersedes: supersedes.length ? supersedes : undefined,
          superseded_by: String(doc.superseded_by ?? "") || undefined,
          snapshot_json: String(doc.snapshot_json ?? "") || undefined,
          reviewer_id: String(doc.reviewer_id ?? "") || undefined,
          layer: (String(doc.layer ?? "l1") || "l1") as MemoryEvent["layer"],
          source: (String(doc.source ?? "") || undefined) as MemoryEvent["source"],
          request_id: String(doc.request_id ?? "") || undefined,
          reason: String(doc.reason ?? "") || undefined,
          target_event_id: String(doc.target_event_id ?? "") || undefined,
          scope: (String(doc.scope ?? "") || undefined) as MemoryEvent["scope"],
          until: String(doc.until ?? "") || undefined,
        };
      });
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} [events-query] FAILED: ${err instanceof Error ? err.message : String(err)}`,
      );
      // An empty list would read as "no changes" to review/revert callers.
      throw err;
    }
  }

  async redactMemoryEvents(filter: MemoryEventRedactFilter): Promise<number> {
    await this._ensureInit();
    if (this.degraded) throw new Error("memory_events redact rejected: tcvdb store is degraded");
    // event_ts 是字符串比较：非规范 until 会按字典序大面积误擦而非安全
    // 落空。与 sqlite/mongo 同一契约：毫秒精确形态归一化，其余拒绝。
    // 字段白名单与 marker 读侧共享（未知字段会被静默忽略 → 过宽擦除）。
    if (!isValidRedactFilter(filter)) return 0;
    const until = canonIsoTs(filter.until)!;
    const teamCond = isoCond("team_id", filter.team_id);
    const agentCond = isoCond("agent_id", filter.agent_id);
    const userCond = isoCond("user_id", filter.user_id);
    if (teamCond === undefined && agentCond === undefined && userCond === undefined) {
      this.logger?.warn?.(`${TAG} redactMemoryEvents without isolation filter: wipes events across ALL tenants (until=${until})`);
    }
    const conds = [`event_ts <= "${escapeFilterString(until)}"`];
    if (teamCond !== undefined) conds.push(teamCond);
    if (agentCond !== undefined) conds.push(agentCond);
    if (userCond !== undefined) conds.push(userCond);
    return this.client.update(this.eventsCollection, {
      filter: joinFilter(conds),
      update: { content: "", snapshot_json: "" },
    });
  }
}

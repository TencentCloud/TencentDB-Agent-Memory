/**
 * MongoMemoryStore — MongoDB (mongot `$search` / Lucene BM25) backend for
 * `IMemoryStore` (phase-1). Keyword-only: no dense vectors.
 *
 * Lifecycle (D2): lazy connection via a shared `MongoClientPool`; `_ensureInit`
 * connects once (in-flight deduped), creates supporting indexes, and ensures the
 * `$search` indexes, recording `searchIndexReady`. Capabilities (D9) are derived
 * from runtime state, never hardcoded.
 *
 * Error policy (D13, refined 2026-09-03): genuine runtime errors propagate
 * (fail-loud). A deployment without mongot at all is a **configuration error**
 * — the connect-time cluster probe (`MongoClientPool.getClusterProfile`)
 * throws at init, because keyword search is a hard requirement. The only
 * graceful degradation is *declared* via capability flags for **transient**
 * states — e.g. mongot present but the `$search` index not yet queryable,
 * `ftsSearch=false` and keyword search returns `[]` (the documented degraded
 * path) rather than silently mis-scoring.
 */

import type { Collection, Db, Document } from "mongodb";
import type { MongoConfig } from "../../instance-config-provider.js";
import type { MongoClientPool } from "./client-pool.js";
import type { EmbeddingProviderInfo } from "../embedding.js";
import type {
  IMemoryStore,
  StoreCapabilities,
  StoreInitResult,
  StoreLogger,
  L1SearchResult,
  L1FtsResult,
  L1RecordRow,
  L1QueryFilter,
  L1CountFilter,
  L1PaginatedFilter,
  L1PaginatedResult,
  L0SearchResult,
  L0FtsResult,
  L0QueryRow,
  L0SessionGroup,
  L0Record,
  L0CountFilter,
  L0PaginatedFilter,
  L0PaginatedResult,
  ProfileRecord,
  ProfileSyncRecord,
  ProfileFilter,
  IsolationFilter,
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
import type { MemoryRecord } from "../../record/l1-writer.js";
import { DEFAULT_ISOLATION_ID } from "../isolation.js";
import { mongoSearchScoreToScore } from "../tokenize.js";
import { COLLECTIONS } from "./collections.js";
import { canonEventBound, canonIsoTs, canonRecordTs, healIsoId, isValidRedactFilter, newMemoryEventId } from "../memory-event-id.js";
import {
  buildMemoryGenerationRefId,
  type MemoryGenerationLayer,
  type MemoryGenerationRefRecord,
} from "../../memory-generation-log/types.js";
import {
  MEMORY_SEARCH_INDEX,
  MEMORY_SEARCH_DEFINITION,
  ensureSearchIndex,
} from "./search-index.js";
import {
  type L0Doc,
  type L1Doc,
  l0RecordToDoc,
  l1RecordToDoc,
  docToL0QueryRow,
  docToL0FtsResult,
  docToL1RecordRow,
  docToL1FtsResult,
  isolationToMatch,
  isolationToSearchFilters,
  ftsQueryToSearchText,
  isoToEpochMs,
} from "./doc-mappers.js";

const TAG = "[memory-tdai][mongo]";

export interface MongoMemoryStoreOptions {
  pool: MongoClientPool;
  mongoConfig: MongoConfig;
  logger?: StoreLogger;
  /** Max wait for `$search` index to become queryable during init. Default 60s. */
  searchIndexWaitMs?: number;
}

export class MongoMemoryStore implements IMemoryStore {
  private readonly pool: MongoClientPool;
  private readonly mongoConfig: MongoConfig;
  private readonly logger?: StoreLogger;
  private readonly searchIndexWaitMs: number;

  private db: Db | null = null;
  private initPromise: Promise<void> | null = null;
  private degraded = false;
  /** Whether the `$search` (mongot) indexes are queryable. Drives ftsSearch cap. */
  private searchIndexReady = false;

  constructor(opts: MongoMemoryStoreOptions) {
    this.pool = opts.pool;
    this.mongoConfig = opts.mongoConfig;
    this.logger = opts.logger;
    this.searchIndexWaitMs = opts.searchIndexWaitMs ?? 60_000;
  }

  // ── Lifecycle ───────────────────────────────────────────

  async init(_providerInfo?: EmbeddingProviderInfo): Promise<StoreInitResult> {
    await this._ensureInit();
    // No dense vectors → embeddings never need regeneration (C2).
    return { needsReindex: false, reason: "mongodb keyword-only backend" };
  }

  private async _ensureInit(): Promise<void> {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const db = await this.pool.getDb(this.mongoConfig);
      // Connect-time cluster probe. FTS is a hard requirement of the store
      // contract (sqlite/tcvdb both ship keyword search), so a deployment
      // without mongot is a configuration error surfaced at init — not a
      // silent degradation discovered on the first search query.
      const profile = await this.pool.getClusterProfile(this.mongoConfig);
      if (!profile.mongot) {
        throw new Error(
          `${TAG} mongot ($search) unavailable: probed topology=${profile.topology} ` +
            `version=${profile.version || "?"} has no search support, but keyword search is required. ` +
            `Use mongodb-atlas-local (see docker/mongo-search) or an Atlas cluster.`,
        );
      }
      await this.ensureSupportingIndexes(db);
      await this.normalizeLegacyMemoryEvents(db);
      await this.ensureSearchIndexes(db);
      this.db = db;
      this.degraded = false;
      this.logger?.info?.(
        `${TAG} connected db=${db.databaseName} topology=${profile.topology} ` +
          `version=${profile.version || "?"} searchIndexReady=${this.searchIndexReady}`,
      );
    })().catch((err) => {
      // Fail-loud: surface the error, but allow a later retry.
      this.initPromise = null;
      this.degraded = true;
      throw err;
    });
    return this.initPromise;
  }

  /**
   * Same one-shot normalization as the sqlite store: event_ts is compared
   * lexically, so pre-contract rows (`…ssZ`, `+08:00`) are rewritten to the
   * canonical instant; unrepresentable ones are left and reported. Isolation
   * ids converge on "default". Best-effort — filters already match both id
   * forms, and a failure here must not block init.
   */
  private async normalizeLegacyMemoryEvents(db: Db): Promise<void> {
    const coll = db.collection(COLLECTIONS.MEMORY_EVENTS);
    try {
      const legacy = coll.find(
        { event_ts: { $not: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/ } } as never,
        { projection: { _id: 1, event_ts: 1 } },
      );
      let fixed = 0, bad = 0;
      for await (const d of legacy) {
        const canon = typeof d.event_ts === "string" ? canonIsoTs(d.event_ts) : null;
        if (canon === null) { bad += 1; continue; }
        await coll.updateOne({ _id: d._id }, { $set: { event_ts: canon } });
        fixed += 1;
      }
      if (fixed > 0) this.logger?.info?.(`${TAG} normalized ${fixed} legacy memory_events.event_ts docs to canonical form`);
      if (bad > 0) this.logger?.warn?.(`${TAG} ${bad} memory_events docs hold unrepresentable event_ts (left as-is)`);
      let migrated = 0;
      for (const col of ["team_id", "user_id", "agent_id"]) {
        const res = await coll.updateMany({ [col]: "" } as never, { $set: { [col]: DEFAULT_ISOLATION_ID } } as never);
        migrated += res.modifiedCount;
      }
      if (migrated > 0) this.logger?.info?.(`${TAG} normalized ${migrated} legacy memory_events isolation ids to '${DEFAULT_ISOLATION_ID}'`);
    } catch (err) {
      this.logger?.warn?.(`${TAG} memory_events normalization failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async ensureSupportingIndexes(db: Db): Promise<void> {
    await Promise.all([
      db.collection(COLLECTIONS.L0).createIndexes([
        { key: { session_key: 1, recorded_at_ms: 1 } },
        { key: { session_id: 1 } },
        { key: { team_id: 1, agent_id: 1, user_id: 1 } },
      ]),
      db.collection(COLLECTIONS.L1).createIndexes([
        { key: { updated_time_ms: 1 } },
        { key: { session_id: 1 } },
        { key: { type: 1 } },
        { key: { team_id: 1, agent_id: 1, user_id: 1 } },
      ]),
      db.collection(COLLECTIONS.PROFILES).createIndexes([
        { key: { type: 1, team_id: 1, agent_id: 1, user_id: 1 } },
      ]),
      db.collection(COLLECTIONS.AUDIT).createIndexes([
        { key: { record_id: 1 } },
        { key: { updated_at_ms: 1 } },
      ]),
      db.collection(COLLECTIONS.MEMORY_EVENTS).createIndexes([
        { key: { event_ts: 1, _id: 1 } },
        {
          key: { event_id: 1 },
          unique: true,
          partialFilterExpression: { event_id: { $type: "string", $gt: "" } },
        },
        { key: { record_id: 1 } },
        { key: { session_id: 1 } },
        { key: { team_id: 1, agent_id: 1, user_id: 1 } },
      ]),
      db.collection(COLLECTIONS.MEMORY_GENERATION_REFS).createIndexes([
        { key: { layer: 1, memory_id: 1 } },
      ]),
      db.collection(COLLECTIONS.KNOWLEDGE).createIndexes([
        { key: { team_id: 1, type: 1 } },
      ]),
    ]);
  }

  private async ensureSearchIndexes(db: Db, waitMs = this.searchIndexWaitMs): Promise<void> {
    try {
      const [l0Ready, l1Ready] = await Promise.all([
        ensureSearchIndex(db.collection(COLLECTIONS.L0), MEMORY_SEARCH_INDEX, MEMORY_SEARCH_DEFINITION, {
          waitMs,
          logger: this.logger as never,
        }),
        ensureSearchIndex(db.collection(COLLECTIONS.L1), MEMORY_SEARCH_INDEX, MEMORY_SEARCH_DEFINITION, {
          waitMs,
          logger: this.logger as never,
        }),
      ]);
      this.searchIndexReady = l0Ready && l1Ready;
    } catch (err) {
      // Deployment without mongot: declared degradation (ftsSearch=false).
      this.searchIndexReady = false;
      this.logger?.warn?.(`${TAG} $search unavailable, keyword search degraded: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Re-evaluate `$search` readiness against the live deployment and update the
   * cached `searchIndexReady` flag (which `ftsSearch`/`searchL0Fts` gate on).
   *
   * `ensureSearchIndexes` runs once at init on a possibly-empty collection, so a
   * mongot index that only becomes queryable *after* the first writes would
   * otherwise leave `searchIndexReady=false` forever (and FTS silently returns
   * `[]`). Call this after seeding data to poll the index up to `waitMs` and
   * flip the flag once it is genuinely queryable. Returns the refreshed flag.
   */
  async refreshSearchIndexReady(waitMs?: number): Promise<boolean> {
    const db = this.db ?? (await this.pool.getDb(this.mongoConfig));
    await this.ensureSearchIndexes(db, waitMs ?? this.searchIndexWaitMs);
    return this.searchIndexReady;
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  getCapabilities(): StoreCapabilities {
    // Derived from runtime state (D9), never hardcoded.
    return {
      vectorSearch: false, // keyword-only phase-1
      ftsSearch: this.searchIndexReady,
      nativeHybridSearch: false,
      sparseVectors: false,
      profileRows: true,
    };
  }

  isFtsAvailable(): boolean {
    return this.searchIndexReady;
  }

  close(): void {
    // Shared MongoClient is owned by the pool (multiple instances share it) —
    // do not close it here. The pool is closed once at process shutdown.
    this.db = null;
  }

  // ── Collection handles ──────────────────────────────────

  private async coll(name: string): Promise<Collection> {
    await this._ensureInit();
    if (!this.db) throw new Error(`${TAG} not connected`);
    return this.db.collection(name);
  }

  // ════════════════════════════════════════════════════════
  // L1 write
  // ════════════════════════════════════════════════════════

  async upsertL1(record: MemoryRecord, _embedding?: Float32Array): Promise<boolean> {
    // created_time/updated_time feed the _ms TTL/cursor compares — canonical
    // instants or the "" sentinel only (same contract as sqlite).
    const createdAt = canonRecordTs(record.createdAt);
    const updatedAt = canonRecordTs(record.updatedAt);
    if (createdAt === null || updatedAt === null) {
      this.logger?.warn?.(
        `${TAG} [L1-upsert] REJECTED id=${record.id}: timestamps outside the instant contract ` +
        `(createdAt="${record.createdAt}" updatedAt="${record.updatedAt}")`,
      );
      return false;
    }
    const coll = await this.coll(COLLECTIONS.L1);
    const doc = l1RecordToDoc({ ...record, createdAt, updatedAt });
    // Filter carries the designated shard key prefix (team_id, agent_id) so the
    // upsert stays legal if the collection is ever sharded — on a sharded
    // collection an upsert without the full shard key fails with
    // ShardKeyNotFound. Harmless on non-sharded collections (extra equality).
    await coll.replaceOne(
      { _id: doc._id, team_id: doc.team_id, agent_id: doc.agent_id } as never,
      doc as never,
      { upsert: true },
    );
    return true;
  }

  async deleteL1(recordId: string, filter?: IsolationFilter): Promise<boolean> {
    const coll = await this.coll(COLLECTIONS.L1);
    const res = await coll.deleteOne({ _id: recordId, ...isolationToMatch(filter) } as never);
    return res.deletedCount > 0;
  }

  async deleteL1Batch(recordIds: string[], filter?: IsolationFilter): Promise<boolean> {
    if (recordIds.length === 0) return true;
    const coll = await this.coll(COLLECTIONS.L1);
    await coll.deleteMany({ _id: { $in: recordIds }, ...isolationToMatch(filter) } as never);
    return true;
  }

  async deleteL1Expired(cutoffIso: string): Promise<number> {
    const cutoffMs = isoToEpochMs(cutoffIso);
    if (cutoffMs <= 0) return 0;
    const coll = await this.coll(COLLECTIONS.L1);
    // `_ms > 0` mirrors sqlite's `updated_time != ''`: an absent timestamp
    // (stored as 0) is an immortal sentinel, not "expired since epoch".
    const query = { updated_time_ms: { $gt: 0, $lt: cutoffMs } };
    const toDelete = await coll.countDocuments(query as never);
    if (toDelete === 0) return 0;
    const total = await coll.estimatedDocumentCount();
    const ratio = total > 0 ? toDelete / total : 0;
    if (ratio > 0.8) {
      this.logger?.warn?.(
        `${TAG} [L1-deleteExpired] BLOCKED: would delete ${toDelete}/${total} (${(ratio * 100).toFixed(1)}%) — exceeds 80% threshold, cutoff=${cutoffIso}`,
      );
      return 0;
    }
    const res = await coll.deleteMany(query as never);
    return res.deletedCount;
  }

  // ════════════════════════════════════════════════════════
  // L1 read
  // ════════════════════════════════════════════════════════

  async countL1(filter?: L1CountFilter): Promise<number> {
    const coll = await this.coll(COLLECTIONS.L1);
    return coll.countDocuments(this.l1CountQuery(filter) as never);
  }

  private l1CountQuery(filter?: L1CountFilter): Record<string, unknown> {
    const q: Record<string, unknown> = {};
    if (!filter) return q;
    if (filter.type !== undefined) q.type = filter.type;
    if (filter.sessionId !== undefined) q.session_id = filter.sessionId;
    if (filter.teamId !== undefined) q.team_id = filter.teamId;
    if (filter.userId !== undefined) q.user_id = filter.userId;
    if (filter.agentId !== undefined) q.agent_id = filter.agentId;
    if (filter.taskId !== undefined) q.task_id = filter.taskId;
    const range: Record<string, string> = {};
    if (filter.timeStart !== undefined) range.$gte = filter.timeStart;
    if (filter.timeEnd !== undefined) range.$lte = filter.timeEnd;
    if (Object.keys(range).length > 0) q.updated_time = range;
    return q;
  }

  async queryL1Records(filter?: L1QueryFilter): Promise<L1RecordRow[]> {
    const coll = await this.coll(COLLECTIONS.L1);
    const q: Record<string, unknown> = {};
    if (filter?.recordIds && filter.recordIds.length > 0) q._id = { $in: filter.recordIds };
    if (filter?.sessionKey !== undefined) q.session_key = filter.sessionKey;
    if (filter?.sessionId !== undefined) q.session_id = filter.sessionId;
    if (filter?.taskId !== undefined) q.task_id = filter.taskId;
    if (filter?.teamId !== undefined) q.team_id = filter.teamId;
    if (filter?.userId !== undefined) q.user_id = filter.userId;
    if (filter?.agentId !== undefined) q.agent_id = filter.agentId;
    if (filter?.updatedAfter !== undefined) q.updated_time = { $gt: filter.updatedAfter };
    const docs = await coll.find(q as never).toArray();
    return docs.map((d) => docToL1RecordRow(d as unknown as L1Doc));
  }

  async getAllL1Texts(): Promise<Array<{ record_id: string; content: string; updated_time: string }>> {
    const coll = await this.coll(COLLECTIONS.L1);
    const docs = await coll.find({}, { projection: { content: 1, updated_time: 1 } }).toArray();
    return docs.map((d) => ({
      record_id: String((d as { _id: unknown })._id),
      content: String((d as { content?: string }).content ?? ""),
      updated_time: String((d as { updated_time?: string }).updated_time ?? ""),
    }));
  }

  async queryL1Paginated(filter: L1PaginatedFilter): Promise<L1PaginatedResult> {
    const coll = await this.coll(COLLECTIONS.L1);
    const q = this.l1CountQuery(filter);
    const total = await coll.countDocuments(q as never);
    const docs = await coll
      .find(q as never)
      .sort({ updated_time_ms: -1 })
      .skip(filter.offset)
      .limit(filter.limit)
      .toArray();
    return { rows: docs.map((d) => docToL1RecordRow(d as unknown as L1Doc)), total };
  }

  // ════════════════════════════════════════════════════════
  // L1 search
  // ════════════════════════════════════════════════════════

  // No dense vectors in phase-1 → vector search is a declared no-op.
  async searchL1Vector(): Promise<L1SearchResult[]> {
    return [];
  }

  async searchL1Fts(ftsQuery: string, limit = 10, filter?: IsolationFilter): Promise<L1FtsResult[]> {
    if (!this.searchIndexReady) return [];
    const searchText = ftsQueryToSearchText(ftsQuery);
    if (!searchText) return [];
    const coll = await this.coll(COLLECTIONS.L1);
    const docs = await this.runSearch(coll, searchText, limit, filter);
    return docs.map(({ doc, score }) => docToL1FtsResult(doc as unknown as L1Doc, score));
  }

  // ════════════════════════════════════════════════════════
  // L0 write
  // ════════════════════════════════════════════════════════

  async upsertL0(record: L0Record, _embedding?: Float32Array): Promise<boolean> {
    const recordedAt = canonRecordTs(record.recordedAt);
    if (recordedAt === null) {
      this.logger?.warn?.(
        `${TAG} [L0-upsert] REJECTED id=${record.id}: recordedAt "${record.recordedAt}" outside the instant contract`,
      );
      return false;
    }
    const coll = await this.coll(COLLECTIONS.L0);
    const doc = l0RecordToDoc({ ...record, recordedAt });
    // Shard-key-safe upsert: see upsertL1.
    await coll.replaceOne(
      { _id: doc._id, team_id: doc.team_id, agent_id: doc.agent_id } as never,
      doc as never,
      { upsert: true },
    );
    return true;
  }

  /**
   * Insert a whole `/conversation/add` group in a single `insertMany`.
   *
   * These are always freshly-generated `_id`s (the add handler ignores any
   * caller-supplied id), so a plain ordered insert is correct — no upsert
   * fan-out. A duplicate `_id` (astronomically unlikely with a full UUID)
   * surfaces as an E11000 rather than silently overwriting another message;
   * ordered means docs before the clash are persisted and the rest are not,
   * matching the pre-batch "throw mid-loop" partial-success semantics (no
   * multi-document transaction).
   */
  async insertL0Batch(records: L0Record[]): Promise<number> {
    if (records.length === 0) return 0;
    const coll = await this.coll(COLLECTIONS.L0);
    const docs = records
      .map((r) => {
        const recordedAt = canonRecordTs(r.recordedAt);
        if (recordedAt === null) {
          this.logger?.warn?.(
            `${TAG} [L0-batch] SKIPPED id=${r.id}: recordedAt "${r.recordedAt}" outside the instant contract`,
          );
          return null;
        }
        return l0RecordToDoc({ ...r, recordedAt });
      })
      .filter((d): d is L0Doc => d !== null);
    if (docs.length === 0) return 0;
    const res = await coll.insertMany(docs as never[], { ordered: true });
    return res.insertedCount;
  }

  async deleteL0(recordId: string, filter?: IsolationFilter): Promise<boolean> {
    const coll = await this.coll(COLLECTIONS.L0);
    const res = await coll.deleteOne({ _id: recordId, ...isolationToMatch(filter) } as never);
    return res.deletedCount > 0;
  }

  async deleteL0Expired(cutoffIso: string): Promise<number> {
    const cutoffMs = isoToEpochMs(cutoffIso);
    if (cutoffMs <= 0) return 0;
    const coll = await this.coll(COLLECTIONS.L0);
    const query = { recorded_at_ms: { $gt: 0, $lt: cutoffMs } };
    const toDelete = await coll.countDocuments(query as never);
    if (toDelete === 0) return 0;
    const total = await coll.estimatedDocumentCount();
    const ratio = total > 0 ? toDelete / total : 0;
    if (ratio > 0.8) {
      this.logger?.warn?.(
        `${TAG} [L0-deleteExpired] BLOCKED: would delete ${toDelete}/${total} (${(ratio * 100).toFixed(1)}%) — exceeds 80% threshold, cutoff=${cutoffIso}`,
      );
      return 0;
    }
    const res = await coll.deleteMany(query as never);
    return res.deletedCount;
  }

  async deleteL0BySession(sessionId: string, filter?: IsolationFilter): Promise<number> {
    const coll = await this.coll(COLLECTIONS.L0);
    const res = await coll.deleteMany({ session_id: sessionId, ...isolationToMatch(filter) } as never);
    return res.deletedCount;
  }

  // ════════════════════════════════════════════════════════
  // L0 read
  // ════════════════════════════════════════════════════════

  async countL0(filter?: L0CountFilter): Promise<number> {
    const coll = await this.coll(COLLECTIONS.L0);
    return coll.countDocuments(this.l0CountQuery(filter) as never);
  }

  private l0CountQuery(filter?: L0CountFilter): Record<string, unknown> {
    const q: Record<string, unknown> = {};
    if (!filter) return q;
    if (filter.sessionId !== undefined) q.session_id = filter.sessionId;
    if (filter.teamId !== undefined) q.team_id = filter.teamId;
    if (filter.userId !== undefined) q.user_id = filter.userId;
    if (filter.agentId !== undefined) q.agent_id = filter.agentId;
    if (filter.taskId !== undefined) q.task_id = filter.taskId;
    const range: Record<string, number> = {};
    if (filter.timeStartMs !== undefined) range.$gte = filter.timeStartMs;
    if (filter.timeEndMs !== undefined) range.$lte = filter.timeEndMs;
    if (Object.keys(range).length > 0) q.timestamp = range;
    return q;
  }

  async queryL0ForL1(sessionKey: string, afterRecordedAtMs?: number, limit = 50): Promise<L0QueryRow[]> {
    const coll = await this.coll(COLLECTIONS.L0);
    const q: Record<string, unknown> = { session_key: sessionKey };
    if (afterRecordedAtMs && afterRecordedAtMs > 0) q.recorded_at_ms = { $gt: afterRecordedAtMs };
    const docs = await coll
      .find(q as never)
      .sort({ recorded_at_ms: 1 })
      .limit(limit)
      .toArray();
    return docs.map((d) => {
      const row = docToL0QueryRow(d as unknown as L0Doc);
      row.session_id = (row.session_id || "").trim() || DEFAULT_ISOLATION_ID;
      return row;
    });
  }

  async queryL0GroupedBySessionId(sessionKey: string, afterRecordedAtMs?: number, limit = 50): Promise<L0SessionGroup[]> {
    const rows = await this.queryL0ForL1(sessionKey, afterRecordedAtMs, limit);
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
    const groups: L0SessionGroup[] = [];
    for (const group of groupMap.values()) {
      if (group.messages.length > 0) groups.push(group);
    }
    groups.sort((a, b) => a.messages[0].timestamp - b.messages[0].timestamp);
    return groups;
  }

  async getAllL0Texts(): Promise<Array<{ record_id: string; message_text: string; recorded_at: string }>> {
    const coll = await this.coll(COLLECTIONS.L0);
    const docs = await coll.find({}, { projection: { message_text: 1, recorded_at: 1 } }).toArray();
    return docs.map((d) => ({
      record_id: String((d as { _id: unknown })._id),
      message_text: String((d as { message_text?: string }).message_text ?? ""),
      recorded_at: String((d as { recorded_at?: string }).recorded_at ?? ""),
    }));
  }

  async queryL0Paginated(filter: L0PaginatedFilter): Promise<L0PaginatedResult> {
    const coll = await this.coll(COLLECTIONS.L0);
    const q = this.l0CountQuery(filter);
    const total = await coll.countDocuments(q as never);
    const docs = await coll
      .find(q as never)
      .sort({ recorded_at_ms: -1 })
      .skip(filter.offset)
      .limit(filter.limit)
      .toArray();
    return { rows: docs.map((d) => docToL0QueryRow(d as unknown as L0Doc)), total };
  }

  // ════════════════════════════════════════════════════════
  // L0 search
  // ════════════════════════════════════════════════════════

  async searchL0Vector(): Promise<L0SearchResult[]> {
    return [];
  }

  async searchL0Fts(ftsQuery: string, limit = 10, filter?: IsolationFilter): Promise<L0FtsResult[]> {
    if (!this.searchIndexReady) return [];
    const searchText = ftsQueryToSearchText(ftsQuery);
    if (!searchText) return [];
    const coll = await this.coll(COLLECTIONS.L0);
    const docs = await this.runSearch(coll, searchText, limit, filter);
    return docs.map(({ doc, score }) => docToL0FtsResult(doc as unknown as L0Doc, score));
  }

  // ── $search runner (shared L0/L1) ──

  private async runSearch(
    coll: Collection,
    searchText: string,
    limit: number,
    filter?: IsolationFilter,
  ): Promise<Array<{ doc: Document; score: number }>> {
    const filters = isolationToSearchFilters(filter);
    const compound: Record<string, unknown> = {
      must: [{ text: { query: searchText, path: "tokens" } }],
    };
    if (filters.length > 0) compound.filter = filters;
    const pipeline: Record<string, unknown>[] = [
      { $search: { index: MEMORY_SEARCH_INDEX, compound } },
      { $limit: Math.max(1, limit) },
      { $addFields: { __searchScore: { $meta: "searchScore" } } },
    ];
    const raw = await coll.aggregate(pipeline).toArray();
    return raw.map((d) => ({
      doc: d,
      score: mongoSearchScoreToScore(Number((d as { __searchScore?: number }).__searchScore ?? 0)),
    }));
  }

  // ════════════════════════════════════════════════════════
  // Re-index (C2): re-tokenize the keyword field; no vectors to rebuild.
  // ════════════════════════════════════════════════════════

  async reindexAll(
    _embedFn: (text: string) => Promise<Float32Array>,
    onProgress?: (done: number, total: number, layer: "L1" | "L0") => void,
  ): Promise<{ l1Count: number; l0Count: number }> {
    const { tokenizeForFts } = await import("../tokenize.js");
    const l1 = await this.coll(COLLECTIONS.L1);
    const l0 = await this.coll(COLLECTIONS.L0);

    let l1Count = 0;
    const l1Total = await l1.estimatedDocumentCount();
    for await (const d of l1.find({})) {
      const doc = d as unknown as L1Doc;
      await l1.updateOne({ _id: doc._id } as never, { $set: { tokens: tokenizeForFts(doc.content) } } as never);
      l1Count++;
      onProgress?.(l1Count, l1Total, "L1");
    }

    let l0Count = 0;
    const l0Total = await l0.estimatedDocumentCount();
    for await (const d of l0.find({})) {
      const doc = d as unknown as L0Doc;
      await l0.updateOne({ _id: doc._id } as never, { $set: { tokens: tokenizeForFts(doc.message_text) } } as never);
      l0Count++;
      onProgress?.(l0Count, l0Total, "L0");
    }

    return { l1Count, l0Count };
  }

  // ════════════════════════════════════════════════════════
  // L2/L3 profiles (content inlined — mirrors VDB)
  // ════════════════════════════════════════════════════════

  async pullProfiles(): Promise<ProfileRecord[]> {
    const coll = await this.coll(COLLECTIONS.PROFILES);
    const docs = await coll.find({}).toArray();
    return docs.map((d) => this.docToProfile(d));
  }

  async queryProfilesByIds(ids: string[]): Promise<ProfileRecord[]> {
    if (ids.length === 0) return [];
    const coll = await this.coll(COLLECTIONS.PROFILES);
    const docs = await coll.find({ _id: { $in: ids } } as never).toArray();
    return docs.map((d) => this.docToProfile(d));
  }

  /** Translate a {@link ProfileFilter} into the profiles collection query (D10). */
  private profileQuery(filter?: ProfileFilter): Record<string, unknown> {
    const q: Record<string, unknown> = {};
    if (filter?.type !== undefined) q.type = filter.type;
    if (filter?.teamId !== undefined) q.team_id = filter.teamId;
    if (filter?.userId !== undefined) q.user_id = filter.userId;
    if (filter?.agentId !== undefined) q.agent_id = filter.agentId;
    if (filter?.pathPrefix) q.filename = { $regex: `^${escapeRegex(filter.pathPrefix)}` };
    return q;
  }

  async countProfiles(filter?: ProfileFilter): Promise<number> {
    const coll = await this.coll(COLLECTIONS.PROFILES);
    return coll.countDocuments(this.profileQuery(filter) as never);
  }

  async queryProfiles(filter?: ProfileFilter): Promise<ProfileRecord[]> {
    const coll = await this.coll(COLLECTIONS.PROFILES);
    const docs = await coll.find(this.profileQuery(filter) as never).toArray();
    return docs.map((d) => this.docToProfile(d));
  }

  async syncProfiles(records: ProfileSyncRecord[]): Promise<void> {
    if (records.length === 0) return;
    const coll = await this.coll(COLLECTIONS.PROFILES);
    for (const r of records) {
      const doc = {
        _id: r.id,
        type: r.type,
        filename: r.filename,
        content: r.content,
        content_md5: r.contentMd5,
        team_id: r.teamId ?? "",
        agent_id: r.agentId ?? "",
        user_id: r.userId ?? "",
        session_id: r.sessionId ?? "",
        version: r.version,
        created_at_ms: r.createdAtMs,
        updated_at_ms: r.updatedAtMs,
      };
      // Optimistic lock (baselineVersion): only overwrite when the stored
      // version matches the baseline the caller last read (or the row is new).
      if (r.baselineVersion !== undefined) {
        const res = await coll.updateOne(
          { _id: r.id, version: r.baselineVersion } as never,
          { $set: doc } as never,
          { upsert: false },
        );
        if (res.matchedCount === 0) {
          // New row (no existing doc) → insert; otherwise a concurrent writer won.
          const exists = await coll.countDocuments({ _id: r.id } as never);
          if (exists === 0) {
            await coll.insertOne(doc as never);
          } else {
            throw new Error(`${TAG} profile optimistic-lock conflict id=${r.id} baseline=${r.baselineVersion}`);
          }
        }
      } else {
        // Shard-key-safe upsert: see upsertL1.
        await coll.replaceOne(
          { _id: r.id, team_id: doc.team_id, agent_id: doc.agent_id } as never,
          doc as never,
          { upsert: true },
        );
      }
    }
  }

  async deleteProfiles(recordIds: string[]): Promise<void> {
    if (recordIds.length === 0) return;
    const coll = await this.coll(COLLECTIONS.PROFILES);
    await coll.deleteMany({ _id: { $in: recordIds } } as never);
  }

  private docToProfile(d: Record<string, unknown>): ProfileRecord {
    return {
      id: String(d._id),
      type: (d.type as "l2" | "l3") ?? "l2",
      filename: String(d.filename ?? ""),
      content: String(d.content ?? ""),
      contentMd5: String(d.content_md5 ?? ""),
      teamId: String(d.team_id ?? ""),
      agentId: String(d.agent_id ?? ""),
      userId: String(d.user_id ?? ""),
      sessionId: String(d.session_id ?? ""),
      version: Number(d.version ?? 0),
      createdAtMs: Number(d.created_at_ms ?? 0),
      updatedAtMs: Number(d.updated_at_ms ?? 0),
    };
  }

  // ════════════════════════════════════════════════════════
  // Clear memory content (strict team+agent required)
  // ════════════════════════════════════════════════════════

  async clearMemoryContent(filter: MemoryContentClearFilter): Promise<MemoryContentClearResult> {
    if (!filter.teamId || !filter.agentId) {
      throw new Error(`${TAG} clearMemoryContent requires teamId + agentId (got team=${filter.teamId}, agent=${filter.agentId})`);
    }
    const match: Record<string, string> = { team_id: filter.teamId, agent_id: filter.agentId };
    if (filter.userId !== undefined) match.user_id = filter.userId;

    const l0 = await this.coll(COLLECTIONS.L0);
    const l1 = await this.coll(COLLECTIONS.L1);
    const profiles = await this.coll(COLLECTIONS.PROFILES);

    const [l0Res, l1Res, profRes] = await Promise.all([
      l0.deleteMany(match as never),
      l1.deleteMany(match as never),
      profiles.deleteMany(match as never),
    ]);
    return {
      l0Deleted: l0Res.deletedCount,
      l1Deleted: l1Res.deletedCount,
      profilesDeleted: profRes.deletedCount,
    };
  }

  // ════════════════════════════════════════════════════════
  // Memory audit
  // ════════════════════════════════════════════════════════

  async appendAudit(entry: AuditEntry): Promise<void> {
    const coll = await this.coll(COLLECTIONS.AUDIT);
    await coll.insertOne({ ...entry, _id: entry.audit_id } as never);
  }

  async queryAudit(filter: AuditQueryFilter): Promise<AuditEntry[]> {
    const coll = await this.coll(COLLECTIONS.AUDIT);
    const q: Record<string, unknown> = {};
    if (filter.record_id !== undefined) q.record_id = filter.record_id;
    if (filter.layer !== undefined) q.layer = filter.layer;
    if (filter.action !== undefined) q.action = filter.action;
    if (filter.team_id !== undefined) q.team_id = filter.team_id;
    if (filter.agent_id !== undefined) q.agent_id = filter.agent_id;
    if (filter.user_id !== undefined) q.user_id = filter.user_id;
    if (filter.task_id !== undefined) q.task_id = filter.task_id;
    const range: Record<string, number> = {};
    if (filter.since_ms !== undefined) range.$gte = filter.since_ms;
    if (filter.until_ms !== undefined) range.$lte = filter.until_ms;
    if (Object.keys(range).length > 0) q.updated_at_ms = range;

    const limit = Math.min(filter.limit ?? 100, 1000);
    const offset = filter.offset ?? 0;
    const docs = await coll
      .find(q as never)
      .sort({ updated_at_ms: -1 })
      .skip(offset)
      .limit(limit)
      .toArray();
    return docs.map((d) => this.docToAudit(d));
  }

  private docToAudit(d: Record<string, unknown>): AuditEntry {
    return {
      audit_id: String(d.audit_id ?? d._id),
      record_id: String(d.record_id ?? ""),
      layer: d.layer as AuditEntry["layer"],
      action: d.action as AuditEntry["action"],
      team_id: d.team_id as string | undefined,
      agent_id: d.agent_id as string | undefined,
      user_id: d.user_id as string | undefined,
      task_id: d.task_id as string | undefined,
      version: Number(d.version ?? 0),
      updated_at_ms: Number(d.updated_at_ms ?? 0),
      request_id: d.request_id as string | undefined,
    };
  }

  // ════════════════════════════════════════════════════════
  // Memory generation provenance references
  // ════════════════════════════════════════════════════════

  async upsertMemoryGenerationRefs(records: MemoryGenerationRefRecord[]): Promise<void> {
    if (records.length === 0) return;
    const coll = await this.coll(COLLECTIONS.MEMORY_GENERATION_REFS);
    await coll.bulkWrite(
      records.map((record) => {
        const { generation_ref_id, ...fields } = record;
        return {
          replaceOne: {
            filter: { _id: generation_ref_id },
            replacement: fields,
            upsert: true,
          },
        };
      }) as never,
      { ordered: false },
    );
  }

  async getMemoryGenerationRef(layer: MemoryGenerationLayer, memoryId: string): Promise<MemoryGenerationRefRecord | null> {
    const coll = await this.coll(COLLECTIONS.MEMORY_GENERATION_REFS);
    const id = buildMemoryGenerationRefId(layer, memoryId);
    const doc = await coll.findOne({ _id: id, layer, memory_id: memoryId } as never);
    if (!doc) return null;
    const { _id, ...fields } = doc as unknown as Record<string, unknown>;
    return { ...(fields as Omit<MemoryGenerationRefRecord, "generation_ref_id">), generation_ref_id: String(_id) };
  }

  // ════════════════════════════════════════════════════════
  // Memory events（统一变更账：extraction / api_mutation / review）
  // ════════════════════════════════════════════════════════

  async appendMemoryEvent(event: MemoryEvent): Promise<void> {
    const coll = await this.coll(COLLECTIONS.MEMORY_EVENTS);
    // _id 由 Mongo 自动生成（ObjectId 自带时间序，作同 event_ts 内的稳定次序键）。
    // Normalize the optional fields to the same defaults sqlite/TCVDB persist:
    // mongo stores `layer: undefined` as a missing field, which a
    // `{layer:"l1"}` filter would never match — diverging from the other
    // backends where the writer-side default lands in the row.
    // Defense-in-depth (same as sqlite/tcvdb): non-canonical event_ts must
    // never reach a lexical compare.
    const eventTs = canonIsoTs(event.event_ts);
    if (eventTs === null) {
      throw new Error(`memory_events append rejected: non-canonical event_ts "${event.event_ts}" event_id=${event.event_id}`);
    }
    try {
    await coll.insertOne({
      ...event,
      event_ts: eventTs,
      event_id: event.event_id || newMemoryEventId(),
      origin_session_id: event.origin_session_id ?? "",
      origin_session_key: event.origin_session_key ?? "",
      team_id: event.team_id ?? "",
      user_id: event.user_id ?? "",
      agent_id: event.agent_id ?? "",
      task_id: event.task_id ?? "",
      memory_type: event.memory_type ?? "",
      version: event.version ?? 0,
      supersedes: event.supersedes ?? [],
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
    } as never);
    } catch (err) {
      // Duplicate event_id: the event already landed (outbox replay / retry).
      // Only the event_id unique index means "already written"; any other
      // duplicate-key violation is a real failure.
      const e = err as { code?: number; keyPattern?: Record<string, unknown> };
      if (e.code === 11000 && e.keyPattern !== undefined && "event_id" in e.keyPattern) return;
      throw err;
    }
  }

  async redactMemoryEvents(filter: MemoryEventRedactFilter): Promise<number> {
    const coll = await this.coll(COLLECTIONS.MEMORY_EVENTS);
    // event_ts is lexicographically compared — a non-canonical `until` does NOT
    // safely match nothing; it can wipe broadly (any ISO string < "March 5, 2026").
    // Shared contract: normalize ms-exact forms to `…ss.sssZ`, reject the rest.
    // Unknown filter fields are silently ignored by coverage/store code —
    // refuse them rather than erasing wider than the filter claims.
    if (!isValidRedactFilter(filter)) return 0;
    const until = canonIsoTs(filter.until)!;
    const teamId = isoMatch(filter.team_id);
    const agentId = isoMatch(filter.agent_id);
    const userId = isoMatch(filter.user_id);
    if (teamId === undefined && agentId === undefined && userId === undefined) {
      // Legal (e.g. full clear), but wipes every tenant — surface it loudly.
      this.logger?.warn?.(`${TAG} redactMemoryEvents without isolation filter: wipes events across ALL tenants (until=${until})`);
    }
    const q: Record<string, unknown> = { event_ts: { $lte: until } };
    if (teamId !== undefined) q.team_id = teamId;
    if (agentId !== undefined) q.agent_id = agentId;
    if (userId !== undefined) q.user_id = userId;
    const res = await coll.updateMany(q as never, { $set: { content: "", snapshot_json: "" } } as never);
    return res.modifiedCount;
  }

  async queryMemoryEvents(filter: MemoryEventFilter): Promise<MemoryEvent[]> {
    const coll = await this.coll(COLLECTIONS.MEMORY_EVENTS);
    const q: Record<string, unknown> = {};
    if (filter.session_id !== undefined) q.session_id = filter.session_id;
    if (filter.session_key !== undefined) q.session_key = filter.session_key;
    if (filter.origin_session_id !== undefined) q.origin_session_id = filter.origin_session_id;
    if (filter.origin_session_key !== undefined) q.origin_session_key = filter.origin_session_key;
    if (filter.record_id !== undefined) q.record_id = filter.record_id;
    if (filter.op !== undefined) q.op = filter.op;
    if (filter.layer !== undefined) q.layer = filter.layer;
    if (filter.source !== undefined) q.source = filter.source;
    if (filter.request_id !== undefined) q.request_id = filter.request_id;
    const teamId = isoMatch(filter.team_id);
    const agentId = isoMatch(filter.agent_id);
    const userId = isoMatch(filter.user_id);
    if (teamId !== undefined) q.team_id = teamId;
    if (agentId !== undefined) q.agent_id = agentId;
    if (userId !== undefined) q.user_id = userId;
    if (filter.task_id !== undefined) q.task_id = filter.task_id;
    // event_ts 是 ISO 8601 字符串，字典序即时间序（与 sqlite 实现一致）。
    if (filter.since !== undefined || filter.until !== undefined) {
      const range: Record<string, string> = {};
      if (filter.since !== undefined) range.$gte = canonEventBound(filter.since);
      if (filter.until !== undefined) range.$lte = canonEventBound(filter.until);
      q.event_ts = range;
    }

    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000);
    const offset = Math.max(filter.offset ?? 0, 0);
    const dir = filter.order === "desc" ? -1 : 1;
    const docs = await coll
      .find(q as never)
      .sort({ event_ts: dir, _id: dir })
      .skip(offset)
      .limit(limit)
      .toArray();
    return docs.map((d) => this.docToMemoryEvent(d));
  }

  private docToMemoryEvent(d: Record<string, unknown>): MemoryEvent {
    const supersedes = Array.isArray(d.supersedes) ? (d.supersedes as string[]) : [];
    return {
      event_id: String(d.event_id ?? "") || undefined,
      event_ts: String(d.event_ts ?? ""),
      session_key: String(d.session_key ?? ""),
      session_id: String(d.session_id ?? ""),
      origin_session_id: String(d.origin_session_id ?? "") || undefined,
      origin_session_key: String(d.origin_session_key ?? "") || undefined,
      team_id: String(d.team_id ?? "") || undefined,
      user_id: String(d.user_id ?? "") || undefined,
      agent_id: String(d.agent_id ?? "") || undefined,
      task_id: String(d.task_id ?? "") || undefined,
      op: d.op as MemoryEvent["op"],
      record_id: String(d.record_id ?? ""),
      content: String(d.content ?? ""),
      memory_type: String(d.memory_type ?? "") || undefined,
      version: Number(d.version ?? 0),
      supersedes: supersedes.length ? supersedes : undefined,
      superseded_by: String(d.superseded_by ?? "") || undefined,
      snapshot_json: String(d.snapshot_json ?? "") || undefined,
      reviewer_id: String(d.reviewer_id ?? "") || undefined,
      layer: (String(d.layer ?? "l1") || "l1") as MemoryEvent["layer"],
      source: (String(d.source ?? "") || undefined) as MemoryEvent["source"],
      request_id: String(d.request_id ?? "") || undefined,
      reason: String(d.reason ?? "") || undefined,
      target_event_id: String(d.target_event_id ?? "") || undefined,
      scope: (String(d.scope ?? "") || undefined) as MemoryEvent["scope"],
      until: String(d.until ?? "") || undefined,
    };
  }

  // ════════════════════════════════════════════════════════
  // Knowledge entity (wiki / code-graph metadata)
  // ════════════════════════════════════════════════════════

  async createKnowledge(input: Omit<KnowledgeEntity, "created_at" | "updated_at">): Promise<KnowledgeEntity> {
    const coll = await this.coll(COLLECTIONS.KNOWLEDGE);
    const now = new Date().toISOString();
    const entity: KnowledgeEntity = { ...input, created_at: now, updated_at: now };
    // Shard-key-safe upsert: knowledge's designated shard key is {team_id, _id}
    // (agent_id is optional on knowledge, so it is not part of the key).
    await coll.replaceOne(
      { _id: entity.knowledge_id, team_id: entity.team_id } as never,
      { ...entity, _id: entity.knowledge_id } as never,
      { upsert: true },
    );
    return entity;
  }

  async getKnowledge(knowledgeId: string): Promise<KnowledgeEntity | null> {
    const coll = await this.coll(COLLECTIONS.KNOWLEDGE);
    const d = await coll.findOne({ _id: knowledgeId } as never);
    return d ? this.docToKnowledge(d) : null;
  }

  async updateKnowledge(
    knowledgeId: string,
    patch: Partial<Pick<KnowledgeEntity, "name" | "summary" | "service_url" | "repo_url" | "branch">>,
  ): Promise<KnowledgeEntity | null> {
    const coll = await this.coll(COLLECTIONS.KNOWLEDGE);
    const set: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) set[k] = v;
    const res = await coll.findOneAndUpdate(
      { _id: knowledgeId } as never,
      { $set: set } as never,
      { returnDocument: "after" },
    );
    const doc = (res as { value?: Record<string, unknown> } | null)?.value ?? (res as Record<string, unknown> | null);
    return doc && (doc as { _id?: unknown })._id ? this.docToKnowledge(doc as Record<string, unknown>) : null;
  }

  async deleteKnowledge(knowledgeIds: string[], teamId?: string): Promise<BatchDeleteResult> {
    const coll = await this.coll(COLLECTIONS.KNOWLEDGE);
    const deleted_ids: string[] = [];
    const failed: Array<{ id: string; reason: string }> = [];
    for (const id of knowledgeIds) {
      const q: Record<string, unknown> = { _id: id };
      if (teamId !== undefined) q.team_id = teamId;
      const res = await coll.deleteOne(q as never);
      if (res.deletedCount > 0) deleted_ids.push(id);
      else failed.push({ id, reason: "not_found" });
    }
    return { deleted_ids, failed };
  }

  async listKnowledge(input: {
    team_id: string;
    type?: KnowledgeType;
    knowledge_ids?: string[];
    limit?: number;
    offset?: number;
  }): Promise<KnowledgeListResult> {
    const coll = await this.coll(COLLECTIONS.KNOWLEDGE);
    const q: Record<string, unknown> = { team_id: input.team_id };
    if (input.type !== undefined) q.type = input.type;
    if (input.knowledge_ids && input.knowledge_ids.length > 0) q._id = { $in: input.knowledge_ids };
    const total = await coll.countDocuments(q as never);
    const docs = await coll
      .find(q as never)
      .sort({ updated_at: -1 })
      .skip(input.offset ?? 0)
      .limit(input.limit ?? 100)
      .toArray();
    return { items: docs.map((d) => this.docToKnowledge(d)), total };
  }

  private docToKnowledge(d: Record<string, unknown>): KnowledgeEntity {
    return {
      knowledge_id: String(d.knowledge_id ?? d._id),
      type: d.type as KnowledgeType,
      service_url: String(d.service_url ?? ""),
      name: String(d.name ?? ""),
      summary: (d.summary as string | null) ?? null,
      team_id: String(d.team_id ?? ""),
      agent_id: d.agent_id as string | undefined,
      user_id: (d.user_id as string | null) ?? null,
      repo_url: d.repo_url as string | undefined,
      branch: d.branch as string | undefined,
      created_at: String(d.created_at ?? ""),
      updated_at: String(d.updated_at ?? ""),
    };
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Isolation-id match for memory_events queries/redacts: a defined value
 * heals "" → "default" (see healIsoId) and "default" matches BOTH stored
 * forms — legacy/foreign rows may carry "" while contract writes store
 * "default". Other values compare by plain equality.
 */
function isoMatch(v: string | undefined): string | { $in: string[] } | undefined {
  const healed = healIsoId(v);
  if (healed === undefined) return undefined;
  return healed === DEFAULT_ISOLATION_ID ? { $in: ["", DEFAULT_ISOLATION_ID] } : healed;
}

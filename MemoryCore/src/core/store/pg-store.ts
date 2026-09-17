import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type { MemoryRecord } from "../record/l1-writer.js";
import type { EmbeddingProviderInfo } from "./embedding.js";
import type {
  IMemoryStore, StoreCapabilities, L0Record, L1SearchResult, L1FtsResult,
  L0SearchResult, L0FtsResult, L0QueryRow, L1RecordRow, L1QueryFilter,
  L0CountFilter, L0PaginatedFilter, L0PaginatedResult, L1CountFilter,
  L1PaginatedFilter, L1PaginatedResult, L0SessionGroup, IsolationFilter,
  TeamEntity, UserEntity, AgentEntity, TaskEntity, KnowledgeEntity,
  KnowledgeType, KnowledgeListResult, BatchDeleteResult, AuditEntry,
  AuditQueryFilter, StoreInitResult,
} from "./types.js";
import { DEFAULT_ISOLATION_ID, rowMatchesIsolation } from "./types.js";
import { tokenizeForFts } from "./tokenize.js";
import type { Logger } from "../types.js";

const TAG = "[memory-tdai][pg]";

function float32ToPgVector(arr: Float32Array): string {
  return "[" + Array.from(arr).join(",") + "]";
}
function isZeroVector(arr: Float32Array | undefined): boolean {
  return !arr || arr.every(v => v === 0);
}
function tsRankToScore(rank: number): number {
  if (!Number.isFinite(rank) || rank <= 0) return 0;
  return rank / (1 + rank);
}
function buildIsoClause(filter: IsolationFilter | undefined, off: number) {
  if (!filter) return { clause: "", params: [] as string[] };
  const parts: string[] = []; const params: string[] = []; let idx = off;
  if (filter.teamId !== undefined) { parts.push("team_id = $" + (++idx)); params.push(filter.teamId); }
  if (filter.userId !== undefined) { parts.push("user_id = $" + (++idx)); params.push(filter.userId); }
  if (filter.agentId !== undefined) { parts.push("agent_id = $" + (++idx)); params.push(filter.agentId); }
  if (filter.sessionId !== undefined) { parts.push("session_id = $" + (++idx)); params.push(filter.sessionId); }
  if (filter.taskId !== undefined) { parts.push("task_id = $" + (++idx)); params.push(filter.taskId); }
  if (filter.sessionKey !== undefined) { parts.push("session_key = $" + (++idx)); params.push(filter.sessionKey); }
  return { clause: parts.join(" AND "), params };
}

export interface PgStoreOptions {
  connectionString: string;
  dimensions: number;
  logger?: Logger;
}

export class PgMemoryStore implements IMemoryStore {
  private pool: Pool;
  private readonly dimensions: number;
  private readonly logger?: Logger;
  private degraded = false;
  private closed = false;
  private vecReady = false;
  private ftsAvailable = false;
  private initialized = false;
  readonly supportsDeferredEmbedding = true;

  constructor(opts: PgStoreOptions) {
    this.dimensions = opts.dimensions;
    this.logger = opts.logger;
    this.pool = new Pool({
      connectionString: opts.connectionString,
      max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000,
    });
  }

  async init(providerInfo?: EmbeddingProviderInfo): Promise<StoreInitResult> {
    if (this.initialized) return { needsReindex: false };
    try {
      await this.pool.query("CREATE EXTENSION IF NOT EXISTS vector");
      await this.pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
      await this.initSchema();
      let needsReindex = false;
      let reindexReason: string | undefined;
      if (providerInfo) {
        const savedMeta = await this.readEmbeddingMeta();
        if (savedMeta) {
          if (savedMeta.provider !== providerInfo.provider || savedMeta.model !== providerInfo.model || savedMeta.dimensions !== this.dimensions) {
            this.logger?.info(TAG + " Embedding config changed. Dropping vector columns.");
            await this.dropVectorColumns();
            needsReindex = true;
            reindexReason = "provider/model/dims changed";
          }
        } else {
          const l1c = await this.tableRowCount("l1_records");
          const l0c = await this.tableRowCount("l0_conversations");
          if (l1c > 0 || l0c > 0) { needsReindex = true; reindexReason = "legacy DB without embedding_meta"; }
        }
        await this.writeEmbeddingMeta({ provider: providerInfo.provider, model: providerInfo.model, dimensions: this.dimensions });
      }
      this.vecReady = this.dimensions > 0;
      this.ftsAvailable = true;
      this.initialized = true;
      this.logger?.info(TAG + " Initialized (dims=" + this.dimensions + ")");
      return { needsReindex, reason: reindexReason };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.error(TAG + " Init failed: " + msg);
      this.degraded = true;
      this.initialized = true;
      return { needsReindex: false, reason: "pg init failed: " + msg };
    }
  }


  private async initSchema(): Promise<void> {
    await this.pool.query("CREATE TABLE IF NOT EXISTS embedding_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    await this.pool.query("CREATE TABLE IF NOT EXISTS l1_records (record_id TEXT PRIMARY KEY, content TEXT NOT NULL DEFAULT '', content_segmented TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT '', priority INTEGER NOT NULL DEFAULT 50, scene_name TEXT NOT NULL DEFAULT '', session_key TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL DEFAULT 'default', team_id TEXT NOT NULL DEFAULT 'default', task_id TEXT NOT NULL DEFAULT '', user_id TEXT NOT NULL DEFAULT 'default', agent_id TEXT NOT NULL DEFAULT 'default', version INTEGER NOT NULL DEFAULT 0, timestamp_str TEXT NOT NULL DEFAULT '', timestamp_start TEXT NOT NULL DEFAULT '', timestamp_end TEXT NOT NULL DEFAULT '', created_time TEXT NOT NULL DEFAULT '', updated_time TEXT NOT NULL DEFAULT '', metadata_json TEXT NOT NULL DEFAULT '{}')");
    await this.ensureVectorColumns();
    await this.pool.query("ALTER TABLE l1_records ADD COLUMN IF NOT EXISTS content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content_segmented, ''))) STORED").catch(() => {});
    await this.pool.query("CREATE INDEX IF NOT EXISTS idx_l1_type ON l1_records(type)");
    await this.pool.query("CREATE INDEX IF NOT EXISTS idx_l1_session_id ON l1_records(session_id)");
    await this.pool.query("CREATE INDEX IF NOT EXISTS idx_l1_session_key ON l1_records(session_key)");
    await this.pool.query("CREATE INDEX IF NOT EXISTS idx_l1_session_updated ON l1_records(session_id, updated_time)");
    await this.pool.query("CREATE INDEX IF NOT EXISTS idx_l1_team_agent_updated ON l1_records(team_id, agent_id, updated_time)");
    await this.pool.query("CREATE INDEX IF NOT EXISTS idx_l1_user_agent_session ON l1_records(user_id, agent_id, session_id)");
    await this.pool.query("CREATE INDEX IF NOT EXISTS idx_l1_content_tsv ON l1_records USING GIN (content_tsv)").catch(() => {});
    if (this.dimensions > 0) await this.pool.query("CREATE INDEX IF NOT EXISTS idx_l1_vec ON l1_records USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)").catch(() => {});

    await this.pool.query("CREATE TABLE IF NOT EXISTS l0_conversations (record_id TEXT PRIMARY KEY, session_key TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT 'default', team_id TEXT NOT NULL DEFAULT 'default', task_id TEXT NOT NULL DEFAULT '', user_id TEXT NOT NULL DEFAULT 'default', agent_id TEXT NOT NULL DEFAULT 'default', role TEXT NOT NULL DEFAULT '', message_text TEXT NOT NULL, message_segmented TEXT NOT NULL DEFAULT '', recorded_at TEXT NOT NULL DEFAULT '', timestamp BIGINT NOT NULL DEFAULT 0)");
    if (this.dimensions > 0) await this.pool.query("ALTER TABLE l0_conversations ADD COLUMN IF NOT EXISTS embedding vector(" + this.dimensions + ")").catch(() => {});
    await this.pool.query("ALTER TABLE l0_conversations ADD COLUMN IF NOT EXISTS message_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(message_segmented, ''))) STORED").catch(() => {});
    await this.pool.query("CREATE INDEX IF NOT EXISTS idx_l0_session ON l0_conversations(session_key)");
    await this.pool.query("CREATE INDEX IF NOT EXISTS idx_l0_session_id ON l0_conversations(session_id)");
    await this.pool.query("CREATE INDEX IF NOT EXISTS idx_l0_user_agent_session ON l0_conversations(user_id, agent_id, session_id)");
    await this.pool.query("CREATE INDEX IF NOT EXISTS idx_l0_timestamp ON l0_conversations(timestamp)");
    await this.pool.query("CREATE INDEX IF NOT EXISTS idx_l0_message_tsv ON l0_conversations USING GIN (message_tsv)").catch(() => {});
    if (this.dimensions > 0) await this.pool.query("CREATE INDEX IF NOT EXISTS idx_l0_vec ON l0_conversations USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)").catch(() => {});

    await this.pool.query("CREATE TABLE IF NOT EXISTS entity_teams (team_id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', owner_user_id TEXT NOT NULL, user_ids_json TEXT NOT NULL DEFAULT '[]', agent_ids_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
    await this.pool.query("CREATE TABLE IF NOT EXISTS entity_users (user_id TEXT PRIMARY KEY, name TEXT NOT NULL, job_description TEXT DEFAULT '', team_ids_json TEXT NOT NULL DEFAULT '[]', task_ids_json TEXT NOT NULL DEFAULT '[]', owned_agent_ids_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
    await this.pool.query("CREATE TABLE IF NOT EXISTS entity_agents (agent_id TEXT PRIMARY KEY, team_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT DEFAULT '', prompt TEXT DEFAULT '', owner_user_id TEXT DEFAULT '', visibility TEXT NOT NULL DEFAULT 'team', status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
    await this.pool.query("CREATE TABLE IF NOT EXISTS entity_tasks (task_id TEXT PRIMARY KEY, team_id TEXT NOT NULL, creator_user_id TEXT NOT NULL, title TEXT DEFAULT '', description TEXT DEFAULT '', source_type TEXT NOT NULL DEFAULT 'manual', source_url TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', auto_assign_floating_assets INTEGER NOT NULL DEFAULT 0, risk_level TEXT NOT NULL DEFAULT 'low', agent_ids_json TEXT NOT NULL DEFAULT '[]', user_ids_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
    await this.pool.query("CREATE TABLE IF NOT EXISTS entity_knowledge (knowledge_id TEXT PRIMARY KEY, type TEXT NOT NULL, service_url TEXT NOT NULL, name TEXT NOT NULL, summary TEXT, team_id TEXT NOT NULL, agent_id TEXT NOT NULL DEFAULT '', user_id TEXT, repo_url TEXT, branch TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
    await this.pool.query("CREATE TABLE IF NOT EXISTS memory_audit (audit_id TEXT PRIMARY KEY, record_id TEXT NOT NULL, layer TEXT NOT NULL CHECK (layer IN ('L1','L2','L3')), action TEXT NOT NULL CHECK (action IN ('update','delete')), team_id TEXT, agent_id TEXT, user_id TEXT, task_id TEXT, version INTEGER NOT NULL, updated_at_ms BIGINT NOT NULL, request_id TEXT)");
    await this.pool.query("CREATE INDEX IF NOT EXISTS idx_memory_audit_record ON memory_audit(record_id, updated_at_ms)");
    await this.pool.query("CREATE INDEX IF NOT EXISTS idx_memory_audit_time ON memory_audit(updated_at_ms)");
  }

  private async ensureVectorColumns(): Promise<void> {
    if (this.dimensions <= 0) return;
    await this.pool.query("ALTER TABLE l1_records ADD COLUMN IF NOT EXISTS embedding vector(" + this.dimensions + ")").catch(() => {});
    await this.pool.query("ALTER TABLE l0_conversations ADD COLUMN IF NOT EXISTS embedding vector(" + this.dimensions + ")").catch(() => {});
  }
  private async dropVectorColumns(): Promise<void> {
    await this.pool.query("ALTER TABLE l1_records DROP COLUMN IF EXISTS embedding").catch(() => {});
    await this.pool.query("ALTER TABLE l0_conversations DROP COLUMN IF EXISTS embedding").catch(() => {});
    await this.ensureVectorColumns();
  }
  private async readEmbeddingMeta(): Promise<{ provider: string; model: string; dimensions: number } | null> {
    try { const r = await this.pool.query("SELECT value FROM embedding_meta WHERE key = $1", ["embedding_provider_info"]); if (r.rows.length === 0) return null; return JSON.parse(r.rows[0].value); } catch { return null; }
  }
  private async writeEmbeddingMeta(meta: { provider: string; model: string; dimensions: number }): Promise<void> {
    await this.pool.query("INSERT INTO embedding_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", ["embedding_provider_info", JSON.stringify(meta)]);
  }
  private async tableRowCount(table: string): Promise<number> {
    try { const r = await this.pool.query("SELECT COUNT(*) AS cnt FROM " + table); return parseInt(r.rows[0]?.cnt ?? "0", 10); } catch { return 0; }
  }

  isDegraded(): boolean { return this.degraded; }
  getCapabilities(): StoreCapabilities { return { vectorSearch: this.vecReady, ftsSearch: this.ftsAvailable, nativeHybridSearch: false, sparseVectors: false }; }
  isFtsAvailable(): boolean { return this.ftsAvailable; }
  close(): void { if (this.closed) return; this.closed = true; this.pool.end().catch(() => {}); }

  private entityId(prefix: string): string { return prefix + "_" + randomUUID().replace(/-/g, "").slice(0, 12); }
  private jsonArray(value: unknown): string { return JSON.stringify(Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : []); }
  private parseArray(value: unknown): string[] { if (typeof value !== "string" || !value) return []; try { const p = JSON.parse(value); return Array.isArray(p) ? p.filter((v): v is string => typeof v === "string") : []; } catch { return []; } }


  // 鈹€鈹€ L1 Write 鈹€鈹€

  async upsertL1(record: MemoryRecord, embedding: Float32Array | undefined): Promise<boolean> {
    if (this.degraded) return false;
    try {
      const tsStr = record.timestamps[0] ?? "";
      const tsStart = record.timestamps.length > 0 ? record.timestamps.reduce((a, b) => a < b ? a : b) : tsStr;
      const tsEnd = record.timestamps.length > 0 ? record.timestamps.reduce((a, b) => a > b ? a : b) : tsStr;
      const skipVec = isZeroVector(embedding) || !this.vecReady;
      const segmented = tokenizeForFts(record.content);
      const cols = "record_id, content, content_segmented, type, priority, scene_name, session_key, session_id, team_id, task_id, version, timestamp_str, timestamp_start, timestamp_end, created_time, updated_time, metadata_json, user_id, agent_id";
      const vals = "$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19";
      const params: unknown[] = [record.id, record.content, segmented, record.type, record.priority, record.scene_name, record.sessionKey, record.sessionId || DEFAULT_ISOLATION_ID, record.teamId || DEFAULT_ISOLATION_ID, record.taskId || "", record.version ?? 0, tsStr, tsStart, tsEnd, record.createdAt, record.updatedAt, JSON.stringify(record.metadata), record.userId || DEFAULT_ISOLATION_ID, record.agentId || DEFAULT_ISOLATION_ID];
      let sql: string;
      if (!skipVec && embedding) {
        sql = "INSERT INTO l1_records (" + cols + ", embedding) VALUES (" + vals + ",$20) ON CONFLICT (record_id) DO UPDATE SET content=EXCLUDED.content, content_segmented=EXCLUDED.content_segmented, type=EXCLUDED.type, priority=EXCLUDED.priority, scene_name=EXCLUDED.scene_name, team_id=EXCLUDED.team_id, task_id=EXCLUDED.task_id, version=EXCLUDED.version, timestamp_str=EXCLUDED.timestamp_str, timestamp_start=EXCLUDED.timestamp_start, timestamp_end=EXCLUDED.timestamp_end, updated_time=EXCLUDED.updated_time, metadata_json=EXCLUDED.metadata_json, user_id=EXCLUDED.user_id, agent_id=EXCLUDED.agent_id, embedding=EXCLUDED.embedding";
        params.push(float32ToPgVector(embedding));
      } else {
        sql = "INSERT INTO l1_records (" + cols + ") VALUES (" + vals + ") ON CONFLICT (record_id) DO UPDATE SET content=EXCLUDED.content, content_segmented=EXCLUDED.content_segmented, type=EXCLUDED.type, priority=EXCLUDED.priority, scene_name=EXCLUDED.scene_name, team_id=EXCLUDED.team_id, task_id=EXCLUDED.task_id, version=EXCLUDED.version, timestamp_str=EXCLUDED.timestamp_str, timestamp_start=EXCLUDED.timestamp_start, timestamp_end=EXCLUDED.timestamp_end, updated_time=EXCLUDED.updated_time, metadata_json=EXCLUDED.metadata_json, user_id=EXCLUDED.user_id, agent_id=EXCLUDED.agent_id";
      }
      await this.pool.query(sql, params);
      return true;
    } catch (err) { this.logger?.warn(TAG + " upsertL1 failed id=" + record.id + ": " + (err instanceof Error ? err.message : String(err))); return false; }
  }

  async deleteL1(recordId: string, filter?: IsolationFilter): Promise<boolean> {
    if (this.degraded) return false;
    try {
      if (filter) { const r = await this.pool.query("SELECT user_id, agent_id, session_id, session_key FROM l1_records WHERE record_id = $1", [recordId]); if (r.rows.length === 0 || !rowMatchesIsolation(r.rows[0], filter)) return false; }
      const r = await this.pool.query("DELETE FROM l1_records WHERE record_id = $1", [recordId]);
      return (r.rowCount ?? 0) > 0;
    } catch { return false; }
  }

  async deleteL1Batch(recordIds: string[], filter?: IsolationFilter): Promise<boolean> {
    if (this.degraded) return false;
    if (recordIds.length === 0) return true;
    try {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        for (const id of recordIds) {
          if (filter) { const r = await client.query("SELECT user_id, agent_id, session_id, session_key FROM l1_records WHERE record_id = $1", [id]); if (r.rows.length === 0 || !rowMatchesIsolation(r.rows[0], filter)) continue; }
          await client.query("DELETE FROM l1_records WHERE record_id = $1", [id]);
        }
        await client.query("COMMIT");
        return true;
      } catch (err) { await client.query("ROLLBACK").catch(() => {}); throw err; }
      finally { client.release(); }
    } catch { return false; }
  }

  async deleteL1Expired(cutoffIso: string): Promise<number> {
    if (this.degraded) return 0;
    try {
      const cR = await this.pool.query("SELECT COUNT(*) AS cnt FROM l1_records WHERE updated_time != '' AND updated_time < $1", [cutoffIso]);
      const expired = parseInt(cR.rows[0]?.cnt ?? "0", 10);
      if (expired <= 0) return 0;
      const tR = await this.pool.query("SELECT COUNT(*) AS cnt FROM l1_records");
      const total = parseInt(tR.rows[0]?.cnt ?? "0", 10);
      if (total > 0 && expired / total > 0.8) return 0;
      const r = await this.pool.query("DELETE FROM l1_records WHERE updated_time != '' AND updated_time < $1", [cutoffIso]);
      return r.rowCount ?? 0;
    } catch { return 0; }
  }

  // 鈹€鈹€ L1 Read 鈹€鈹€

  async countL1(filter?: L1CountFilter): Promise<number> {
    if (this.degraded) return 0;
    try {
      const c: string[] = []; const p: unknown[] = []; let i = 0;
      if (filter?.type) { c.push("type = $" + (++i)); p.push(filter.type); }
      if (filter?.sessionId) { c.push("session_id = $" + (++i)); p.push(filter.sessionId); }
      if (filter?.teamId !== undefined) { c.push("team_id = $" + (++i)); p.push(filter.teamId); }
      if (filter?.userId !== undefined) { c.push("user_id = $" + (++i)); p.push(filter.userId); }
      if (filter?.agentId !== undefined) { c.push("agent_id = $" + (++i)); p.push(filter.agentId); }
      if (filter?.taskId !== undefined) { c.push("task_id = $" + (++i)); p.push(filter.taskId); }
      if (filter?.timeStart) { c.push("updated_time >= $" + (++i)); p.push(filter.timeStart); }
      if (filter?.timeEnd) { c.push("updated_time <= $" + (++i)); p.push(filter.timeEnd); }
      const w = c.length > 0 ? "WHERE " + c.join(" AND ") : "";
      const r = await this.pool.query("SELECT COUNT(*) AS cnt FROM l1_records " + w, p);
      return parseInt(r.rows[0]?.cnt ?? "0", 10);
    } catch { return 0; }
  }

  async queryL1Records(filter?: L1QueryFilter): Promise<L1RecordRow[]> {
    if (this.degraded) return [];
    try {
      const c: string[] = []; const p: unknown[] = []; let i = 0;
      if (filter?.sessionId) { c.push("session_id = $" + (++i)); p.push(filter.sessionId); }
      if (filter?.sessionKey) { c.push("session_key = $" + (++i)); p.push(filter.sessionKey); }
      if (filter?.taskId !== undefined) { c.push("task_id = $" + (++i)); p.push(filter.taskId); }
      if (filter?.teamId !== undefined) { c.push("team_id = $" + (++i)); p.push(filter.teamId); }
      if (filter?.userId !== undefined) { c.push("user_id = $" + (++i)); p.push(filter.userId); }
      if (filter?.agentId !== undefined) { c.push("agent_id = $" + (++i)); p.push(filter.agentId); }
      if (filter?.updatedAfter) { c.push("updated_time > $" + (++i)); p.push(filter.updatedAfter); }
      const w = c.length > 0 ? "WHERE " + c.join(" AND ") : "";
      const r = await this.pool.query("SELECT record_id, content, type, priority, scene_name, session_key, session_id, team_id, task_id, user_id, agent_id, version, timestamp_str, timestamp_start, timestamp_end, created_time, updated_time, metadata_json FROM l1_records " + w + " ORDER BY updated_time ASC", p);
      return r.rows as L1RecordRow[];
    } catch { return []; }
  }

  async getAllL1Texts(): Promise<Array<{ record_id: string; content: string; updated_time: string }>> {
    if (this.degraded) return [];
    try { const r = await this.pool.query("SELECT record_id, content, updated_time FROM l1_records"); return r.rows; } catch { return []; }
  }

  // 鈹€鈹€ L1 Search 鈹€鈹€

  async searchL1Vector(queryEmbedding: Float32Array, topK = 5, _q?: string, filter?: IsolationFilter): Promise<L1SearchResult[]> {
    if (this.degraded || !this.vecReady) return [];
    try {
      const rc = filter ? Math.max(topK * 5, topK + 10) : topK + 10;
      const vs = float32ToPgVector(queryEmbedding);
      const iso = buildIsoClause(filter, 1);
      const wc = iso.clause ? "AND " + iso.clause : "";
      const r = await this.pool.query("SELECT record_id, embedding <=> $1::vector AS distance FROM l1_records WHERE embedding IS NOT NULL " + wc + " ORDER BY embedding <=> $1::vector LIMIT $" + (iso.params.length + 2) + "::int", [vs, ...iso.params, rc]);
      const results: L1SearchResult[] = [];
      for (const row of r.rows) {
        const dist = Number(row.distance);
        if (dist == null || Number.isNaN(dist)) continue;
        const mr = await this.pool.query("SELECT content, type, priority, scene_name, session_key, session_id, team_id, task_id, user_id, agent_id, version, timestamp_str, timestamp_start, timestamp_end, metadata_json FROM l1_records WHERE record_id = $1", [row.record_id]);
        if (mr.rows.length === 0) continue;
        const m = mr.rows[0];
        if (!rowMatchesIsolation(m, filter)) continue;
        results.push({ record_id: row.record_id, content: m.content, type: m.type, priority: m.priority, scene_name: m.scene_name, score: 1.0 - dist, timestamp_str: m.timestamp_str, timestamp_start: m.timestamp_start, timestamp_end: m.timestamp_end, version: m.version ?? 0, session_key: m.session_key, session_id: m.session_id, team_id: m.team_id ?? "", task_id: m.task_id ?? "", user_id: m.user_id ?? "", agent_id: m.agent_id ?? "", metadata_json: m.metadata_json });
      }
      return results.slice(0, topK);
    } catch (err) { this.logger?.warn(TAG + " searchL1Vector failed: " + (err instanceof Error ? err.message : String(err))); return []; }
  }

  async searchL1Fts(ftsQuery: string, limit = 20, filter?: IsolationFilter): Promise<L1FtsResult[]> {
    if (this.degraded || !this.ftsAvailable) return [];
    try {
      const rl = filter ? Math.max(limit * 5, limit) : limit;
      const iso = buildIsoClause(filter, 1);
      const wc = iso.clause ? "AND " + iso.clause : "";
      const r = await this.pool.query("SELECT record_id, content, type, priority, scene_name, session_key, session_id, team_id, task_id, user_id, agent_id, version, timestamp_str, timestamp_start, timestamp_end, metadata_json, ts_rank(content_tsv, websearch_to_tsquery('simple', $1)) AS rank FROM l1_records WHERE content_tsv @@ websearch_to_tsquery('simple', $1) " + wc + " ORDER BY rank DESC LIMIT $" + (iso.params.length + 2) + "::int", [ftsQuery, ...iso.params, rl]);
      return r.rows.filter((row: any) => rowMatchesIsolation(row, filter)).slice(0, limit).map((row: any) => ({ record_id: row.record_id, content: row.content, type: row.type, priority: row.priority, scene_name: row.scene_name, score: tsRankToScore(Number(row.rank)), timestamp_str: row.timestamp_str, timestamp_start: row.timestamp_start, timestamp_end: row.timestamp_end, version: row.version ?? 0, session_key: row.session_key, session_id: row.session_id, team_id: row.team_id ?? "", task_id: row.task_id ?? "", user_id: row.user_id ?? "", agent_id: row.agent_id ?? "", metadata_json: row.metadata_json }));
    } catch (err) { this.logger?.warn(TAG + " searchL1Fts failed: " + (err instanceof Error ? err.message : String(err))); return []; }
  }


  // 鈹€鈹€ L0 Write 鈹€鈹€

  async upsertL0(record: L0Record, embedding: Float32Array | undefined): Promise<boolean> {
    if (this.degraded) return false;
    try {
      const skipVec = isZeroVector(embedding) || !this.vecReady;
      const seg = tokenizeForFts(record.messageText);
      const cols = "record_id, session_key, session_id, team_id, task_id, role, message_text, message_segmented, recorded_at, timestamp, user_id, agent_id";
      const vals = "$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12";
      const params: unknown[] = [record.id, record.sessionKey, record.sessionId || DEFAULT_ISOLATION_ID, record.teamId || DEFAULT_ISOLATION_ID, record.taskId || "", record.role, record.messageText, seg, record.recordedAt, record.timestamp, record.userId || DEFAULT_ISOLATION_ID, record.agentId || DEFAULT_ISOLATION_ID];
      let sql: string;
      if (!skipVec && embedding) {
        sql = "INSERT INTO l0_conversations (" + cols + ", embedding) VALUES (" + vals + ",$13) ON CONFLICT (record_id) DO UPDATE SET message_text=EXCLUDED.message_text, message_segmented=EXCLUDED.message_segmented, recorded_at=EXCLUDED.recorded_at, timestamp=EXCLUDED.timestamp, team_id=EXCLUDED.team_id, task_id=EXCLUDED.task_id, user_id=EXCLUDED.user_id, agent_id=EXCLUDED.agent_id, embedding=EXCLUDED.embedding";
        params.push(float32ToPgVector(embedding));
      } else {
        sql = "INSERT INTO l0_conversations (" + cols + ") VALUES (" + vals + ") ON CONFLICT (record_id) DO UPDATE SET message_text=EXCLUDED.message_text, message_segmented=EXCLUDED.message_segmented, recorded_at=EXCLUDED.recorded_at, timestamp=EXCLUDED.timestamp, team_id=EXCLUDED.team_id, task_id=EXCLUDED.task_id, user_id=EXCLUDED.user_id, agent_id=EXCLUDED.agent_id";
      }
      await this.pool.query(sql, params);
      return true;
    } catch (err) { this.logger?.warn(TAG + " upsertL0 failed id=" + record.id + ": " + (err instanceof Error ? err.message : String(err))); return false; }
  }

  async updateL0Embedding(recordId: string, embedding: Float32Array): Promise<boolean> {
    if (this.degraded || !this.vecReady) return false;
    if (isZeroVector(embedding)) return false;
    try { await this.pool.query("UPDATE l0_conversations SET embedding = $1 WHERE record_id = $2", [float32ToPgVector(embedding), recordId]); return true; } catch { return false; }
  }

  async deleteL0(recordId: string, filter?: IsolationFilter): Promise<boolean> {
    if (this.degraded) return false;
    try {
      if (filter) { const r = await this.pool.query("SELECT user_id, agent_id, session_id, session_key FROM l0_conversations WHERE record_id = $1", [recordId]); if (r.rows.length === 0 || !rowMatchesIsolation(r.rows[0], filter)) return false; }
      const r = await this.pool.query("DELETE FROM l0_conversations WHERE record_id = $1", [recordId]);
      return (r.rowCount ?? 0) > 0;
    } catch { return false; }
  }

  async deleteL0Expired(cutoffIso: string): Promise<number> {
    if (this.degraded) return 0;
    try {
      const cR = await this.pool.query("SELECT COUNT(*) AS cnt FROM l0_conversations WHERE recorded_at != '' AND recorded_at < $1", [cutoffIso]);
      const expired = parseInt(cR.rows[0]?.cnt ?? "0", 10);
      if (expired <= 0) return 0;
      const tR = await this.pool.query("SELECT COUNT(*) AS cnt FROM l0_conversations");
      const total = parseInt(tR.rows[0]?.cnt ?? "0", 10);
      if (total > 0 && expired / total > 0.8) return 0;
      const r = await this.pool.query("DELETE FROM l0_conversations WHERE recorded_at != '' AND recorded_at < $1", [cutoffIso]);
      return r.rowCount ?? 0;
    } catch { return 0; }
  }

  // 鈹€鈹€ L0 Read 鈹€鈹€

  async countL0(filter?: L0CountFilter): Promise<number> {
    if (this.degraded) return 0;
    try {
      const c: string[] = []; const p: unknown[] = []; let i = 0;
      if (filter?.sessionId) { c.push("(session_key = $" + (++i) + " OR session_id = $" + (++i) + ")"); p.push(filter.sessionId, filter.sessionId); }
      if (filter?.teamId !== undefined) { c.push("team_id = $" + (++i)); p.push(filter.teamId); }
      if (filter?.userId !== undefined) { c.push("user_id = $" + (++i)); p.push(filter.userId); }
      if (filter?.agentId !== undefined) { c.push("agent_id = $" + (++i)); p.push(filter.agentId); }
      if (filter?.taskId !== undefined) { c.push("task_id = $" + (++i)); p.push(filter.taskId); }
      if (filter?.timeStartMs !== undefined) { c.push("timestamp >= $" + (++i)); p.push(filter.timeStartMs); }
      if (filter?.timeEndMs !== undefined) { c.push("timestamp <= $" + (++i)); p.push(filter.timeEndMs); }
      const w = c.length > 0 ? "WHERE " + c.join(" AND ") : "";
      const r = await this.pool.query("SELECT COUNT(*) AS cnt FROM l0_conversations " + w, p);
      return parseInt(r.rows[0]?.cnt ?? "0", 10);
    } catch { return 0; }
  }

  async getAllL0Texts(): Promise<Array<{ record_id: string; message_text: string; recorded_at: string }>> {
    if (this.degraded) return [];
    try { const r = await this.pool.query("SELECT record_id, message_text, recorded_at FROM l0_conversations"); return r.rows; } catch { return []; }
  }

  // 鈹€鈹€ L0 Search 鈹€鈹€

  async searchL0Vector(queryEmbedding: Float32Array, topK = 5, _q?: string, filter?: IsolationFilter): Promise<L0SearchResult[]> {
    if (this.degraded || !this.vecReady) return [];
    try {
      const rc = filter ? Math.max(topK * 5, topK + 10) : topK + 10;
      const vs = float32ToPgVector(queryEmbedding);
      const iso = buildIsoClause(filter, 1);
      const wc = iso.clause ? "AND " + iso.clause : "";
      const r = await this.pool.query("SELECT record_id, embedding <=> $1::vector AS distance FROM l0_conversations WHERE embedding IS NOT NULL " + wc + " ORDER BY embedding <=> $1::vector LIMIT $" + (iso.params.length + 2) + "::int", [vs, ...iso.params, rc]);
      const results: L0SearchResult[] = [];
      for (const row of r.rows) {
        const dist = Number(row.distance);
        if (dist == null || Number.isNaN(dist)) continue;
        const mr = await this.pool.query("SELECT session_key, session_id, team_id, task_id, user_id, agent_id, role, message_text, recorded_at, timestamp FROM l0_conversations WHERE record_id = $1", [row.record_id]);
        if (mr.rows.length === 0) continue;
        const m = mr.rows[0];
        if (!rowMatchesIsolation(m, filter)) continue;
        results.push({ record_id: row.record_id, session_key: m.session_key, session_id: m.session_id, team_id: m.team_id ?? "", task_id: m.task_id ?? "", user_id: m.user_id ?? "", agent_id: m.agent_id ?? "", role: m.role, message_text: m.message_text, score: 1.0 - dist, recorded_at: m.recorded_at, timestamp: Number(m.timestamp) || 0 });
      }
      return results.slice(0, topK);
    } catch (err) { this.logger?.warn(TAG + " searchL0Vector failed: " + (err instanceof Error ? err.message : String(err))); return []; }
  }

  async searchL0Fts(ftsQuery: string, limit = 20, filter?: IsolationFilter): Promise<L0FtsResult[]> {
    if (this.degraded || !this.ftsAvailable) return [];
    try {
      const rl = filter ? Math.max(limit * 5, limit) : limit;
      const iso = buildIsoClause(filter, 1);
      const wc = iso.clause ? "AND " + iso.clause : "";
      const r = await this.pool.query("SELECT record_id, session_key, session_id, team_id, task_id, user_id, agent_id, role, message_text, recorded_at, timestamp, ts_rank(message_tsv, websearch_to_tsquery('simple', $1)) AS rank FROM l0_conversations WHERE message_tsv @@ websearch_to_tsquery('simple', $1) " + wc + " ORDER BY rank DESC LIMIT $" + (iso.params.length + 2) + "::int", [ftsQuery, ...iso.params, rl]);
      return r.rows.filter((row: any) => rowMatchesIsolation(row, filter)).slice(0, limit).map((row: any) => ({ record_id: row.record_id, session_key: row.session_key, session_id: row.session_id, team_id: row.team_id ?? "", task_id: row.task_id ?? "", user_id: row.user_id ?? "", agent_id: row.agent_id ?? "", role: row.role, message_text: row.message_text, score: tsRankToScore(Number(row.rank)), recorded_at: row.recorded_at, timestamp: Number(row.timestamp) || 0 }));
    } catch (err) { this.logger?.warn(TAG + " searchL0Fts failed: " + (err instanceof Error ? err.message : String(err))); return []; }
  }

  // 鈹€鈹€ L0 Queries 鈹€鈹€

  async queryL0ForL1(sessionKey: string, afterRecordedAtMs?: number, limit = 50): Promise<L0QueryRow[]> {
    if (this.degraded) return [];
    try {
      let r;
      if (afterRecordedAtMs && afterRecordedAtMs > 0) {
        const iso = new Date(afterRecordedAtMs).toISOString();
        r = await this.pool.query("SELECT record_id, session_key, session_id, team_id, task_id, user_id, agent_id, role, message_text, recorded_at, timestamp FROM l0_conversations WHERE session_key = $1 AND recorded_at > $2 ORDER BY recorded_at ASC LIMIT $3::int", [sessionKey, iso, limit]);
      } else {
        r = await this.pool.query("SELECT record_id, session_key, session_id, team_id, task_id, user_id, agent_id, role, message_text, recorded_at, timestamp FROM l0_conversations WHERE session_key = $1 ORDER BY recorded_at ASC LIMIT $2::int", [sessionKey, limit]);
      }
      return r.rows.map((row: any) => ({ ...row, timestamp: Number(row.timestamp) })) as L0QueryRow[];
    } catch { return []; }
  }

  async queryL0GroupedBySessionId(sessionKey: string, afterRecordedAtMs?: number, limit = 50): Promise<L0SessionGroup[]> {
    if (this.degraded) return [];
    try {
      const rows = await this.queryL0ForL1(sessionKey, afterRecordedAtMs, limit);
      const gm = new Map<string, L0SessionGroup>();
      for (const row of rows) {
        const gk = (row.team_id ?? "") + "\0" + (row.user_id ?? "") + "\0" + (row.agent_id ?? "") + "\0" + (row.session_id ?? "") + "\0" + (row.task_id ?? "");
        let g = gm.get(gk);
        if (!g) { g = { sessionId: row.session_id || "", teamId: row.team_id || undefined, taskId: row.task_id || undefined, userId: row.user_id || "", agentId: row.agent_id || "", messages: [] }; gm.set(gk, g); }
        g.messages.push({ id: row.record_id, role: row.role, content: row.message_text, timestamp: Number(row.timestamp), recordedAtMs: row.recorded_at ? Date.parse(row.recorded_at) || 0 : 0 });
      }
      const groups = [...gm.values()].filter(g => g.messages.length > 0);
      groups.sort((a, b) => a.messages[0].timestamp - b.messages[0].timestamp);
      return groups;
    } catch { return []; }
  }

  // 鈹€鈹€ Paginated Queries 鈹€鈹€

  async queryL0Paginated(filter: L0PaginatedFilter): Promise<L0PaginatedResult> {
    if (this.degraded) return { rows: [], total: 0 };
    try {
      const c: string[] = []; const p: unknown[] = []; let i = 0;
      if (filter.sessionId) { c.push("(session_key = $" + (++i) + " OR session_id = $" + (++i) + ")"); p.push(filter.sessionId, filter.sessionId); }
      if (filter.teamId !== undefined) { c.push("team_id = $" + (++i)); p.push(filter.teamId); }
      if (filter.userId !== undefined) { c.push("user_id = $" + (++i)); p.push(filter.userId); }
      if (filter.agentId !== undefined) { c.push("agent_id = $" + (++i)); p.push(filter.agentId); }
      if (filter.taskId !== undefined) { c.push("task_id = $" + (++i)); p.push(filter.taskId); }
      if (filter.timeStartMs !== undefined) { c.push("timestamp >= $" + (++i)); p.push(filter.timeStartMs); }
      if (filter.timeEndMs !== undefined) { c.push("timestamp <= $" + (++i)); p.push(filter.timeEndMs); }
      const w = c.length > 0 ? "WHERE " + c.join(" AND ") : "";
      const cr = await this.pool.query("SELECT COUNT(*) AS cnt FROM l0_conversations " + w, p);
      const total = parseInt(cr.rows[0]?.cnt ?? "0", 10);
      const dr = await this.pool.query("SELECT record_id, session_key, session_id, team_id, task_id, user_id, agent_id, role, message_text, recorded_at, timestamp FROM l0_conversations " + w + " ORDER BY timestamp DESC LIMIT $" + (++i) + "::int OFFSET $" + (++i) + "::int", [...p, filter.limit, filter.offset]);
      return { rows: dr.rows as L0QueryRow[], total };
    } catch { return { rows: [], total: 0 }; }
  }

  async queryL1Paginated(filter: L1PaginatedFilter): Promise<L1PaginatedResult> {
    if (this.degraded) return { rows: [], total: 0 };
    try {
      const c: string[] = []; const p: unknown[] = []; let i = 0;
      if (filter.type) { c.push("type = $" + (++i)); p.push(filter.type); }
      if (filter.sessionId) { c.push("session_id = $" + (++i)); p.push(filter.sessionId); }
      if (filter.teamId !== undefined) { c.push("team_id = $" + (++i)); p.push(filter.teamId); }
      if (filter.userId !== undefined) { c.push("user_id = $" + (++i)); p.push(filter.userId); }
      if (filter.agentId !== undefined) { c.push("agent_id = $" + (++i)); p.push(filter.agentId); }
      if (filter.taskId !== undefined) { c.push("task_id = $" + (++i)); p.push(filter.taskId); }
      if (filter.timeStart) { c.push("updated_time >= $" + (++i)); p.push(filter.timeStart); }
      if (filter.timeEnd) { c.push("updated_time <= $" + (++i)); p.push(filter.timeEnd); }
      const w = c.length > 0 ? "WHERE " + c.join(" AND ") : "";
      const cr = await this.pool.query("SELECT COUNT(*) AS cnt FROM l1_records " + w, p);
      const total = parseInt(cr.rows[0]?.cnt ?? "0", 10);
      const dr = await this.pool.query("SELECT record_id, content, type, priority, scene_name, session_key, session_id, team_id, task_id, user_id, agent_id, version, timestamp_str, timestamp_start, timestamp_end, created_time, updated_time, metadata_json FROM l1_records " + w + " ORDER BY updated_time DESC LIMIT $" + (++i) + "::int OFFSET $" + (++i) + "::int", [...p, filter.limit, filter.offset]);
      return { rows: dr.rows as L1RecordRow[], total };
    } catch { return { rows: [], total: 0 }; }
  }

  async deleteL0BySession(sessionId: string, filter?: IsolationFilter): Promise<number> {
    if (this.degraded) return 0;
    try {
      const r = await this.pool.query("SELECT record_id, user_id, agent_id, session_id, session_key FROM l0_conversations WHERE session_key = $1 OR session_id = $1", [sessionId]);
      if (r.rows.length === 0) return 0;
      let cnt = 0;
      for (const row of r.rows) { if (filter && !rowMatchesIsolation(row, filter)) continue; const dr = await this.pool.query("DELETE FROM l0_conversations WHERE record_id = $1", [row.record_id]); if ((dr.rowCount ?? 0) > 0) cnt++; }
      return cnt;
    } catch { return 0; }
  }


  // 鈹€鈹€ Reindex 鈹€鈹€

  async reindexAll(embedFn: (text: string) => Promise<Float32Array>, onProgress?: (done: number, total: number, layer: "L1" | "L0") => void): Promise<{ l1Count: number; l0Count: number }> {
    if (this.degraded || !this.vecReady) return { l1Count: 0, l0Count: 0 };
    try {
      const l1rows = await this.getAllL1Texts();
      let l1Done = 0;
      for (const { record_id, content, updated_time } of l1rows) {
        try { const emb = await embedFn(content); await this.pool.query("UPDATE l1_records SET embedding = $1 WHERE record_id = $2", [float32ToPgVector(emb), record_id]); } catch {}
        l1Done++; onProgress?.(l1Done, l1rows.length, "L1");
      }
      const l0rows = await this.getAllL0Texts();
      let l0Done = 0;
      for (const { record_id, message_text } of l0rows) {
        try { const emb = await embedFn(message_text); await this.pool.query("UPDATE l0_conversations SET embedding = $1 WHERE record_id = $2", [float32ToPgVector(emb), record_id]); } catch {}
        l0Done++; onProgress?.(l0Done, l0rows.length, "L0");
      }
      this.logger?.info(TAG + " Reindex: L1=" + l1Done + "/" + l1rows.length + ", L0=" + l0Done + "/" + l0rows.length);
      return { l1Count: l1Done, l0Count: l0Done };
    } catch { return { l1Count: 0, l0Count: 0 }; }
  }

  // 鈹€鈹€ Entity CRUD 鈹€鈹€

  async createTeam(input: any): Promise<TeamEntity> {
    const now = new Date().toISOString();
    const id = input.team_id || this.entityId("team");
    await this.pool.query("INSERT INTO entity_teams (team_id, name, description, owner_user_id, user_ids_json, agent_ids_json, status, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [id, input.name, input.description ?? "", input.owner_user_id, this.jsonArray([input.owner_user_id]), this.jsonArray([]), input.status ?? "active", now, now]);
    return (await this.getTeam(id)) ?? { team_id: id, name: input.name, owner_user_id: input.owner_user_id, status: input.status ?? "active", created_at: now, updated_at: now };
  }

  async getTeam(teamId: string): Promise<TeamEntity | null> {
    const r = await this.pool.query("SELECT * FROM entity_teams WHERE team_id = $1", [teamId]);
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    const userIds = new Set(this.parseArray(row.user_ids_json)); if (row.owner_user_id) userIds.add(row.owner_user_id);
    const agentIds = new Set(this.parseArray(row.agent_ids_json));
    const ar = await this.pool.query("SELECT agent_id FROM entity_agents WHERE team_id = $1 AND status = 'active' ORDER BY agent_id", [teamId]);
    for (const a of ar.rows) agentIds.add(a.agent_id);
    const tr = await this.pool.query("SELECT task_id FROM entity_tasks WHERE team_id = $1 ORDER BY task_id", [teamId]);
    return { team_id: teamId, name: row.name, description: row.description || undefined, owner_user_id: row.owner_user_id, status: row.status || "active", user_ids: [...userIds].sort(), agent_ids: [...agentIds].sort(), task_ids: tr.rows.map((t: any) => t.task_id), created_at: row.created_at, updated_at: row.updated_at };
  }

  async updateTeam(teamId: string, patch: any): Promise<TeamEntity | null> {
    const cur = await this.getTeam(teamId); if (!cur) return null;
    const now = new Date().toISOString();
    const owner = patch.owner_user_id ?? cur.owner_user_id;
    const userIds = patch.user_ids !== undefined ? [...new Set([...patch.user_ids, owner])].sort() : cur.user_ids ?? [];
    const agentIds = patch.agent_ids !== undefined ? patch.agent_ids : cur.agent_ids ?? [];
    await this.pool.query("UPDATE entity_teams SET name=$1, description=$2, owner_user_id=$3, user_ids_json=$4, agent_ids_json=$5, status=$6, updated_at=$7 WHERE team_id=$8", [patch.name ?? cur.name, patch.description ?? cur.description ?? "", owner, this.jsonArray(userIds), this.jsonArray(agentIds), patch.status ?? cur.status, now, teamId]);
    return this.getTeam(teamId);
  }

  async deleteTeams(teamIds: string[]): Promise<BatchDeleteResult> {
    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    for (const id of teamIds) { const t = await this.getTeam(id); if (!t) { result.failed.push({ id, reason: "not_found" }); continue; } await this.updateTeam(id, { status: "archived" }); result.deleted_ids.push(id); }
    return result;
  }

  async createUser(input: any): Promise<UserEntity> {
    const now = new Date().toISOString();
    const id = input.user_id || this.entityId("user");
    await this.pool.query("INSERT INTO entity_users (user_id, name, job_description, team_ids_json, task_ids_json, owned_agent_ids_json, status, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [id, input.name, input.job_description ?? "", this.jsonArray([]), this.jsonArray([]), this.jsonArray([]), input.status ?? "active", now, now]);
    return (await this.getUser(id)) ?? { user_id: id, name: input.name, team_ids: [], task_ids: [], owned_agent_ids: [], status: input.status ?? "active", created_at: now, updated_at: now };
  }

  async getUser(userId: string): Promise<UserEntity | null> {
    const r = await this.pool.query("SELECT * FROM entity_users WHERE user_id = $1", [userId]);
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    const tr = await this.pool.query("SELECT team_id, owner_user_id, user_ids_json FROM entity_teams WHERE status = 'active'");
    const teamIds = tr.rows.filter((t: any) => t.owner_user_id === userId || this.parseArray(t.user_ids_json).includes(userId)).map((t: any) => t.team_id).sort();
    const ar = await this.pool.query("SELECT agent_id FROM entity_agents WHERE owner_user_id = $1 AND status = 'active' ORDER BY agent_id", [userId]);
    return { user_id: userId, name: row.name, job_description: row.job_description || undefined, team_ids: teamIds, task_ids: [], owned_agent_ids: ar.rows.map((a: any) => a.agent_id), status: row.status || "active", created_at: row.created_at, updated_at: row.updated_at };
  }

  async updateUser(userId: string, patch: any): Promise<UserEntity | null> {
    const cur = await this.getUser(userId); if (!cur) return null;
    const now = new Date().toISOString();
    await this.pool.query("UPDATE entity_users SET name=$1, job_description=$2, status=$3, updated_at=$4 WHERE user_id=$5", [patch.name ?? cur.name, patch.job_description ?? cur.job_description ?? "", patch.status ?? cur.status, now, userId]);
    return this.getUser(userId);
  }

  async deleteUsers(userIds: string[]): Promise<BatchDeleteResult> {
    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    for (const id of userIds) { if (!(await this.getUser(id))) { result.failed.push({ id, reason: "not_found" }); continue; } await this.updateUser(id, { status: "inactive" }); result.deleted_ids.push(id); }
    return result;
  }

  async createAgent(input: any): Promise<AgentEntity> {
    const now = new Date().toISOString();
    const id = input.agent_id || this.entityId("agent");
    await this.pool.query("INSERT INTO entity_agents (agent_id, team_id, name, description, prompt, owner_user_id, visibility, status, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [id, input.team_id, input.name, input.description ?? "", input.prompt ?? "", input.owner_user_id ?? "", input.visibility ?? "team", input.status ?? "active", now, now]);
    const team = await this.getTeam(input.team_id);
    if (team && !(team.agent_ids ?? []).includes(id)) await this.updateTeam(input.team_id, { agent_ids: [...(team.agent_ids ?? []), id] });
    return (await this.getAgent(id)) ?? { agent_id: id, team_id: input.team_id, name: input.name, visibility: input.visibility ?? "team", status: input.status ?? "active", created_at: now, updated_at: now };
  }

  async getAgent(agentId: string): Promise<AgentEntity | null> {
    const r = await this.pool.query("SELECT * FROM entity_agents WHERE agent_id = $1", [agentId]);
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    const tr = await this.pool.query("SELECT task_id, agent_ids_json FROM entity_tasks ORDER BY task_id");
    const taskIds = tr.rows.filter((t: any) => this.parseArray(t.agent_ids_json).includes(agentId)).map((t: any) => t.task_id);
    return { agent_id: agentId, team_id: row.team_id, name: row.name, description: row.description || undefined, prompt: row.prompt || undefined, owner_user_id: row.owner_user_id || undefined, visibility: row.visibility || "team", status: row.status || "active", task_ids: taskIds, created_at: row.created_at, updated_at: row.updated_at };
  }

  async updateAgent(agentId: string, patch: any): Promise<AgentEntity | null> {
    const cur = await this.getAgent(agentId); if (!cur) return null;
    const now = new Date().toISOString();
    await this.pool.query("UPDATE entity_agents SET name=$1, description=$2, prompt=$3, owner_user_id=$4, visibility=$5, status=$6, updated_at=$7 WHERE agent_id=$8", [patch.name ?? cur.name, patch.description ?? cur.description ?? "", patch.prompt ?? cur.prompt ?? "", patch.owner_user_id ?? cur.owner_user_id ?? "", patch.visibility ?? cur.visibility, patch.status ?? cur.status, now, agentId]);
    return this.getAgent(agentId);
  }

  async deleteAgents(agentIds: string[]): Promise<BatchDeleteResult> {
    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    for (const id of agentIds) { if (!(await this.getAgent(id))) { result.failed.push({ id, reason: "not_found" }); continue; } await this.updateAgent(id, { status: "inactive" }); result.deleted_ids.push(id); }
    return result;
  }

  async createTask(input: any): Promise<TaskEntity> {
    const now = new Date().toISOString();
    const id = input.task_id || this.entityId("task");
    await this.pool.query("INSERT INTO entity_tasks (task_id, team_id, creator_user_id, title, description, source_type, source_url, status, auto_assign_floating_assets, risk_level, agent_ids_json, user_ids_json, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)", [id, input.team_id, input.creator_user_id, input.title ?? "", input.description ?? "", input.source_type ?? "manual", input.source_url ?? "", "pending", 0, "low", this.jsonArray(input.agent_ids), this.jsonArray(input.user_ids), now, now]);
    return (await this.getTask(id)) ?? { task_id: id, team_id: input.team_id, creator_user_id: input.creator_user_id, source_type: input.source_type ?? "manual", agent_ids: input.agent_ids ?? [], user_ids: input.user_ids ?? [], created_at: now, updated_at: now };
  }

  async getTask(taskId: string): Promise<TaskEntity | null> {
    const r = await this.pool.query("SELECT * FROM entity_tasks WHERE task_id = $1", [taskId]);
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    return { task_id: taskId, team_id: row.team_id, creator_user_id: row.creator_user_id, title: row.title || undefined, description: row.description || undefined, source_type: row.source_type || "manual", source_url: row.source_url || undefined, agent_ids: this.parseArray(row.agent_ids_json), user_ids: this.parseArray(row.user_ids_json), created_at: row.created_at, updated_at: row.updated_at };
  }

  async updateTask(taskId: string, patch: any): Promise<TaskEntity | null> {
    const cur = await this.getTask(taskId); if (!cur) return null;
    const now = new Date().toISOString();
    await this.pool.query("UPDATE entity_tasks SET title=$1, description=$2, source_type=$3, source_url=$4, agent_ids_json=$5, user_ids_json=$6, updated_at=$7 WHERE task_id=$8", [patch.title ?? cur.title ?? "", patch.description ?? cur.description ?? "", patch.source_type ?? cur.source_type, patch.source_url ?? cur.source_url ?? "", this.jsonArray(patch.agent_ids ?? cur.agent_ids), this.jsonArray(patch.user_ids ?? cur.user_ids), now, taskId]);
    return this.getTask(taskId);
  }

  async deleteTasks(taskIds: string[]): Promise<BatchDeleteResult> {
    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    for (const id of taskIds) { if (!(await this.getTask(id))) { result.failed.push({ id, reason: "not_found" }); continue; } await this.pool.query("DELETE FROM entity_tasks WHERE task_id = $1", [id]); result.deleted_ids.push(id); }
    return result;
  }

  // 鈹€鈹€ Knowledge 鈹€鈹€

  async createKnowledge(input: any): Promise<KnowledgeEntity> {
    const now = new Date().toISOString();
    const ex = await this.pool.query("SELECT created_at FROM entity_knowledge WHERE knowledge_id = $1", [input.knowledge_id]);
    if (ex.rows.length > 0) {
      await this.pool.query("UPDATE entity_knowledge SET type=$1, service_url=$2, name=$3, summary=$4, team_id=$5, agent_id=$6, user_id=$7, repo_url=$8, branch=$9, updated_at=$10 WHERE knowledge_id=$11", [input.type, input.service_url, input.name, input.summary ?? null, input.team_id, input.agent_id ?? "", input.user_id ?? null, input.repo_url ?? null, input.branch ?? null, now, input.knowledge_id]);
    } else {
      await this.pool.query("INSERT INTO entity_knowledge (knowledge_id, type, service_url, name, summary, team_id, agent_id, user_id, repo_url, branch, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)", [input.knowledge_id, input.type, input.service_url, input.name, input.summary ?? null, input.team_id, input.agent_id ?? "", input.user_id ?? null, input.repo_url ?? null, input.branch ?? null, now, now]);
    }
    return (await this.getKnowledge(input.knowledge_id))!;
  }

  async getKnowledge(knowledgeId: string): Promise<KnowledgeEntity | null> {
    const r = await this.pool.query("SELECT * FROM entity_knowledge WHERE knowledge_id = $1", [knowledgeId]);
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    return { knowledge_id: row.knowledge_id, type: row.type, service_url: row.service_url, name: row.name, summary: row.summary ?? null, team_id: row.team_id, agent_id: row.agent_id ?? "", user_id: row.user_id ?? null, repo_url: row.repo_url ?? undefined, branch: row.branch ?? undefined, created_at: row.created_at, updated_at: row.updated_at };
  }

  async updateKnowledge(knowledgeId: string, patch: any): Promise<KnowledgeEntity | null> {
    const cur = await this.getKnowledge(knowledgeId); if (!cur) return null;
    const now = new Date().toISOString();
    const sets: string[] = ["updated_at = $1"]; const args: unknown[] = [now]; let idx = 1;
    if (patch.name !== undefined) { sets.push("name = $" + (++idx)); args.push(patch.name); }
    if (patch.summary !== undefined) { sets.push("summary = $" + (++idx)); args.push(patch.summary); }
    if (patch.service_url !== undefined) { sets.push("service_url = $" + (++idx)); args.push(patch.service_url); }
    if (patch.repo_url !== undefined) { sets.push("repo_url = $" + (++idx)); args.push(patch.repo_url); }
    if (patch.branch !== undefined) { sets.push("branch = $" + (++idx)); args.push(patch.branch); }
    args.push(knowledgeId);
    await this.pool.query("UPDATE entity_knowledge SET " + sets.join(", ") + " WHERE knowledge_id = $" + (++idx), args);
    return this.getKnowledge(knowledgeId);
  }

  async deleteKnowledge(knowledgeIds: string[], teamId?: string): Promise<BatchDeleteResult> {
    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    for (const id of knowledgeIds) {
      const row = await this.getKnowledge(id);
      if (!row) { result.failed.push({ id, reason: "not_found" }); continue; }
      if (teamId && row.team_id !== teamId) { result.failed.push({ id, reason: "team_mismatch" }); continue; }
      await this.pool.query("DELETE FROM entity_knowledge WHERE knowledge_id = $1", [id]);
      result.deleted_ids.push(id);
    }
    return result;
  }

  async listKnowledge(input: { team_id: string; type?: KnowledgeType; knowledge_ids?: string[]; limit?: number; offset?: number }): Promise<KnowledgeListResult> {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 1000);
    const offset = Math.max(input.offset ?? 0, 0);
    const ids = input.knowledge_ids;
    if (ids && ids.length === 0) return { items: [], total: 0 };
    const c: string[] = ["team_id = $1"]; const p: unknown[] = [input.team_id]; let i = 1;
    if (input.type) { c.push("type = $" + (++i)); p.push(input.type); }
    if (ids && ids.length > 0) { c.push("knowledge_id = ANY($" + (++i) + ")"); p.push(ids); }
    const w = "WHERE " + c.join(" AND ");
    const cr = await this.pool.query("SELECT COUNT(*) AS cnt FROM entity_knowledge " + w, p);
    const total = parseInt(cr.rows[0]?.cnt ?? "0", 10);
    const dr = await this.pool.query("SELECT * FROM entity_knowledge " + w + " ORDER BY updated_at DESC LIMIT $" + (++i) + "::int OFFSET $" + (++i) + "::int", [...p, limit, offset]);
    const items = dr.rows.map((row: any) => ({ knowledge_id: row.knowledge_id, type: row.type, service_url: row.service_url, name: row.name, summary: row.summary ?? null, team_id: row.team_id, agent_id: row.agent_id ?? "", user_id: row.user_id ?? null, repo_url: row.repo_url ?? undefined, branch: row.branch ?? undefined, created_at: row.created_at, updated_at: row.updated_at }));
    return { items, total };
  }

  // 鈹€鈹€ Audit 鈹€鈹€

  async appendAudit(entry: AuditEntry): Promise<void> {
    await this.pool.query("INSERT INTO memory_audit (audit_id, record_id, layer, action, team_id, agent_id, user_id, task_id, version, updated_at_ms, request_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (audit_id) DO NOTHING", [entry.audit_id, entry.record_id, entry.layer, entry.action, entry.team_id ?? null, entry.agent_id ?? null, entry.user_id ?? null, entry.task_id ?? null, entry.version, entry.updated_at_ms, entry.request_id ?? null]);
  }

  async queryAudit(filter: AuditQueryFilter): Promise<AuditEntry[]> {
    const c: string[] = []; const p: unknown[] = []; let i = 0;
    if (filter.record_id !== undefined) { c.push("record_id = $" + (++i)); p.push(filter.record_id); }
    if (filter.layer !== undefined) { c.push("layer = $" + (++i)); p.push(filter.layer); }
    if (filter.action !== undefined) { c.push("action = $" + (++i)); p.push(filter.action); }
    if (filter.team_id !== undefined) { c.push("team_id = $" + (++i)); p.push(filter.team_id); }
    if (filter.agent_id !== undefined) { c.push("agent_id = $" + (++i)); p.push(filter.agent_id); }
    if (filter.user_id !== undefined) { c.push("user_id = $" + (++i)); p.push(filter.user_id); }
    if (filter.task_id !== undefined) { c.push("task_id = $" + (++i)); p.push(filter.task_id); }
    if (filter.since_ms !== undefined) { c.push("updated_at_ms >= $" + (++i)); p.push(filter.since_ms); }
    if (filter.until_ms !== undefined) { c.push("updated_at_ms <= $" + (++i)); p.push(filter.until_ms); }
    const w = c.length > 0 ? "WHERE " + c.join(" AND ") : "";
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000);
    const offset = Math.max(filter.offset ?? 0, 0);
    const r = await this.pool.query("SELECT audit_id, record_id, layer, action, team_id, agent_id, user_id, task_id, version, updated_at_ms, request_id FROM memory_audit " + w + " ORDER BY updated_at_ms DESC, audit_id DESC LIMIT $" + (++i) + "::int OFFSET $" + (++i) + "::int", [...p, limit, offset]);
    return r.rows.map((row: any) => ({ audit_id: row.audit_id, record_id: row.record_id, layer: row.layer, action: row.action, team_id: row.team_id ?? undefined, agent_id: row.agent_id ?? undefined, user_id: row.user_id ?? undefined, task_id: row.task_id ?? undefined, version: row.version, updated_at_ms: Number(row.updated_at_ms), request_id: row.request_id ?? undefined }));
  }
}


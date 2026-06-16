import { Pool, type PoolClient } from "pg";
import type { PostgresConfig } from "../../config.js";
import type { MemoryRecord } from "../record/l1-writer.js";
import type { EmbeddingProviderInfo } from "./embedding.js";
import type {
  IMemoryStore,
  L0FtsResult,
  L0QueryRow,
  L0Record,
  L0SearchResult,
  L0SessionGroup,
  L1FtsResult,
  L1QueryFilter,
  L1RecordRow,
  L1SearchResult,
  ProfileRecord,
  ProfileSyncRecord,
  StoreCapabilities,
  StoreInitResult,
  StoreLogger,
} from "./types.js";
import {
  initPostgresSchema,
  postgresIndexName,
  POSTGRES_TABLES,
  qualifiedName,
  quoteIdent,
} from "./postgres-schema.js";

const TAG = "[memory-tdai][postgres]";
const ZERO_VEC_BUFFER = 10;
const FTS_DEFAULT_LIMIT = 20;
const DELETE_RATIO_LIMIT = 0.8;

export class PgMemoryStore implements IMemoryStore {
  readonly supportsDeferredEmbedding = true;

  private readonly pool: Pool;
  private readonly config: PostgresConfig;
  private readonly dimensions: number;
  private readonly logger?: StoreLogger;
  private degraded = false;
  private closed = false;
  private vectorAvailable = false;
  private ftsAvailable = false;

  constructor(config: PostgresConfig, dimensions: number, logger?: StoreLogger) {
    this.config = config;
    this.dimensions = dimensions;
    this.logger = logger;
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      max: config.poolMax,
      statement_timeout: config.statementTimeoutMs,
      application_name: "tencentdb-agent-memory",
    });

    this.pool.on("connect", (client) => {
      void client.query(`SET search_path TO ${quoteIdent(config.schema)}, public`).catch((err: unknown) => {
        this.logger?.warn?.(`${TAG} failed to set search_path: ${errorMessage(err)}`);
      });
    });
  }

  async init(providerInfo?: EmbeddingProviderInfo): Promise<StoreInitResult> {
    try {
      const result = await initPostgresSchema(
        this.pool,
        {
          schema: this.config.schema,
          dimensions: this.dimensions,
          textConfig: this.config.textConfig,
          vectorIndex: this.config.vectorIndex,
          useVectorScale: this.config.useVectorScale,
          logger: this.logger,
        },
        providerInfo,
      );
      this.vectorAvailable = result.vectorAvailable;
      this.ftsAvailable = result.ftsAvailable;
      this.degraded = false;
      this.logger?.debug?.(
        `${TAG} initialized: ${this.safeConnectionLabel()}, schema=${this.config.schema}, ` +
        `vector=${this.vectorAvailable}, fts=${this.ftsAvailable}`,
      );
      return { needsReindex: result.needsReindex, reason: result.reason };
    } catch (err) {
      this.degraded = true;
      const message = errorMessage(err);
      this.logger?.error?.(`${TAG} init failed; entering degraded mode: ${message}`);
      return { needsReindex: false, reason: message };
    }
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  getCapabilities(): StoreCapabilities {
    return {
      vectorSearch: !this.degraded && this.vectorAvailable,
      ftsSearch: !this.degraded && this.ftsAvailable,
      nativeHybridSearch: !this.degraded && this.ftsAvailable && this.vectorAvailable,
      sparseVectors: false,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    void this.pool.end().catch((err: unknown) => {
      this.logger?.warn?.(`${TAG} close failed: ${errorMessage(err)}`);
    });
  }

  async upsertL1(record: MemoryRecord, embedding?: Float32Array): Promise<boolean> {
    if (this.degraded) return false;
    const tsStr = record.timestamps[0] ?? "";
    const tsStart = record.timestamps.length > 0 ? record.timestamps.reduce((a, b) => (a < b ? a : b)) : tsStr;
    const tsEnd = record.timestamps.length > 0 ? record.timestamps.reduce((a, b) => (a > b ? a : b)) : tsStr;
    const vec = this.prepareVector(embedding);

    try {
      await this.pool.query(
        `INSERT INTO ${this.table(POSTGRES_TABLES.l1)} (
           record_id, content, type, priority, scene_name, session_key, session_id,
           timestamp_str, timestamp_start, timestamp_end, created_time, updated_time,
           metadata_json, embedding
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::vector)
         ON CONFLICT (record_id) DO UPDATE SET
           content = EXCLUDED.content,
           type = EXCLUDED.type,
           priority = EXCLUDED.priority,
           scene_name = EXCLUDED.scene_name,
           session_key = EXCLUDED.session_key,
           session_id = EXCLUDED.session_id,
           timestamp_str = EXCLUDED.timestamp_str,
           timestamp_start = EXCLUDED.timestamp_start,
           timestamp_end = EXCLUDED.timestamp_end,
           updated_time = EXCLUDED.updated_time,
           metadata_json = EXCLUDED.metadata_json,
           embedding = COALESCE(EXCLUDED.embedding, ${this.table(POSTGRES_TABLES.l1)}.embedding)`,
        [
          record.id,
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
          JSON.stringify(record.metadata ?? {}),
          vec,
        ],
      );
      return true;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [L1-upsert] FAILED id=${record.id}: ${errorMessage(err)}`);
      return false;
    }
  }

  async upsertL1Batch(records: MemoryRecord[]): Promise<number> {
    let ok = 0;
    for (const record of records) {
      if (await this.upsertL1(record)) ok++;
    }
    return ok;
  }

  async deleteL1(recordId: string): Promise<boolean> {
    if (this.degraded) return false;
    try {
      await this.pool.query(`DELETE FROM ${this.table(POSTGRES_TABLES.l1)} WHERE record_id = $1`, [recordId]);
      return true;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [L1-delete] FAILED id=${recordId}: ${errorMessage(err)}`);
      return false;
    }
  }

  async deleteL1Batch(recordIds: string[]): Promise<boolean> {
    if (this.degraded) return false;
    if (recordIds.length === 0) return true;
    try {
      await this.pool.query(`DELETE FROM ${this.table(POSTGRES_TABLES.l1)} WHERE record_id = ANY($1::text[])`, [recordIds]);
      return true;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [L1-delete-batch] FAILED: ${errorMessage(err)}`);
      return false;
    }
  }

  async deleteL1Expired(cutoffIso: string): Promise<number> {
    return this.deleteExpired(POSTGRES_TABLES.l1, "updated_time", cutoffIso, "L1");
  }

  async countL1(): Promise<number> {
    return this.countTable(POSTGRES_TABLES.l1);
  }

  async queryL1Records(filter?: L1QueryFilter): Promise<L1RecordRow[]> {
    if (this.degraded) return [];
    try {
      const conditions: string[] = [];
      const values: unknown[] = [];
      if (filter?.sessionId) {
        values.push(filter.sessionId);
        conditions.push(`session_id = $${values.length}`);
      } else if (filter?.sessionKey) {
        values.push(filter.sessionKey);
        conditions.push(`session_key = $${values.length}`);
      }
      if (filter?.updatedAfter) {
        values.push(filter.updatedAfter);
        conditions.push(`updated_time > $${values.length}`);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const rows = await this.pool.query<L1RecordRow>(`
        SELECT ${this.l1Columns()}
        FROM ${this.table(POSTGRES_TABLES.l1)}
        ${where}
        ORDER BY updated_time ASC
      `, values);
      return rows.rows;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [L1-query] FAILED: ${errorMessage(err)}`);
      return [];
    }
  }

  async getAllL1Texts(): Promise<Array<{ record_id: string; content: string; updated_time: string }>> {
    if (this.degraded) return [];
    try {
      const rows = await this.pool.query<{ record_id: string; content: string; updated_time: string }>(
        `SELECT record_id, content, updated_time FROM ${this.table(POSTGRES_TABLES.l1)} ORDER BY record_id ASC`,
      );
      return rows.rows;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [L1-all-texts] FAILED: ${errorMessage(err)}`);
      return [];
    }
  }

  async searchL1Vector(queryEmbedding: Float32Array, topK = 5): Promise<L1SearchResult[]> {
    if (this.degraded || !this.vectorAvailable || !this.isValidQueryVector(queryEmbedding)) return [];
    try {
      const limit = topK + ZERO_VEC_BUFFER;
      const rows = await this.pool.query<L1SearchResult>(`
        SELECT ${this.l1SearchColumns()}, 1 - (embedding <=> $1::vector) AS score
        FROM ${this.table(POSTGRES_TABLES.l1)}
        WHERE embedding IS NOT NULL AND vector_dims(embedding) = $2
        ORDER BY embedding <=> $1::vector
        LIMIT $3
      `, [vectorToSql(queryEmbedding), this.dimensions, limit]);
      return rows.rows.slice(0, topK).map(normalizeL1Score);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [L1-vector] FAILED: ${errorMessage(err)}`);
      return [];
    }
  }

  async searchL1Fts(ftsQuery: string, limit = FTS_DEFAULT_LIMIT): Promise<L1FtsResult[]> {
    if (this.degraded || !this.ftsAvailable) return [];
    const query = normalizeBm25Query(ftsQuery);
    if (!query) return [];
    try {
      const rows = await this.pool.query<L1FtsResult & { rank: number }>(`
        SELECT ${this.l1SearchColumns()}, content <@> to_bm25query($1, $3) AS rank
        FROM ${this.table(POSTGRES_TABLES.l1)}
        ORDER BY content <@> to_bm25query($1, $3)
        LIMIT $2
      `, [query, limit, postgresIndexName(this.config.schema, "l1_content_bm25_idx")]);
      return rows.rows.map((row) => ({ ...row, score: bm25RankToScore(Number(row.rank)) }));
    } catch (err) {
      this.logger?.warn?.(`${TAG} [L1-fts] FAILED: ${errorMessage(err)}`);
      return [];
    }
  }

  async searchL1Hybrid(params: {
    query?: string;
    queryEmbedding?: Float32Array;
    topK?: number;
  }): Promise<L1SearchResult[]> {
    const topK = params.topK ?? 5;

    // Native single-SQL RRF only when BOTH modalities are usable; otherwise fall
    // through to the parallel + client-side RRF path so a single available
    // modality still degrades gracefully instead of returning empty.
    const normalizedFts = params.query ? normalizeBm25Query(params.query) : undefined;
    if (
      normalizedFts &&
      params.queryEmbedding &&
      this.isValidQueryVector(params.queryEmbedding) &&
      !this.degraded &&
      this.ftsAvailable &&
      this.vectorAvailable
    ) {
      return this.searchL1HybridNative(
        normalizedFts,
        vectorToSql(params.queryEmbedding),
        topK,
      );
    }

    // Fallback: parallel calls + client-side RRF (when only one modality available)
    const [fts, vec] = await Promise.all([
      params.query ? this.searchL1Fts(params.query, topK * 3) : Promise.resolve([]),
      params.queryEmbedding ? this.searchL1Vector(params.queryEmbedding, topK * 3) : Promise.resolve([]),
    ]);
    return rrfMergeL1(fts, vec).slice(0, topK);
  }

  /**
   * Single-SQL hybrid search: BM25 + vector with Reciprocal Rank Fusion (RRF).
   */
  private async searchL1HybridNative(
    ftsQuery: string,
    vectorLiteral: string,
    topK: number,
  ): Promise<L1SearchResult[]> {
    if (this.degraded || !this.ftsAvailable || !this.vectorAvailable) return [];
    const candidateK = topK * 3;
    const dims = this.dimensions;
    const idxName = postgresIndexName(this.config.schema, "l1_content_bm25_idx");
    const tbl = this.table(POSTGRES_TABLES.l1);
    const columns = this.l1SearchColumns("b");

    try {
      const rows = await this.pool.query<L1SearchResult>(`
        WITH fts AS (
          SELECT record_id,
                 row_number() OVER (ORDER BY content <@> to_bm25query($1, $2)) AS rnk
          FROM ${tbl}
          ORDER BY content <@> to_bm25query($1, $2)
          LIMIT $3
        ),
        vec AS (
          SELECT record_id,
                 row_number() OVER (ORDER BY embedding <=> $4::vector) AS rnk
          FROM ${tbl}
          WHERE embedding IS NOT NULL AND vector_dims(embedding) = $5
          ORDER BY embedding <=> $4::vector
          LIMIT $3
        ),
        fused AS (
          SELECT record_id,
                 COALESCE(1.0 / (60 + fts.rnk), 0) + COALESCE(1.0 / (60 + vec.rnk), 0) AS score
          FROM fts
          FULL OUTER JOIN vec USING (record_id)
        )
        SELECT ${columns},
               fused.score AS score
        FROM fused
        JOIN ${tbl} b ON b.record_id = fused.record_id
        ORDER BY score DESC
        LIMIT $6
      `, [ftsQuery, idxName, candidateK, vectorLiteral, dims, topK]);
      return rows.rows.map(normalizeL1Score);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [L1-hybrid-native] FAILED: ${errorMessage(err)}`);
      return [];
    }
  }

  async upsertL0(record: L0Record, embedding?: Float32Array): Promise<boolean> {
    if (this.degraded) return false;
    const vec = this.prepareVector(embedding);
    try {
      await this.pool.query(
        `INSERT INTO ${this.table(POSTGRES_TABLES.l0)} (
           record_id, session_key, session_id, role, message_text, recorded_at, timestamp, embedding
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::vector)
         ON CONFLICT (record_id) DO UPDATE SET
           session_key = EXCLUDED.session_key,
           session_id = EXCLUDED.session_id,
           role = EXCLUDED.role,
           message_text = EXCLUDED.message_text,
           recorded_at = EXCLUDED.recorded_at,
           timestamp = EXCLUDED.timestamp,
           embedding = COALESCE(EXCLUDED.embedding, ${this.table(POSTGRES_TABLES.l0)}.embedding)`,
        [record.id, record.sessionKey, record.sessionId, record.role, record.messageText, record.recordedAt, record.timestamp, vec],
      );
      return true;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [L0-upsert] FAILED id=${record.id}: ${errorMessage(err)}`);
      return false;
    }
  }

  async upsertL0Batch(records: L0Record[]): Promise<number> {
    let ok = 0;
    for (const record of records) {
      if (await this.upsertL0(record)) ok++;
    }
    return ok;
  }

  async updateL0Embedding(recordId: string, embedding: Float32Array): Promise<boolean> {
    if (this.degraded || !this.vectorAvailable) return false;
    const vec = this.prepareVector(embedding);
    if (!vec) return false;
    try {
      await this.pool.query(`UPDATE ${this.table(POSTGRES_TABLES.l0)} SET embedding = $2::vector WHERE record_id = $1`, [recordId, vec]);
      return true;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [L0-update-embedding] FAILED id=${recordId}: ${errorMessage(err)}`);
      return false;
    }
  }

  async deleteL0(recordId: string): Promise<boolean> {
    if (this.degraded) return false;
    try {
      await this.pool.query(`DELETE FROM ${this.table(POSTGRES_TABLES.l0)} WHERE record_id = $1`, [recordId]);
      return true;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [L0-delete] FAILED id=${recordId}: ${errorMessage(err)}`);
      return false;
    }
  }

  async deleteL0Expired(cutoffIso: string): Promise<number> {
    return this.deleteExpired(POSTGRES_TABLES.l0, "recorded_at", cutoffIso, "L0");
  }

  async countL0(): Promise<number> {
    return this.countTable(POSTGRES_TABLES.l0);
  }

  async queryL0ForL1(sessionKey: string, afterRecordedAtMs?: number, limit = 50): Promise<L0QueryRow[]> {
    if (this.degraded) return [];
    try {
      const values: unknown[] = [sessionKey];
      let where = "session_key = $1";
      if (afterRecordedAtMs && afterRecordedAtMs > 0) {
        values.push(new Date(afterRecordedAtMs).toISOString());
        where += ` AND recorded_at > $${values.length}`;
      }
      values.push(limit);
      const rows = await this.pool.query<L0QueryRow>(`
        SELECT record_id, session_key, session_id, role, message_text, recorded_at, timestamp::bigint AS timestamp
        FROM ${this.table(POSTGRES_TABLES.l0)}
        WHERE ${where}
        ORDER BY recorded_at DESC
        LIMIT $${values.length}
      `, values);
      return rows.rows.map(normalizeL0Row).reverse();
    } catch (err) {
      this.logger?.warn?.(`${TAG} [L0-query] FAILED: ${errorMessage(err)}`);
      return [];
    }
  }

  async queryL0GroupedBySessionId(sessionKey: string, afterRecordedAtMs?: number, limit = 50): Promise<L0SessionGroup[]> {
    const rows = await this.queryL0ForL1(sessionKey, afterRecordedAtMs, limit);
    const groups = new Map<string, L0SessionGroup["messages"]>();
    for (const row of rows) {
      const group = groups.get(row.session_id) ?? [];
      group.push({
        id: row.record_id,
        role: row.role,
        content: row.message_text,
        timestamp: row.timestamp,
        recordedAtMs: row.recorded_at ? Date.parse(row.recorded_at) || 0 : 0,
      });
      groups.set(row.session_id, group);
    }
    return [...groups.entries()]
      .map(([sessionId, messages]) => ({ sessionId, messages }))
      .sort((a, b) => (a.messages[0]?.timestamp ?? 0) - (b.messages[0]?.timestamp ?? 0));
  }

  async getAllL0Texts(): Promise<Array<{ record_id: string; message_text: string; recorded_at: string }>> {
    if (this.degraded) return [];
    try {
      const rows = await this.pool.query<{ record_id: string; message_text: string; recorded_at: string }>(
        `SELECT record_id, message_text, recorded_at FROM ${this.table(POSTGRES_TABLES.l0)} ORDER BY record_id ASC`,
      );
      return rows.rows;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [L0-all-texts] FAILED: ${errorMessage(err)}`);
      return [];
    }
  }

  async searchL0Vector(queryEmbedding: Float32Array, topK = 5): Promise<L0SearchResult[]> {
    if (this.degraded || !this.vectorAvailable || !this.isValidQueryVector(queryEmbedding)) return [];
    try {
      const limit = topK + ZERO_VEC_BUFFER;
      const rows = await this.pool.query<L0SearchResult>(`
        SELECT record_id, session_key, session_id, role, message_text,
               1 - (embedding <=> $1::vector) AS score,
               recorded_at, timestamp::bigint AS timestamp
        FROM ${this.table(POSTGRES_TABLES.l0)}
        WHERE embedding IS NOT NULL AND vector_dims(embedding) = $2
        ORDER BY embedding <=> $1::vector
        LIMIT $3
      `, [vectorToSql(queryEmbedding), this.dimensions, limit]);
      return rows.rows.slice(0, topK).map(normalizeL0SearchRow);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [L0-vector] FAILED: ${errorMessage(err)}`);
      return [];
    }
  }

  async searchL0Fts(ftsQuery: string, limit = FTS_DEFAULT_LIMIT): Promise<L0FtsResult[]> {
    if (this.degraded || !this.ftsAvailable) return [];
    const query = normalizeBm25Query(ftsQuery);
    if (!query) return [];
    try {
      const rows = await this.pool.query<L0FtsResult & { rank: number }>(`
        SELECT record_id, session_key, session_id, role, message_text,
               message_text <@> to_bm25query($1, $3) AS rank,
               recorded_at, timestamp::bigint AS timestamp
        FROM ${this.table(POSTGRES_TABLES.l0)}
        ORDER BY message_text <@> to_bm25query($1, $3)
        LIMIT $2
      `, [query, limit, postgresIndexName(this.config.schema, "l0_message_bm25_idx")]);
      return rows.rows.map((row) => ({ ...normalizeL0SearchRow(row), score: bm25RankToScore(Number(row.rank)) }));
    } catch (err) {
      this.logger?.warn?.(`${TAG} [L0-fts] FAILED: ${errorMessage(err)}`);
      return [];
    }
  }

  async pullProfiles(): Promise<ProfileRecord[]> {
    if (this.degraded) return [];
    try {
      const rows = await this.pool.query<{
        record_id: string;
        type: "l2" | "l3";
        filename: string;
        content: string;
        content_md5: string;
        agent_id: string;
        version: number;
        created_at_ms: string;
        updated_at_ms: string;
      }>(`
        SELECT record_id, type, filename, content, content_md5, agent_id, version,
               created_at_ms::bigint AS created_at_ms, updated_at_ms::bigint AS updated_at_ms
        FROM ${this.table(POSTGRES_TABLES.profiles)}
        ORDER BY type ASC, filename ASC
      `);
      return rows.rows.map((row) => ({
        id: row.record_id,
        type: row.type === "l3" ? "l3" : "l2",
        filename: row.filename,
        content: row.content,
        contentMd5: row.content_md5,
        agentId: row.agent_id || undefined,
        version: Number(row.version ?? 0),
        createdAtMs: Number(row.created_at_ms ?? 0),
        updatedAtMs: Number(row.updated_at_ms ?? 0),
      }));
    } catch (err) {
      this.logger?.warn?.(`${TAG} [profiles-pull] FAILED: ${errorMessage(err)}`);
      return [];
    }
  }

  async syncProfiles(records: ProfileSyncRecord[]): Promise<void> {
    if (this.degraded || records.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const record of records) {
        await this.syncProfile(client, record);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      this.logger?.warn?.(`${TAG} [profiles-sync] FAILED: ${errorMessage(err)}`);
    } finally {
      client.release();
    }
  }

  async deleteProfiles(recordIds: string[]): Promise<void> {
    if (this.degraded || recordIds.length === 0) return;
    try {
      await this.pool.query(`DELETE FROM ${this.table(POSTGRES_TABLES.profiles)} WHERE record_id = ANY($1::text[])`, [recordIds]);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [profiles-delete] FAILED: ${errorMessage(err)}`);
    }
  }

  async reindexAll(
    embedFn: (text: string) => Promise<Float32Array>,
    onProgress?: (done: number, total: number, layer: "L1" | "L0") => void,
  ): Promise<{ l1Count: number; l0Count: number }> {
    if (this.degraded || !this.vectorAvailable) return { l1Count: 0, l0Count: 0 };
    const l1Rows = await this.getAllL1Texts();
    let l1Done = 0;
    for (const row of l1Rows) {
      try {
        const embedding = await embedFn(row.content);
        const vec = this.prepareVector(embedding);
        if (vec) {
          await this.pool.query(`UPDATE ${this.table(POSTGRES_TABLES.l1)} SET embedding = $2::vector WHERE record_id = $1`, [row.record_id, vec]);
        }
      } catch (err) {
        this.logger?.warn?.(`${TAG} [reindex-L1] skip ${row.record_id}: ${errorMessage(err)}`);
      }
      l1Done++;
      onProgress?.(l1Done, l1Rows.length, "L1");
    }

    const l0Rows = await this.getAllL0Texts();
    let l0Done = 0;
    for (const row of l0Rows) {
      try {
        const embedding = await embedFn(row.message_text);
        const vec = this.prepareVector(embedding);
        if (vec) {
          await this.pool.query(`UPDATE ${this.table(POSTGRES_TABLES.l0)} SET embedding = $2::vector WHERE record_id = $1`, [row.record_id, vec]);
        }
      } catch (err) {
        this.logger?.warn?.(`${TAG} [reindex-L0] skip ${row.record_id}: ${errorMessage(err)}`);
      }
      l0Done++;
      onProgress?.(l0Done, l0Rows.length, "L0");
    }
    return { l1Count: l1Done, l0Count: l0Done };
  }

  isFtsAvailable(): boolean {
    return !this.degraded && this.ftsAvailable;
  }

  private async syncProfile(client: PoolClient, record: ProfileSyncRecord): Promise<void> {
    const current = await client.query<{ version: number; content_md5: string; created_at_ms: string }>(
      `SELECT version, content_md5, created_at_ms::bigint AS created_at_ms FROM ${this.table(POSTGRES_TABLES.profiles)} WHERE record_id = $1 FOR UPDATE`,
      [record.id],
    );
    const now = Date.now();
    if (current.rows.length === 0) {
      await client.query(
        `INSERT INTO ${this.table(POSTGRES_TABLES.profiles)}
         (record_id, type, filename, content, content_md5, agent_id, version, created_at_ms, updated_at_ms)
         VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8)`,
        [record.id, record.type, record.filename, record.content, record.contentMd5, record.agentId ?? "", record.createdAtMs || now, now],
      );
      return;
    }

    const row = current.rows[0];
    if (row.content_md5 === record.contentMd5) return;
    const currentVersion = Number(row.version ?? 0);
    if ((record.baselineVersion ?? 0) !== currentVersion) {
      this.logger?.warn?.(`${TAG} [profiles-sync] conflict for ${record.filename}: remote version ${currentVersion}, baseline ${record.baselineVersion ?? 0}`);
      return;
    }

    await client.query(
      `UPDATE ${this.table(POSTGRES_TABLES.profiles)}
       SET type=$2, filename=$3, content=$4, content_md5=$5, agent_id=$6,
           version=$7, updated_at_ms=$8
       WHERE record_id=$1`,
      [record.id, record.type, record.filename, record.content, record.contentMd5, record.agentId ?? "", currentVersion + 1, now],
    );
  }

  private async deleteExpired(table: string, column: string, cutoffIso: string, label: string): Promise<number> {
    if (this.degraded) return 0;
    try {
      const total = await this.countTable(table);
      if (total <= 0) return 0;
      const expired = await this.pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM ${this.table(table)} WHERE ${quoteIdent(column)} != '' AND ${quoteIdent(column)} < $1`,
        [cutoffIso],
      );
      const expiredCount = Number(expired.rows[0]?.cnt ?? 0);
      if (expiredCount <= 0) return 0;
      if (expiredCount / total > DELETE_RATIO_LIMIT) {
        this.logger?.warn?.(`${TAG} [${label}-delete-expired] blocked: would delete ${expiredCount}/${total}`);
        return 0;
      }
      const result = await this.pool.query(
        `DELETE FROM ${this.table(table)} WHERE ${quoteIdent(column)} != '' AND ${quoteIdent(column)} < $1`,
        [cutoffIso],
      );
      return result.rowCount ?? expiredCount;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [${label}-delete-expired] FAILED: ${errorMessage(err)}`);
      return 0;
    }
  }

  private async countTable(table: string): Promise<number> {
    if (this.degraded) return 0;
    try {
      const rows = await this.pool.query<{ cnt: string }>(`SELECT COUNT(*) AS cnt FROM ${this.table(table)}`);
      return Number(rows.rows[0]?.cnt ?? 0);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [count:${table}] FAILED: ${errorMessage(err)}`);
      return 0;
    }
  }

  private prepareVector(embedding?: Float32Array): string | null {
    if (!embedding || embedding.length === 0 || embedding.every((v) => v === 0)) return null;
    if (this.dimensions <= 0 || embedding.length !== this.dimensions) {
      this.logger?.warn?.(`${TAG} embedding dimension mismatch: got=${embedding.length}, expected=${this.dimensions}`);
      return null;
    }
    return vectorToSql(embedding);
  }

  private isValidQueryVector(embedding: Float32Array): boolean {
    return this.dimensions > 0 && embedding.length === this.dimensions && !embedding.every((v) => v === 0);
  }

  private table(name: string): string {
    return qualifiedName(this.config.schema, name);
  }

  private l1Columns(): string {
    return `record_id, content, type, priority, scene_name, session_key, session_id,
      timestamp_str, timestamp_start, timestamp_end, created_time, updated_time,
      metadata_json::text AS metadata_json`;
  }

  private l1SearchColumns(prefix = ""): string {
    const p = prefix ? `${prefix}.` : "";
    return `${p}record_id, ${p}content, ${p}type, ${p}priority, ${p}scene_name,
      ${p}timestamp_str, ${p}timestamp_start, ${p}timestamp_end, ${p}session_key, ${p}session_id,
      ${p}metadata_json::text AS metadata_json`;
  }

  private safeConnectionLabel(): string {
    return `${this.config.host}:${this.config.port}/${this.config.database}`;
  }
}

function vectorToSql(embedding: Float32Array): string {
  return `[${Array.from(embedding, (value) => Number.isFinite(value) ? String(value) : "0").join(",")}]`;
}

function normalizeBm25Query(ftsQuery: string): string {
  const tokens = ftsQuery
    .match(/[\p{L}\p{N}_-]+/gu)
    ?.filter((token) => !/^(OR|AND|NOT)$/i.test(token)) ?? [];
  return [...new Set(tokens)].join(" ");
}

function bm25RankToScore(rank: number): number {
  if (!Number.isFinite(rank)) return 1 / 1000;
  if (rank < 0) {
    const relevance = -rank;
    return relevance / (1 + relevance);
  }
  return 1 / (1 + rank);
}

function normalizeL1Score<T extends L1SearchResult>(row: T): T {
  return { ...row, score: Number(row.score ?? 0) };
}

function normalizeL0Row<T extends L0QueryRow>(row: T): T {
  return { ...row, timestamp: Number(row.timestamp ?? 0) };
}

function normalizeL0SearchRow<T extends L0SearchResult | L0FtsResult>(row: T): T {
  return { ...row, score: Number(row.score ?? 0), timestamp: Number(row.timestamp ?? 0) };
}

function rrfMergeL1(fts: L1FtsResult[], vec: L1SearchResult[]): L1SearchResult[] {
  const map = new Map<string, { item: L1SearchResult; score: number }>();
  for (const list of [fts, vec]) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank] as L1SearchResult;
      const score = 1 / (60 + rank + 1);
      const existing = map.get(item.record_id);
      if (existing) existing.score += score;
      else map.set(item.record_id, { item, score });
    }
  }
  return [...map.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ item, score }) => ({ ...item, score }));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

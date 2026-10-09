import type { Pool, PoolClient } from "pg";
import type { EmbeddingProviderInfo } from "./embedding.js";
import type { StoreLogger } from "./types.js";

const TAG = "[memory-tdai][postgres-schema]";

export interface PostgresSchemaOptions {
  schema: string;
  dimensions: number;
  textConfig: string;
  vectorIndex: "none" | "hnsw" | "ivfflat" | "diskann";
  useVectorScale: boolean;
  logger?: StoreLogger;
}

export interface PostgresSchemaInitResult {
  vectorAvailable: boolean;
  ftsAvailable: boolean;
  needsReindex: boolean;
  reason?: string;
}

interface EmbeddingMeta {
  provider: string;
  model: string;
  dimensions: number;
}

export const POSTGRES_TABLES = {
  embeddingMeta: "embedding_meta",
  l1: "l1_records",
  l0: "l0_conversations",
  profiles: "profiles",
} as const;

export function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function qualifiedName(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

export function postgresIndexName(schema: string, name: string): string {
  return `${schema}_${name}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 60);
}

export async function initPostgresSchema(
  pool: Pool,
  options: PostgresSchemaOptions,
  providerInfo?: EmbeddingProviderInfo,
): Promise<PostgresSchemaInitResult> {
  const result = await initWithRetry(pool, options, providerInfo, 0);
  return result;
}

/**
 * Retry wrapper for schema init.
 *
 * PostgreSQL 18 changed CREATE … IF NOT EXISTS semantics under concurrency:
 * two sessions racing to create the same object may see
 * "duplicate key value violates unique constraint pg_type_typname_nsp_index"
 * instead of silently skipping. We retry once after a short delay; the winner
 * already created everything, so the second attempt will be a no-op.
 */
async function initWithRetry(
  pool: Pool,
  options: PostgresSchemaOptions,
  providerInfo: EmbeddingProviderInfo | undefined,
  attempt: number,
): Promise<PostgresSchemaInitResult> {
  const client = await pool.connect();
  try {
    return await initWithClient(client, options, providerInfo);
  } catch (err) {
    client.release();
    const message = errorMessage(err);
    const isConcurrencyConflict =
      message.includes("pg_type_typname_nsp_index") ||
      message.includes("pg_class_relname_nsp_index") ||
      message.includes("pg_namespace_nspname_index");
    if (isConcurrencyConflict && attempt < 3) {
      options.logger?.warn?.(
        `${TAG} schema init conflict (attempt ${attempt + 1}), retrying after winner commits: ${message}`,
      );
      // Wait a beat for the winning session to commit its tables.
      await new Promise((r) => setTimeout(r, 500 + attempt * 500));
      return initWithRetry(pool, options, providerInfo, attempt + 1);
    }
    throw err;
  }
}

async function initWithClient(
  client: PoolClient,
  options: PostgresSchemaOptions,
  providerInfo?: EmbeddingProviderInfo,
): Promise<PostgresSchemaInitResult> {
  const schema = options.schema;
  let vectorAvailable = false;
  let ftsAvailable = false;

  await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
  await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);
  vectorAvailable = true;

  if (options.useVectorScale || options.vectorIndex === "diskann") {
    try {
      await client.query(`CREATE EXTENSION IF NOT EXISTS vectorscale CASCADE`);
    } catch (err) {
      options.logger?.warn?.(`${TAG} vectorscale unavailable, falling back to pgvector indexes: ${errorMessage(err)}`);
    }
  }

  try {
    await client.query(`CREATE EXTENSION IF NOT EXISTS pg_textsearch`);
    ftsAvailable = true;
  } catch (err) {
    options.logger?.warn?.(`${TAG} pg_textsearch unavailable; FTS search disabled: ${errorMessage(err)}`);
  }

  await createTables(client, options);
  const reindex = await updateEmbeddingMeta(client, options, providerInfo);
  await createIndexes(client, options, ftsAvailable);

  return {
    vectorAvailable: vectorAvailable && options.dimensions > 0,
    ftsAvailable,
    needsReindex: reindex.needsReindex,
    reason: reindex.reason,
  };
}

async function createTables(client: PoolClient, options: PostgresSchemaOptions): Promise<void> {
  const s = options.schema;
  await tryDdl(client, options, POSTGRES_TABLES.embeddingMeta, `
    CREATE TABLE IF NOT EXISTS ${qualifiedName(s, POSTGRES_TABLES.embeddingMeta)} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  await tryDdl(client, options, POSTGRES_TABLES.l1, `
    CREATE TABLE IF NOT EXISTS ${qualifiedName(s, POSTGRES_TABLES.l1)} (
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
      metadata_json JSONB DEFAULT '{}'::jsonb,
      embedding vector
    )
  `);

  await tryDdl(client, options, POSTGRES_TABLES.l0, `
    CREATE TABLE IF NOT EXISTS ${qualifiedName(s, POSTGRES_TABLES.l0)} (
      record_id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      session_id TEXT DEFAULT '',
      role TEXT NOT NULL DEFAULT '',
      message_text TEXT NOT NULL,
      recorded_at TEXT DEFAULT '',
      timestamp BIGINT DEFAULT 0,
      embedding vector
    )
  `);

  await tryDdl(client, options, POSTGRES_TABLES.profiles, `
    CREATE TABLE IF NOT EXISTS ${qualifiedName(s, POSTGRES_TABLES.profiles)} (
      record_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      filename TEXT NOT NULL,
      content TEXT NOT NULL,
      content_md5 TEXT NOT NULL,
      agent_id TEXT DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1,
      created_at_ms BIGINT NOT NULL DEFAULT 0,
      updated_at_ms BIGINT NOT NULL DEFAULT 0
    )
  `);
}

async function createIndexes(client: PoolClient, options: PostgresSchemaOptions, ftsAvailable: boolean): Promise<void> {
  const s = options.schema;
  const idx = (suffix: string) => quoteIdent(postgresIndexName(s, suffix));
  const tbl = (table: string) => qualifiedName(s, table);

  const indexes: Array<{ label: string; sql: string }> = [
    { label: "l1_type", sql: `CREATE INDEX IF NOT EXISTS ${idx("l1_type_idx")} ON ${tbl(POSTGRES_TABLES.l1)} (type)` },
    { label: "l1_session_key", sql: `CREATE INDEX IF NOT EXISTS ${idx("l1_session_key_idx")} ON ${tbl(POSTGRES_TABLES.l1)} (session_key)` },
    { label: "l1_session_id", sql: `CREATE INDEX IF NOT EXISTS ${idx("l1_session_id_idx")} ON ${tbl(POSTGRES_TABLES.l1)} (session_id)` },
    { label: "l1_scene", sql: `CREATE INDEX IF NOT EXISTS ${idx("l1_scene_idx")} ON ${tbl(POSTGRES_TABLES.l1)} (scene_name)` },
    { label: "l1_session_updated", sql: `CREATE INDEX IF NOT EXISTS ${idx("l1_session_updated_idx")} ON ${tbl(POSTGRES_TABLES.l1)} (session_id, updated_time)` },
    { label: "l1_sessionkey_updated", sql: `CREATE INDEX IF NOT EXISTS ${idx("l1_sessionkey_updated_idx")} ON ${tbl(POSTGRES_TABLES.l1)} (session_key, updated_time)` },

    { label: "l0_session", sql: `CREATE INDEX IF NOT EXISTS ${idx("l0_session_idx")} ON ${tbl(POSTGRES_TABLES.l0)} (session_key)` },
    { label: "l0_session_id", sql: `CREATE INDEX IF NOT EXISTS ${idx("l0_session_id_idx")} ON ${tbl(POSTGRES_TABLES.l0)} (session_id)` },
    { label: "l0_recorded", sql: `CREATE INDEX IF NOT EXISTS ${idx("l0_recorded_idx")} ON ${tbl(POSTGRES_TABLES.l0)} (recorded_at)` },
    { label: "l0_timestamp", sql: `CREATE INDEX IF NOT EXISTS ${idx("l0_timestamp_idx")} ON ${tbl(POSTGRES_TABLES.l0)} (timestamp)` },

    { label: "profiles_type", sql: `CREATE INDEX IF NOT EXISTS ${idx("profiles_type_idx")} ON ${tbl(POSTGRES_TABLES.profiles)} (type)` },
    { label: "profiles_filename", sql: `CREATE INDEX IF NOT EXISTS ${idx("profiles_filename_idx")} ON ${tbl(POSTGRES_TABLES.profiles)} (filename)` },
  ];

  for (const { label, sql } of indexes) {
    await tryDdl(client, options, label, sql);
  }

  if (options.dimensions > 0 && options.vectorIndex !== "none") {
    await createVectorIndex(client, options, POSTGRES_TABLES.l1, "l1_embedding_idx");
    await createVectorIndex(client, options, POSTGRES_TABLES.l0, "l0_embedding_idx");
  }

  if (ftsAvailable) {
    await createBm25Index(client, options, POSTGRES_TABLES.l1, "content", "l1_content_bm25_idx");
    await createBm25Index(client, options, POSTGRES_TABLES.l0, "message_text", "l0_message_bm25_idx");
  }
}

async function createVectorIndex(
  client: PoolClient,
  options: PostgresSchemaOptions,
  table: string,
  indexSuffix: string,
): Promise<void> {
  const method = options.vectorIndex === "diskann" ? "diskann" : options.vectorIndex;
  const indexName = quoteIdent(postgresIndexName(options.schema, indexSuffix));
  const tableName = qualifiedName(options.schema, table);
  const dims = options.dimensions;
  const expression = `((embedding::vector(${dims}))) vector_cosine_ops`;
  const where = `embedding IS NOT NULL AND vector_dims(embedding) = ${dims}`;
  const sql = `CREATE INDEX IF NOT EXISTS ${indexName} ON ${tableName} USING ${method} (${expression}) WHERE ${where}`;

  await tryDdl(client, options, indexSuffix, sql);
}

async function createBm25Index(
  client: PoolClient,
  options: PostgresSchemaOptions,
  table: string,
  column: string,
  indexSuffix: string,
): Promise<void> {
  const indexName = quoteIdent(postgresIndexName(options.schema, indexSuffix));
  const tableName = qualifiedName(options.schema, table);
  const textConfig = options.textConfig.replaceAll("'", "''");
  const sql = `CREATE INDEX IF NOT EXISTS ${indexName} ON ${tableName} USING bm25 (${quoteIdent(column)}) WITH (text_config='${textConfig}')`;

  await tryDdl(client, options, indexSuffix, sql);
}

async function updateEmbeddingMeta(
  client: PoolClient,
  options: PostgresSchemaOptions,
  providerInfo?: EmbeddingProviderInfo,
): Promise<{ needsReindex: boolean; reason?: string }> {
  if (!providerInfo) return { needsReindex: false };

  const table = qualifiedName(options.schema, POSTGRES_TABLES.embeddingMeta);
  const row = await client.query<{ value: string }>(`SELECT value FROM ${table} WHERE key = $1`, ["embedding_provider_info"]);
  const saved = parseEmbeddingMeta(row.rows[0]?.value);
  const next: EmbeddingMeta = {
    provider: providerInfo.provider,
    model: providerInfo.model,
    dimensions: options.dimensions,
  };

  let needsReindex = false;
  let reason: string | undefined;
  if (saved) {
    const changes: string[] = [];
    if (saved.provider !== next.provider) changes.push(`provider: ${saved.provider} → ${next.provider}`);
    if (saved.model !== next.model) changes.push(`model: ${saved.model} → ${next.model}`);
    if (saved.dimensions !== next.dimensions) changes.push(`dimensions: ${saved.dimensions} → ${next.dimensions}`);
    if (changes.length > 0) {
      needsReindex = true;
      reason = changes.join(", ");
      await client.query(`UPDATE ${qualifiedName(options.schema, POSTGRES_TABLES.l1)} SET embedding = NULL`);
      await client.query(`UPDATE ${qualifiedName(options.schema, POSTGRES_TABLES.l0)} SET embedding = NULL`);
    }
  } else {
    const counts = await client.query<{ cnt: string }>(`
      SELECT
        (SELECT COUNT(*) FROM ${qualifiedName(options.schema, POSTGRES_TABLES.l1)}) +
        (SELECT COUNT(*) FROM ${qualifiedName(options.schema, POSTGRES_TABLES.l0)}) AS cnt
    `);
    if (Number(counts.rows[0]?.cnt ?? 0) > 0) {
      needsReindex = true;
      reason = "legacy PostgreSQL store without embedding_meta — cannot verify vector compatibility";
    }
  }

  await client.query(
    `INSERT INTO ${table} (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    ["embedding_provider_info", JSON.stringify(next)],
  );

  return { needsReindex, reason };
}

function parseEmbeddingMeta(value: string | undefined): EmbeddingMeta | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<EmbeddingMeta>;
    if (!parsed.provider || !parsed.model || typeof parsed.dimensions !== "number") return null;
    return parsed as EmbeddingMeta;
  } catch {
    return null;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Execute a DDL statement safely under concurrent init.
 *
 * PostgreSQL 18 may throw pg_type_typname_nsp_index / pg_class_relname_nsp_index
 * when two sessions race on CREATE … IF NOT EXISTS for the same object.
 * The winner created the object; we just skip past this DDL.
 */
async function tryDdl(
  client: PoolClient,
  options: PostgresSchemaOptions,
  label: string,
  sql: string,
): Promise<void> {
  try {
    await client.query(sql);
  } catch (err) {
    const message = errorMessage(err);
    if (
      message.includes("pg_type_typname_nsp_index") ||
      message.includes("pg_class_relname_nsp_index") ||
      message.includes("pg_namespace_nspname_index")
    ) {
      // Object already exists — concurrent session won the race.
      options.logger?.debug?.(
        `${TAG} concurrent DDL skipped (${label}): ${message}`,
      );
      return;
    }
    throw err;
  }
}

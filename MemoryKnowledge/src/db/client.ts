/**
 * Drizzle client initialization — creates better-sqlite3 Database + drizzle wrapper.
 *
 * Synchronous driver, matches existing store call patterns.
 */

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export interface CreateDbOptions {
  /** Path to SQLite file. Use ":memory:" for in-memory DB. */
  path: string;
  /** Whether to run migrations (CREATE TABLE IF NOT EXISTS) on init. Default true. */
  autoMigrate?: boolean;
}

/**
 * Create a Drizzle-wrapped better-sqlite3 database.
 * Sets WAL mode + busy_timeout for production safety.
 */
export function createDb(opts: CreateDbOptions): { db: Db; raw: Database.Database } {
  if (opts.path !== ":memory:") {
    mkdirSync(dirname(opts.path), { recursive: true });
  }

  const raw = new Database(opts.path);
  raw.pragma("journal_mode = WAL");
  raw.pragma("busy_timeout = 5000");

  const db = drizzle(raw, { schema });

  if (opts.autoMigrate !== false) {
    migrate(db, raw);
  }

  return { db, raw };
}

/**
 * Run idempotent CREATE TABLE IF NOT EXISTS for all 4 tables + indexes.
 * Uses raw SQL for partial unique indexes (Drizzle schema definition generates them
 * via drizzle-kit, but for runtime we ensure tables exist).
 */
export function migrate(_db: Db, raw: Database.Database): void {
  raw.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_code_graph (
      code_graph_id   TEXT PRIMARY KEY,
      service_id      TEXT NOT NULL,
      team_id         TEXT NOT NULL,
      repo_name       TEXT NOT NULL DEFAULT '',
      repo_url        TEXT NOT NULL,
      branch          TEXT NOT NULL,
      commit_hash     TEXT,
      owner_user_id   TEXT,
      user_id         TEXT,
      agent_id        TEXT,
      task_id         TEXT,
      visibility      TEXT NOT NULL DEFAULT 'team',
      status          TEXT NOT NULL DEFAULT 'pending',
      internal_status TEXT,
      sync_error      TEXT,
      stats_json      TEXT,
      version         INTEGER NOT NULL DEFAULT 0,
      last_sync_at    TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      deleted_at      TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_kcg_team_repo_branch
      ON knowledge_code_graph(service_id, team_id, repo_url, branch)
      WHERE deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_kcg_team_status
      ON knowledge_code_graph(service_id, team_id, status);

    CREATE TABLE IF NOT EXISTS knowledge_wiki (
      wiki_id         TEXT PRIMARY KEY,
      service_id      TEXT NOT NULL,
      team_id         TEXT NOT NULL,
      name            TEXT NOT NULL,
      source_type     TEXT,
      source_url      TEXT,
      owner_user_id   TEXT,
      user_id         TEXT,
      agent_id        TEXT,
      task_id         TEXT,
      visibility      TEXT NOT NULL DEFAULT 'team',
      status          TEXT NOT NULL DEFAULT 'draft',
      internal_status TEXT,
      sync_error      TEXT,
      page_count      INTEGER,
      version         INTEGER NOT NULL DEFAULT 0,
      last_sync_at    TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      deleted_at      TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_kwiki_team_name
      ON knowledge_wiki(service_id, team_id, name)
      WHERE deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_kwiki_team_status
      ON knowledge_wiki(service_id, team_id, status);

    CREATE TABLE IF NOT EXISTS knowledge_wiki_audit (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      wiki_id    TEXT NOT NULL,
      service_id TEXT,
      version    INTEGER NOT NULL DEFAULT 0,
      action     TEXT NOT NULL,
      user_id    TEXT,
      agent_id   TEXT,
      detail     TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_kwa_wiki_version
      ON knowledge_wiki_audit(wiki_id, version DESC);

    CREATE TABLE IF NOT EXISTS knowledge_code_graph_audit (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      code_graph_id TEXT NOT NULL,
      service_id    TEXT,
      version       INTEGER NOT NULL DEFAULT 0,
      action        TEXT NOT NULL,
      user_id       TEXT,
      agent_id      TEXT,
      detail        TEXT,
      created_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_kcga_cg_version
      ON knowledge_code_graph_audit(code_graph_id, version DESC);

    CREATE TABLE IF NOT EXISTS llm_binding (
      service_id     TEXT PRIMARY KEY,
      mode           TEXT NOT NULL DEFAULT 'proxy',
      proxy_base_url TEXT,
      api_key        TEXT,
      model          TEXT,
      base_url       TEXT,
      enabled        INTEGER NOT NULL DEFAULT 1,
      updated_at     TEXT NOT NULL
    );

    -- 凭据密文表（949spec §5.1/§6）：CodeGraph 元数据表不含任何明文凭据；
    -- 此处仅存 AES-256-GCM 密文 + 元数据，master key 在环境变量 KNOWLEDGE_SECRET_MASTER_KEY。
    -- 复合主键 (credential_ref, version)：rotate 产生新版本行，历史版本保留可追溯。
    CREATE TABLE IF NOT EXISTS knowledge_credential (
      credential_ref       TEXT NOT NULL,
      version              INTEGER NOT NULL,
      service_id           TEXT NOT NULL,
      team_id              TEXT NOT NULL,
      code_graph_id        TEXT NOT NULL,
      auth_method          TEXT NOT NULL,
      username             TEXT,
      provider             TEXT,
      ciphertext           TEXT NOT NULL,
      kek_version          INTEGER NOT NULL DEFAULT 1,
      fingerprint          TEXT,
      status               TEXT NOT NULL DEFAULT 'active',
      last_validated_at    TEXT,
      last_auth_failure_at TEXT,
      created_at           TEXT NOT NULL,
      updated_at           TEXT NOT NULL,
      PRIMARY KEY (credential_ref, version)
    );

    CREATE INDEX IF NOT EXISTS idx_kcred_cg
      ON knowledge_credential(code_graph_id, version);
  `);

  // Column migrations — SQLite ALTER TABLE ADD COLUMN is not idempotent,
  // so we check PRAGMA table_info first.
  addColumnIfMissing(raw, "knowledge_code_graph", "service_url", "TEXT");
  addColumnIfMissing(raw, "knowledge_code_graph", "summary", "TEXT");
  // 私有仓库认证列（token/ssh 凭据）
  addColumnIfMissing(raw, "knowledge_code_graph", "auth_method", "TEXT NOT NULL DEFAULT 'none'");
  addColumnIfMissing(raw, "knowledge_code_graph", "access_token", "TEXT");
  addColumnIfMissing(raw, "knowledge_code_graph", "token_username", "TEXT");
  addColumnIfMissing(raw, "knowledge_code_graph", "ssh_private_key", "TEXT");
  // 凭据引用列（949spec §5.2 / §29 Phase 1）：新写入只落引用，明文列仅迁移期保留。
  addColumnIfMissing(raw, "knowledge_code_graph", "credential_ref", "TEXT");
  addColumnIfMissing(raw, "knowledge_code_graph", "credential_version", "INTEGER");
  addColumnIfMissing(raw, "knowledge_code_graph", "credential_status", "TEXT");
  addColumnIfMissing(raw, "knowledge_code_graph", "credential_fingerprint", "TEXT");
  addColumnIfMissing(raw, "knowledge_code_graph", "credential_provider", "TEXT");
  addColumnIfMissing(raw, "knowledge_code_graph", "credential_last_validated_at", "TEXT");
  addColumnIfMissing(raw, "knowledge_code_graph", "credential_last_auth_failure_at", "TEXT");
  addColumnIfMissing(raw, "knowledge_wiki", "service_url", "TEXT");
  addColumnIfMissing(raw, "knowledge_wiki", "summary", "TEXT");
  // service_id on audit tables is nullable → safe to add to existing dev DBs.
  addColumnIfMissing(raw, "knowledge_wiki_audit", "service_id", "TEXT");
  addColumnIfMissing(raw, "knowledge_code_graph_audit", "service_id", "TEXT");
}

/** Add a column to a table if it doesn't already exist. SQLite-safe. */
function addColumnIfMissing(
  raw: Database.Database,
  table: string,
  column: string,
  type: string,
): void {
  const cols = raw.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type};`);
  }
}

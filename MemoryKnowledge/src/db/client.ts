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

export type Db = BetterSQLite3Database<typeof schema>;

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
  // 前置：把老 user-scoped 凭据表清掉（新结构无法 IF NOT EXISTS 上位）。
  // 判据：resource_id 列缺失 = 老结构，DROP 后由下方 CREATE 重建。
  // 该能力尚未发布，无真实存量凭据。
  if (
    tableExists(raw, "knowledge_source_credential") &&
    !hasColumn(raw, "knowledge_source_credential", "resource_id")
  ) {
    raw.exec("DROP TABLE knowledge_source_credential");
  }

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

    CREATE TABLE IF NOT EXISTS knowledge_source_credential (
      service_id       TEXT NOT NULL,
      resource_type    TEXT NOT NULL,        -- 'code-graph' | 'wiki'
      resource_id      TEXT NOT NULL,        -- = code_graph_id 或 wiki_id
      provider_id      TEXT NOT NULL,        -- 'gongfeng' / 'iwiki' / ...（非键）
      cred_kind        TEXT NOT NULL,        -- 'bearer' | 'basic'
      cred_secret      TEXT NOT NULL,        -- base64(UTF-8 令牌)
      cred_username    TEXT,                 -- 仅 basic
      cred_extra_json  TEXT,
      last_verified_at TEXT,
      created_by       TEXT,
      updated_by       TEXT,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_ksc_pk
      ON knowledge_source_credential(service_id, resource_type, resource_id);

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
  `);

  // Column migrations — SQLite ALTER TABLE ADD COLUMN is not idempotent,
  // so we check PRAGMA table_info first.
  addColumnIfMissing(raw, "knowledge_code_graph", "service_url", "TEXT");
  addColumnIfMissing(raw, "knowledge_code_graph", "summary", "TEXT");
  addColumnIfMissing(raw, "knowledge_wiki", "service_url", "TEXT");
  addColumnIfMissing(raw, "knowledge_wiki", "summary", "TEXT");
  // service_id on audit tables is nullable → safe to add to existing dev DBs.
  addColumnIfMissing(raw, "knowledge_wiki_audit", "service_id", "TEXT");
  addColumnIfMissing(raw, "knowledge_code_graph_audit", "service_id", "TEXT");
}

/** True iff the given table exists in the DB. */
function tableExists(raw: Database.Database, table: string): boolean {
  const row = raw
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(table);
  return !!row;
}

/** Add a column to a table if it doesn't already exist. SQLite-safe. */
function addColumnIfMissing(
  raw: Database.Database,
  table: string,
  column: string,
  type: string,
): void {
  if (hasColumn(raw, table, column)) return;
  raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type};`);
}

/** True iff the given column exists on the table (SQLite PRAGMA-based). */
function hasColumn(raw: Database.Database, table: string, column: string): boolean {
  const cols = raw.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

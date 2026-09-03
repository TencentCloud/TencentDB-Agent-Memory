/**
 * Drizzle ORM schema — 4 SQLite tables for knowledge metadata.
 *
 * Tables:
 *   knowledge_code_graph       — code repo index metadata + status
 *   knowledge_wiki             — wiki knowledge base metadata + status
 *   knowledge_wiki_audit       — wiki state-change audit log (append-only)
 *   knowledge_code_graph_audit — code-graph state-change audit log
 *
 * Soft-delete via `deleted_at` + partial unique index (WHERE deleted_at IS NULL).
 */

import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ───────────────────────── knowledge_code_graph ─────────────────────────

export const knowledgeCodeGraph = sqliteTable(
  "knowledge_code_graph",
  {
    codeGraphId: text("code_graph_id").primaryKey(),
    serviceId: text("service_id").notNull(),
    teamId: text("team_id").notNull(),
    repoName: text("repo_name").notNull().default(""),
    repoUrl: text("repo_url").notNull(),
    branch: text("branch").notNull(),
    sparsePaths: text("sparse_paths"),
    commitHash: text("commit_hash"),
    ownerUserId: text("owner_user_id"),
    userId: text("user_id"),
    agentId: text("agent_id"),
    taskId: text("task_id"),
    visibility: text("visibility").notNull().default("team"),
    status: text("status").notNull().default("pending"),
    internalStatus: text("internal_status"),
    syncError: text("sync_error"),
    statsJson: text("stats_json"),
    serviceUrl: text("service_url"),
    summary: text("summary"),
    version: integer("version").notNull().default(0),
    lastSyncAt: text("last_sync_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    uniqueIndex("idx_kcg_team_repo_branch")
      .on(table.serviceId, table.teamId, table.repoUrl, table.branch)
      .where(sql`deleted_at IS NULL`),
    index("idx_kcg_team_status").on(table.serviceId, table.teamId, table.status),
  ],
);

// ───────────────────────── knowledge_wiki ─────────────────────────

export const knowledgeWiki = sqliteTable(
  "knowledge_wiki",
  {
    wikiId: text("wiki_id").primaryKey(),
    serviceId: text("service_id").notNull(),
    teamId: text("team_id").notNull(),
    name: text("name").notNull(),
    sourceType: text("source_type"),
    sourceUrl: text("source_url"),
    ownerUserId: text("owner_user_id"),
    userId: text("user_id"),
    agentId: text("agent_id"),
    taskId: text("task_id"),
    visibility: text("visibility").notNull().default("team"),
    // draft = 建壳未加工（仅 create 一次性出现）；code-graph 仍用 pending（create 即建图）。
    status: text("status").notNull().default("draft"),
    internalStatus: text("internal_status"),
    syncError: text("sync_error"),
    pageCount: integer("page_count"),
    serviceUrl: text("service_url"),
    summary: text("summary"),
    version: integer("version").notNull().default(0),
    lastSyncAt: text("last_sync_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    uniqueIndex("idx_kwiki_team_name")
      .on(table.serviceId, table.teamId, table.name)
      .where(sql`deleted_at IS NULL`),
    index("idx_kwiki_team_status").on(table.serviceId, table.teamId, table.status),
  ],
);

// ───────────────────────── knowledge_wiki_audit ─────────────────────────

export const knowledgeWikiAudit = sqliteTable(
  "knowledge_wiki_audit",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    wikiId: text("wiki_id").notNull(),
    serviceId: text("service_id"),
    version: integer("version").notNull().default(0),
    action: text("action").notNull(),
    userId: text("user_id"),
    agentId: text("agent_id"),
    detail: text("detail"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("idx_kwa_wiki_version").on(table.wikiId, table.version)],
);

// ───────────────────────── knowledge_code_graph_audit ─────────────────────────

export const knowledgeCodeGraphAudit = sqliteTable(
  "knowledge_code_graph_audit",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    codeGraphId: text("code_graph_id").notNull(),
    serviceId: text("service_id"),
    version: integer("version").notNull().default(0),
    action: text("action").notNull(),
    userId: text("user_id"),
    agentId: text("agent_id"),
    detail: text("detail"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("idx_kcga_cg_version").on(table.codeGraphId, table.version)],
);

// ───────────────────────── llm_binding ─────────────────────────
// Per-instance (service_id) LLM routing for wiki ingest/summary.
// mode='proxy' → call context_proxy with a dedicated knowledge-service user_key;
// mode='byo'   → call a user-supplied OpenAI-compatible endpoint.

export const llmBinding = sqliteTable("llm_binding", {
  serviceId: text("service_id").primaryKey(),
  mode: text("mode").notNull().default("proxy"),
  proxyBaseUrl: text("proxy_base_url"),
  apiKey: text("api_key"),
  baseUrl: text("base_url"),
  enabled: integer("enabled").notNull().default(1),
  updatedAt: text("updated_at").notNull(),
});

// ───────────────────────── Type exports ─────────────────────────

export type KnowledgeCodeGraph = typeof knowledgeCodeGraph.$inferSelect;
export type KnowledgeWiki = typeof knowledgeWiki.$inferSelect;
export type KnowledgeWikiAudit = typeof knowledgeWikiAudit.$inferSelect;
export type KnowledgeCodeGraphAudit = typeof knowledgeCodeGraphAudit.$inferSelect;
export type LlmBinding = typeof llmBinding.$inferSelect;

/** Data format version constants (reserved field). */
export const CODE_DATA_VERSION = 0;
export const WIKI_DATA_VERSION = 0;

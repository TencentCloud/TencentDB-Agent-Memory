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

import { sqliteTable, text, integer, uniqueIndex, index, primaryKey } from "drizzle-orm/sqlite-core";
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
    // 私有仓库认证（token/ssh 凭据独立列存储，repo_url 恒为干净 URL）
    authMethod: text("auth_method").notNull().default("none"),
    accessToken: text("access_token"),
    tokenUsername: text("token_username"),
    sshPrivateKey: text("ssh_private_key"),
    // 凭据引用（949spec §5.2）：新写入只落引用，明文列仅迁移期保留。
    credentialRef: text("credential_ref"),
    credentialVersion: integer("credential_version"),
    credentialStatus: text("credential_status"),
    credentialFingerprint: text("credential_fingerprint"),
    credentialProvider: text("credential_provider"),
    credentialLastValidatedAt: text("credential_last_validated_at"),
    credentialLastAuthFailureAt: text("credential_last_auth_failure_at"),
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

// ───────────────────────── knowledge_credential ─────────────────────────
// 凭据密文表（949spec §5.1/§6）：独立于 CodeGraph 元数据表，仅存密文 + 元数据。
// master key（KEK）在环境变量 KNOWLEDGE_SECRET_MASTER_KEY，绝不同库同盘。

export const knowledgeCredential = sqliteTable(
  "knowledge_credential",
  {
    credentialRef: text("credential_ref").notNull(),
    version: integer("version").notNull(),
    serviceId: text("service_id").notNull(),
    teamId: text("team_id").notNull(),
    codeGraphId: text("code_graph_id").notNull(),
    authMethod: text("auth_method").notNull(),
    username: text("username"),
    provider: text("provider"),
    ciphertext: text("ciphertext").notNull(),
    kekVersion: integer("kek_version").notNull().default(1),
    fingerprint: text("fingerprint"),
    status: text("status").notNull().default("active"),
    lastValidatedAt: text("last_validated_at"),
    lastAuthFailureAt: text("last_auth_failure_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    // 复合主键 (credential_ref, version)：rotate 产生新版本行，历史版本保留。
    primaryKey({ columns: [table.credentialRef, table.version] }),
    index("idx_kcred_cg").on(table.codeGraphId, table.version),
  ],
);

// ───────────────────────── Type exports ─────────────────────────

export type KnowledgeCodeGraph = typeof knowledgeCodeGraph.$inferSelect;
export type KnowledgeWiki = typeof knowledgeWiki.$inferSelect;
export type KnowledgeWikiAudit = typeof knowledgeWikiAudit.$inferSelect;
export type KnowledgeCodeGraphAudit = typeof knowledgeCodeGraphAudit.$inferSelect;
export type LlmBinding = typeof llmBinding.$inferSelect;

/** Data format version constants (reserved field). */
export const CODE_DATA_VERSION = 0;
export const WIKI_DATA_VERSION = 0;

/**
 * Knowledge store contract — storage-agnostic interface + row/input/aux types.
 *
 * ZERO third-party dependencies (no drizzle, no better-sqlite3). This is the
 * abstraction seam (001 Q6): `IKnowledgeStore` lets us swap the SQLite backend
 * for e.g. a MySQL implementation without touching service/route code.
 *
 * Multi-tenancy (001, phase 5): every resource is scoped by `service_id`.
 *   - Main tables (code_graph / wiki) carry `service_id` NOT NULL.
 *   - Read/write methods take `serviceId` as their FIRST parameter (compile-time
 *     guard against forgetting the tenant filter), INCLUDING id-only lookups
 *     (getCodeGraphById / getWikiById / update*Status / update*Meta). A resource
 *     whose service_id does not match returns null/false → 404 at the route layer.
 *     This closes the cross-Memory leak risk (001 §2.4 / R1).
 *   - Create/audit inputs carry `service_id` on the input object itself.
 */

export type SyncStatus = "pending" | "processing" | "ready" | "failed";

/**
 * Wiki 专属状态：在 SyncStatus 基础上多一个 `draft`——create 建壳时的初始态，
 * 表示"从未加工过、无内容、可被 ingest"。一旦 ingest 成功变 ready、失败变 failed，
 * 之后重跑 ingest 只会进 pending/processing，永远不再回 draft。
 * code-graph 不使用 draft（其 create 即入队建图，初始 pending 是真 in-flight）。
 */
export type WikiStatus = SyncStatus | "draft";

// ───────────────────────── Code-Graph ─────────────────────────

export interface CodeGraphRow {
  code_graph_id: string;
  service_id: string;
  team_id: string;
  repo_name: string;
  repo_url: string;
  branch: string;
  /** 私有仓库认证方式：none=公开仓库；token=access_token URL 注入；ssh=私钥注入。 */
  auth_method: string;
  /** access_token（auth_method=token 时使用，Gitee 另需 token_username）。 */
  access_token: string | null;
  token_username: string | null;
  /** SSH 私钥原文（auth_method=ssh 时使用）。 */
  ssh_private_key: string | null;
  // ── 凭据引用（949spec §5.2；新写入只落引用，明文列仅迁移期保留）──
  credential_ref: string | null;
  credential_version: number | null;
  credential_status: string | null;
  credential_fingerprint: string | null;
  credential_provider: string | null;
  credential_last_validated_at: string | null;
  credential_last_auth_failure_at: string | null;
  commit_hash: string | null;
  owner_user_id: string | null;
  user_id: string | null;
  agent_id: string | null;
  task_id: string | null;
  visibility: string;
  status: SyncStatus;
  internal_status: string | null;
  sync_error: string | null;
  stats_json: string | null;
  service_url: string | null;
  summary: string | null;
  version: number;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface CreateCodeGraphInput {
  service_id: string;
  team_id: string;
  repo_url: string;
  branch: string;
  repo_name?: string;
  auth_method?: string;
  access_token?: string | null;
  token_username?: string | null;
  ssh_private_key?: string | null;
  // 凭据引用（949spec §5.2）：优先使用 SecretStore；access_token/ssh_private_key 为迁移期兼容。
  credential_ref?: string | null;
  credential_version?: number | null;
  credential_fingerprint?: string | null;
  credential_provider?: string | null;
  owner_user_id?: string;
  user_id?: string;
  agent_id?: string;
  task_id?: string;
  visibility?: string;
  service_url?: string;
}

export interface CodeGraphStatusPatch {
  status?: SyncStatus;
  internal_status?: string | null;
  sync_error?: string | null;
  commit_hash?: string | null;
  last_sync_at?: string | null;
  stats_json?: string | null;
  service_url?: string | null;
  summary?: string | null;
  version?: number;
  // 凭据引用元数据（949spec §20：rotation/revocation 状态透出；access_token 等明文列清空迁移）
  credential_ref?: string | null;
  credential_version?: number | null;
  credential_status?: string | null;
  credential_fingerprint?: string | null;
  credential_provider?: string | null;
  credential_last_validated_at?: string | null;
  credential_last_auth_failure_at?: string | null;
  access_token?: string | null;
  token_username?: string | null;
  ssh_private_key?: string | null;
}

export interface CodeGraphMetaPatch {
  repo_name?: string;
  summary?: string | null;
}

// ───────────────────────── Wiki ─────────────────────────

export interface WikiRow {
  wiki_id: string;
  service_id: string;
  team_id: string;
  name: string;
  source_type: string | null;
  source_url: string | null;
  owner_user_id: string | null;
  user_id: string | null;
  agent_id: string | null;
  task_id: string | null;
  visibility: string;
  status: WikiStatus;
  internal_status: string | null;
  sync_error: string | null;
  page_count: number | null;
  service_url: string | null;
  summary: string | null;
  version: number;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface CreateWikiInput {
  service_id: string;
  team_id: string;
  name: string;
  source_type?: string;
  source_url?: string;
  owner_user_id?: string;
  user_id?: string;
  agent_id?: string;
  task_id?: string;
  visibility?: string;
  service_url?: string;
}

export interface WikiStatusPatch {
  status?: WikiStatus;
  internal_status?: string | null;
  sync_error?: string | null;
  page_count?: number | null;
  last_sync_at?: string | null;
  service_url?: string | null;
  summary?: string | null;
  version?: number;
}

export interface WikiMetaPatch {
  name?: string;
  summary?: string | null;
}

// ───────────────────────── Audit ─────────────────────────

export type AuditAction = "ingest" | "ready" | "failed" | "delete" | "create";

export interface AuditLogInput {
  service_id?: string | null;
  asset_id: string;
  version: number;
  action: AuditAction;
  user_id?: string | null;
  agent_id?: string | null;
  detail?: string | null;
}

export interface AuditLogRow {
  id: number;
  service_id: string | null;
  asset_id: string;
  version: number;
  action: AuditAction;
  user_id: string | null;
  agent_id: string | null;
  detail: string | null;
  created_at: string;
}

// ───────────────────────── Shared ─────────────────────────

export interface CreateResult<T> {
  row: T;
  existed: boolean;
}

export interface ListOpts {
  // Wiki 用 WikiStatus（含 draft）；code-graph 只用 SyncStatus，传 draft 会得到空集（无副作用）。
  syncStatus?: WikiStatus;
  limit?: number;
  offset?: number;
}

export interface CountOpts {
  syncStatus?: WikiStatus;
}

/** Restart-recovery projection — carries service_id so dirs can be rebuilt per-tenant. */
export interface SyncedCodeGraphRef {
  code_graph_id: string;
  service_id: string;
  team_id: string;
}

export interface SyncedWikiRef {
  wiki_id: string;
  service_id: string;
  team_id: string;
}

// ───────────────────────── Store interface ─────────────────────────

/**
 * Storage-agnostic knowledge metadata store (001 Q6).
 *
 * Tenant isolation contract: every read/write method takes `serviceId` first and
 * filters on it. id-only accessors that do not match the given memory return
 * null/false (never a foreign tenant's row).
 */
export interface IKnowledgeStore {
  // ── Code-Graph ──
  createCodeGraph(input: CreateCodeGraphInput): CreateResult<CodeGraphRow>;
  getCodeGraph(serviceId: string, teamId: string, codeGraphId: string): CodeGraphRow | null;
  getCodeGraphById(serviceId: string, codeGraphId: string): CodeGraphRow | null;
  listCodeGraphs(serviceId: string, teamId: string, opts?: ListOpts): CodeGraphRow[];
  countCodeGraphs(serviceId: string, teamId: string, opts?: CountOpts): number;
  updateCodeGraphStatus(serviceId: string, codeGraphId: string, patch: CodeGraphStatusPatch): void;
  deleteCodeGraph(serviceId: string, teamId: string, codeGraphId: string): boolean;
  updateCodeGraphMeta(serviceId: string, codeGraphId: string, patch: CodeGraphMetaPatch): CodeGraphRow | null;

  // ── Wiki ──
  createWiki(input: CreateWikiInput): CreateResult<WikiRow>;
  getWiki(serviceId: string, teamId: string, wikiId: string): WikiRow | null;
  getWikiById(serviceId: string, wikiId: string): WikiRow | null;
  listWikis(serviceId: string, teamId: string, opts?: ListOpts): WikiRow[];
  countWikis(serviceId: string, teamId: string, opts?: CountOpts): number;
  updateWikiStatus(serviceId: string, wikiId: string, patch: WikiStatusPatch): void;
  deleteWiki(serviceId: string, teamId: string, wikiId: string): boolean;
  updateWikiMeta(serviceId: string, wikiId: string, patch: WikiMetaPatch): WikiRow | null;

  // ── Audit ──
  appendWikiAudit(input: AuditLogInput): void;
  appendCodeGraphAudit(input: AuditLogInput): void;
  listWikiAudit(serviceId: string, wikiId: string, limit?: number, offset?: number): AuditLogRow[];
  listCodeGraphAudit(serviceId: string, codeGraphId: string, limit?: number, offset?: number): AuditLogRow[];

  // ── Restart recovery ──
  /** Sweep all non-terminal (pending/processing) assets to failed, across all tenants. */
  markInterruptedAsFailed(reason?: string): number;
  /** All ready code-graphs (with service_id) so module.ts can rebuild per-tenant dirs. */
  listSyncedCodeGraphs(): SyncedCodeGraphRef[];
  listSyncedWikis(): SyncedWikiRef[];
}

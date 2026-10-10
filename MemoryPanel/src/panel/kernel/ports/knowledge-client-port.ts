/**
 * Knowledge RPC 端口 — Wiki（15 端点）+ Code-Graph（13 端点）。
 *
 * 对齐 docs/knowledge/knowledge-api.yaml（07/08/11 定稿）。管控对
 * wiki/code-graph 不持久化；UI 触发的操作通过该端口直连 core。
 *
 * 寻址规则（与 yaml 严格一致）：
 *  - create / list / *write / *rm 携带 IdFields（team_id 必传，user_id 可选）；
 *  - get / ingest / delete / *ls / *read / graph / search 及全部 code-graph
 *    查询端点仅以资产 id（wiki_id / code_graph_id）寻址，不再传
 *    team/agent/user/task ID（归属由内核侧通过复合键解析）。
 */

// ── Wiki ──

export interface WikiDetail {
  wiki_id: string;
  team_id: string;
  name: string;
  /** null=手工上传；'iwiki' 等=外部来源（决定详情页 UI 走"添加文件"还是"从外部拉取"）。 */
  source_type: string | null;
  /** 外部来源 URL；仅 source_type 非 null 时有值。 */
  source_url: string | null;
  service_url: string | null;
  summary: string | null;
  status: 'draft' | 'pending' | 'processing' | 'ready' | 'failed';
  internal_status?: string | null;
  sync_error: string | null;
  version: string;
  owner_user_id: string | null;
  page_count: number | null;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WikiListResult {
  items: WikiDetail[];
  total: number;
}

export interface WikiIngestResult {
  wiki_id: string;
  /** 设计 2026-09-21 §3.3：新增 'cancelling' 中间态（旧任务取消中，新任务已排队）。 */
  status: string;
  /** true = 已有在途任务，按 onBusy:'replace' 取消旧任务后排队了新任务。 */
  queued?: boolean;
}

/** raw 素材文件项（来自 `raw/sources/` 文件系统 stat）。 */
export interface RawFileEntry {
  filename: string;
  size: number;
  uploaded_at: string;
}

/** processed page 项（来自 `wiki/` 下 ingest 生成的页面）。 */
export interface PageEntry {
  id: string;
  title: string;
  type: string;
  path: string;
  locked?: boolean;
}

export interface WikiRawReadItem {
  filename: string;
  content?: string;
  not_found?: boolean;
}

export interface WikiRawWriteFile {
  filename: string;
  content: string;
}

export interface WikiRawWriteItem {
  filename: string;
  size: number;
}

export interface WikiRawRmResult {
  deleted_files: string[];
  deleted_pages: string[];
  rewritten_pages: number;
}

export interface WikiPageReadItem {
  ref: string;
  content?: string;
  not_found?: boolean;
}

export interface WikiPageWriteItem {
  ref: string;
  content: string;
}

export interface WikiPageWriteResultItem {
  ref: string;
  locked_injected?: boolean;
}

export interface WikiPageRmResult {
  deleted_pages: string[];
  rewritten_files: number;
}

/** 图谱节点（与 Knowledge 服务 /graph 返回的 GraphNode 对齐）。 */
export interface WikiGraphNode {
  id: string;
  label: string;
  type: string;
  path: string;
  linkCount: number;
  community: number;
}

/** 图谱边（`source`/`target` 为节点 id）。 */
export interface WikiGraphEdge {
  source: string;
  target: string;
  weight: number;
}

/** 社区划分结果。 */
export interface WikiGraphCommunity {
  id: number;
  nodeCount: number;
  cohesion: number;
  topNodes: string[];
}

export interface WikiGraphData {
  nodes: WikiGraphNode[];
  edges: WikiGraphEdge[];
  communities?: WikiGraphCommunity[];
}

export interface WikiSearchResult {
  results: Array<{ path: string; title: string; snippet: string; score: number; type: string }>;
  count: number;
}

export interface BatchDeleteResult {
  deleted_ids: string[];
  failed: Array<{ id: string; reason: string }>;
}

// ── Code-Graph ──

export interface CodeGraphDetail {
  code_graph_id: string;
  team_id: string;
  repo_name: string;
  repo_url: string;
  branch: string;
  /** 外部来源（'gongfeng' 等）；null = 公开仓。 */
  source_type: string | null;
  commit_hash: string | null;
  service_url: string | null;
  summary: string | null;
  status: 'pending' | 'processing' | 'ready' | 'failed';
  sync_error: string | null;
  version: string;
  owner_user_id: string | null;
  stats: { files: number; nodes: number; edges: number } | null;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CodeGraphListResult {
  items: CodeGraphDetail[];
  total: number;
}

export interface CodeGraphSyncResult {
  code_graph_id: string;
  status: string;
}

export interface CodeGraphToolResult {
  text: string;
  isError: boolean;
}

// ── 外部来源（代码平台，如工蜂）──
// 来源清单与凭据存储的真相源都在 KS；Panel 只转发，不复制配置、不持有明文。

export interface SourceProviderFormField {
  name: string;
  secret: boolean;
  required: boolean;
}

export interface SourceProviderMeta {
  id: string;
  /** 认证方式类型（bearer / basic / ...），前端据此可做 i18n 差异化提示。 */
  auth_method: "bearer" | "basic";
  /** 表单字段清单，前端按此动态渲染凭据 input。 */
  form_fields: readonly SourceProviderFormField[];
  token_doc_url?: string | null;
}

export interface SourceProviderList {
  items: SourceProviderMeta[];
}

// ── wiki 外部来源（iWiki 等）──
// 与 code 来源同构：Panel 只转发，真相源在 KS。

/** wiki 远端节点（扁平，含目录节点）。 */
export interface WikiRemotePageRef {
  externalId: string;
  title: string;
  path: string;
  parentId?: string | null;
  /** true = 目录，仅展示不可下载。 */
  isDir?: boolean;
  version?: string;
  updatedAt?: string;
}

export interface WikiResolvedRoot {
  rootType: 'dir' | 'doc';
  rootId: string;
  displayName: string;
  estimatedCount?: number;
}

export interface WikiSourceListResult {
  root: WikiResolvedRoot;
  pages: WikiRemotePageRef[];
  /** 可导入（非目录）节点数。 */
  importable: number;
}

export interface WikiSourceImportResult {
  imported: number;
  skippedDirs: number;
  failed: Array<{ id: string; error: string }>;
  warnings: string[];
}

/** 凭据元数据（与 KS 侧 CredentialStatus 对齐）。始终不含 secret。 */
export interface SourceCredentialStatus {
  resource_type: 'code-graph' | 'wiki';
  resource_id: string;
  provider_id: string;
  cred_kind: string;
  last_verified_at: string | null;
  updated_at: string;
}

// ── Port ──

export interface KnowledgeClientPort {
  // Wiki — 资产层（create/list 带 IdFields；get/ingest/delete 仅资产 id 寻址）
  /**
   * 创建 wiki。
   * 外部来源（iWiki 等）须**同时**传 `sourceType` 与 `sourceUrl`：
   * source_type 决定详情页 UI 走「上传文件」还是「从外部拉取」，缺任一 KS 侧会 400。
   */
  wikiCreate(
    teamId: string,
    name: string,
    userId?: string,
    sourceUrl?: string,
    sourceType?: string,
  ): Promise<WikiDetail>;
  wikiGet(wikiId: string): Promise<WikiDetail>;
  /**
   * 触发 ingest（设计 2026-09-21 §3.3）。
   * opts.onBusy='replace' → KS 侧取消旧任务并排队新任务（返回 queued）；
   * 默认 'reject' → 遇到在途任务返回 409 busy。
   */
  wikiIngest(wikiId: string, opts?: { onBusy?: 'reject' | 'replace' }): Promise<WikiIngestResult>;
  wikiDelete(wikiIds: string[]): Promise<BatchDeleteResult>;
  wikiList(teamId: string, opts?: { status?: string; limit?: number; offset?: number }): Promise<WikiListResult>;
  wikiUpdateMeta(wikiId: string, patch: { name?: string; summary?: string | null }): Promise<WikiDetail>;

  // Wiki — raw 文件层（ls/read 仅资产 id；write/rm 带 IdFields）
  wikiRawLs(wikiId: string): Promise<{ items: RawFileEntry[] }>;
  wikiRawRead(wikiId: string, filenames: string[]): Promise<{ items: WikiRawReadItem[] }>;
  wikiRawWrite(teamId: string, wikiId: string, files: WikiRawWriteFile[], userId?: string): Promise<{ items: WikiRawWriteItem[] }>;
  wikiRawRm(teamId: string, wikiId: string, filenames: string[], userId?: string): Promise<WikiRawRmResult>;

  // Wiki — page 文件层（ls/read 仅资产 id；write/rm 带 IdFields）
  wikiPageLs(wikiId: string): Promise<{ items: PageEntry[] }>;
  wikiPageRead(wikiId: string, refs: string[]): Promise<{ items: WikiPageReadItem[] }>;
  wikiPageWrite(teamId: string, wikiId: string, pages: WikiPageWriteItem[], userId?: string): Promise<{ items: WikiPageWriteResultItem[] }>;
  wikiPageRm(teamId: string, wikiId: string, refs: string[], userId?: string): Promise<WikiPageRmResult>;

  // Wiki — 派生视图（仅资产 id 寻址）
  wikiGraph(wikiId: string): Promise<WikiGraphData>;
  wikiSearch(wikiId: string, query: string, limit?: number, graph?: { hop?: number; decay?: number; minScore?: number }): Promise<WikiSearchResult>;

  // Code-Graph（create/list 带 IdFields；get/sync/delete/查询 仅资产 id 寻址）
  codeGraphCreate(
    teamId: string,
    repoUrl: string,
    branch?: string,
    userId?: string,
    repoName?: string,
    opts?: { providerId?: string; secret?: string; username?: string },
  ): Promise<CodeGraphDetail>;
  codeGraphList(teamId: string, opts?: { status?: string; limit?: number; offset?: number }): Promise<CodeGraphListResult>;
  codeGraphGet(codeGraphId: string): Promise<CodeGraphDetail>;
  codeGraphSync(codeGraphId: string): Promise<CodeGraphSyncResult>;
  codeGraphDelete(codeGraphIds: string[]): Promise<BatchDeleteResult>;
  codeGraphUpdateMeta(codeGraphId: string, patch: { repo_name?: string; summary?: string | null }): Promise<CodeGraphDetail>;
  codeGraphQuery(codeGraphId: string, tool: string, params: Record<string, unknown>): Promise<CodeGraphToolResult>;

  // 外部来源（凭据挂在资源上，按 resource_type + resource_id 定位；team 门控由 KS 校验）
  sourceProviderListCode(): Promise<SourceProviderList>;
  /** 已启用的 wiki 来源列表（前端下拉数据源）。 */
  sourceProviderListWiki(): Promise<SourceProviderList>;

  // wiki 外部来源：列文档树 / 导入（不触发 ingest；凭据由 KS 按 wiki_id 注入）
  wikiSourceList(params: {
    wikiId: string;
    sourceUrl: string;
    providerId: string;
    /** 遍历策略；省略 → 用 provider 默认（iWiki 为 tree）。 */
    crawl?: { mode?: "tree" | "links"; maxDepth?: number };
    actor: { teamId: string; userId: string };
  }): Promise<WikiSourceListResult>;
  wikiSourceImport(params: {
    wikiId: string;
    sourceUrl: string;
    providerId: string;
    pageIds?: string[];
    actor: { teamId: string; userId: string };
  }): Promise<WikiSourceImportResult>;

  sourceCredentialStatus(
    resourceType: ResourceType,
    resourceId: string,
    actor: { teamId: string; userId: string },
  ): Promise<SourceCredentialStatus | null>;
  sourceCredentialPut(
    resourceType: ResourceType,
    resourceId: string,
    actor: { teamId: string; userId: string },
    input: { provider_id: string; cred_kind: string; secret: string; username?: string },
  ): Promise<SourceCredentialStatus>;
  sourceCredentialDelete(
    resourceType: ResourceType,
    resourceId: string,
    actor: { teamId: string; userId: string },
  ): Promise<{ deleted: boolean }>;
}

/** 外部来源凭据挂载的资源类型（与 KS 侧 ResourceRef.type 对齐）。 */
export type ResourceType = 'code-graph' | 'wiki';

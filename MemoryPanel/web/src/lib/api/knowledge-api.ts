/**
 * Knowledge Panel API 客户端（v1.0 冻结）
 *
 * 对接文档：docs/api/knowledge-panel-api.md
 * 前缀：`/api/v1/knowledge`，全部 POST，统一信封 { code, message, request_id, data }
 * 鉴权：`X-Tdai-Service-Id` + `X-Tdai-User-Key`（与 meta API 一致）
 *
 * 本期接入（§2.0 最小端点集）：
 *   Wiki: list / create / ingest / get / delete / graph / page/ls / page/read /
 *         search / raw/ls / raw/read / raw/write（12 个）
 *   Code-Graph: list / create / sync / delete / search / explore（6 个）
 */

import { getPanelSession } from '../panelSession';
import { formatApiErrorMessage } from '../error-message';
import i18n from '@/i18n';

const BASE = '/api/v1/knowledge';

// ========================= Envelope =========================

interface Envelope<T = unknown> {
  code: number;
  message: string;
  request_id: string;
  data: T;
}

export class KnowledgeApiError extends Error {
  code: number;
  requestId: string;
  rawMessage: string;

  constructor(code: number, message: string, requestId: string) {
    super(formatApiErrorMessage({ code, message, requestId }));
    this.name = 'KnowledgeApiError';
    this.code = code;
    this.requestId = requestId;
    this.rawMessage = message;
  }
}

// ========================= Base Request =========================

async function panelPost<T>(path: string, body?: unknown): Promise<T> {
  const session = getPanelSession();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (session) {
    headers['X-Tdai-Service-Id'] = session.instanceId;
    headers['X-Tdai-User-Key'] = session.userKey;
  }
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let env: Envelope<T>;
  try {
    env = JSON.parse(text) as Envelope<T>;
  } catch {
    throw new KnowledgeApiError(res.status || 500, text || res.statusText || 'Knowledge request failed', '');
  }
  if (!res.ok || env.code !== 0) {
    throw new KnowledgeApiError(env.code ?? res.status, env.message || res.statusText, env.request_id);
  }
  return env.data;
}

// ========================= Types（对接 Panel API） =========================

export interface WikiDetail {
  wiki_id: string;
  team_id: string;
  name: string;
  service_url: string | null;
  summary: string | null;
  status: 'draft' | 'pending' | 'processing' | 'ready' | 'failed' | 'missing';
  internal_status?: string | null;
  sync_error: string | null;
  version: string;
  owner_user_id: string | null;
  page_count: number | null;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CodeGraphDetail {
  code_graph_id: string;
  team_id: string;
  repo_name: string;
  repo_url: string;
  branch: string;
  commit_hash: string | null;
  service_url: string | null;
  summary: string | null;
  status: 'pending' | 'processing' | 'ready' | 'failed' | 'missing';
  sync_error: string | null;
  version: string;
  owner_user_id: string | null;
  stats: { files: number; nodes: number; edges: number } | null;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

// ---- 兼容旧类型（平滑过渡） ----

/** @deprecated 用 WikiDetail 替代 */
export interface WikiSource {
  wiki_id?: string;
  name: string;
  status: string;
  pageCount?: number;
  lastSync?: string;
  error?: string;
  agent_id?: string;
}

/** @deprecated 用 CodeGraphDetail 替代 */
export interface CodeSource {
  code_graph_id?: string;
  repo: string;
  branch: string;
  repo_url?: string;
  repo_name?: string;
  gitUrl?: string;
  status: string;
  commit?: string;
  stats?: { files: number; nodes: number; edges: number };
  lastSyncAt?: string;
  error?: string;
  sync_error?: string;
  agent_id?: string;
}

/**
 * 导入知识库后触发异步 ingest。旧代码期望 SSE 进度流 => 新 Panel 无 SSE，
 * 前端转为：触发 ingest → 轮询 get 看 status。回调签名仅为兼容旧 UI 的进度条展示。
 */
export interface IngestProgressEvent {
  type: 'file_start' | 'file_done' | 'file_error' | 'batch_done';
  file?: string;
  detail?: string;
  done?: number;
  total?: number;
  error?: string;
  ts: number;
}

export interface IngestStreamCallbacks {
  onProgress?: (event: IngestProgressEvent) => void;
  onComplete?: (result: { total: number; ingested: number }) => void;
  onError?: (error: string) => void;
}

// 图谱类型（与旧版兼容）
export interface GraphNode { id: string; label: string; type: string; path: string; linkCount: number; community: number; }
export interface GraphEdge { source: string; target: string; weight: number; }
export interface GraphData { nodes: GraphNode[]; edges: GraphEdge[]; communities?: { id: number; nodeCount: number; topNodes: string[] }[]; }

export interface WikiPage { path: string; title: string; type: string; tags?: string[]; created?: string; updated?: string; }

/** meta + KS join 后的列表项（team-assets） */
export interface KnowledgeAssetItem {
  knowledge_id: string;
  asset_type: string;
  name: string;
  description?: string | null;
  visibility: string;
  owner_user_id: string;
  meta_status: string;
  status: string;
  internal_status?: string | null;
  sync_error?: string | null;
  ks_missing?: boolean;
  team_id?: string;
  summary?: string | null;
  page_count?: number | null;
  last_sync_at?: string | null;
  repo_name?: string;
  repo_url?: string;
  branch?: string;
  commit_hash?: string | null;
  stats?: { files: number; nodes: number; edges: number } | null;
  created_at?: string;
  updated_at?: string;
}

function assetItemToWiki(item: KnowledgeAssetItem): WikiDetail {
  return {
    wiki_id: item.knowledge_id,
    team_id: item.team_id ?? '',
    name: item.name,
    service_url: null,
    summary: item.summary ?? null,
    status: (item.status as WikiDetail['status']) || 'draft',
    internal_status: item.internal_status ?? null,
    sync_error: item.sync_error ?? null,
    version: '1',
    owner_user_id: item.owner_user_id,
    page_count: item.page_count ?? null,
    last_sync_at: item.last_sync_at ?? null,
    created_at: item.created_at ?? '',
    updated_at: item.updated_at ?? '',
  };
}

function assetItemToCode(item: KnowledgeAssetItem): CodeGraphDetail {
  return {
    code_graph_id: item.knowledge_id,
    team_id: item.team_id ?? '',
    repo_name: item.repo_name ?? item.name,
    repo_url: item.repo_url ?? '',
    branch: item.branch ?? 'main',
    commit_hash: item.commit_hash ?? null,
    service_url: null,
    summary: item.summary ?? null,
    status: (item.status as CodeGraphDetail['status']) || 'pending',
    sync_error: item.sync_error ?? null,
    version: '1',
    owner_user_id: item.owner_user_id,
    stats: item.stats ?? null,
    last_sync_at: item.last_sync_at ?? null,
    created_at: item.created_at ?? '',
    updated_at: item.updated_at ?? '',
  };
}

async function listTeamAssets(path: string, teamId: string): Promise<KnowledgeAssetItem[]> {
  const d = await panelPost<{ items: KnowledgeAssetItem[]; total: number }>(path, { team_id: teamId });
  return d.items ?? [];
}

export interface KnowledgeFixedItem {
  knowledge_id: string;
  asset_type: 'llm_wiki' | 'code_graph';
  name: string;
  description?: string | null;
  status: string;
  visibility: string;
  agent_id: string;
}

async function allocateKnowledge(teamId: string, knowledgeId: string, agentId: string): Promise<void> {
  await panelPost('/allocate', { team_id: teamId, knowledge_id: knowledgeId, agent_id: agentId });
}

async function unbindKnowledge(knowledgeId: string, agentId: string): Promise<void> {
  await panelPost('/unbind', { knowledge_id: knowledgeId, agent_id: agentId });
}

async function listAgentFixedKnowledge(agentId: string): Promise<KnowledgeFixedItem[]> {
  const d = await panelPost<{ items: KnowledgeFixedItem[]; total: number }>('/agent-fixed', { agent_id: agentId });
  return d.items ?? [];
}

// ========================= Wiki API =========================

export function wikiStageLabel(status: WikiDetail['status'], internalStatus?: string | null): string {
  if (status === 'missing') return i18n.t('wiki.status.missing');
  if (status === 'pending') return i18n.t('wiki.status.pending');
  if (status === 'ready') return i18n.t('wiki.status.ready');
  if (status === 'failed') return i18n.t('wiki.status.failed');
  if (status === 'draft') return i18n.t('wiki.status.draft');
  const map: Record<string, string> = {
    scanning: i18n.t('knowledgeApi.stage.scanning'),
    ingesting: i18n.t('knowledgeApi.stage.ingesting'),
    'rebuilding-index': i18n.t('knowledgeApi.stage.rebuildingIndex'),
  };
  return internalStatus ? (map[internalStatus] ?? internalStatus) : i18n.t('knowledgeApi.stage.processing');
}

export function wikiProgressPercent(status: WikiDetail['status'], internalStatus?: string | null): number {
  if (status === 'ready') return 100;
  if (status === 'failed') return 100;
  if (status === 'missing') return 100;
  if (status === 'pending') return 5;
  if (status === 'processing') {
    if (internalStatus === 'scanning') return 20;
    if (internalStatus === 'ingesting') return 60;
    if (internalStatus === 'rebuilding-index') return 85;
    return 40;
  }
  return 0;
}

export const knowledgeApi = {
  health: () => panelPost<Record<string, unknown>>('/health').catch(() => ({ ok: true })),

  /** 读取某个 Agent 已绑定的全部 Knowledge 固定资产（wiki + code_graph）。 */
  agentFixed: (agentId: string): Promise<KnowledgeFixedItem[]> => listAgentFixedKnowledge(agentId),

  // ---- Wiki ----

  wiki: {
    /** 创建 wiki。返回 WikiDetail（含 wiki_id） */
    create: (teamId: string, name: string): Promise<WikiDetail> =>
      panelPost('/wiki/create', { team_id: teamId, name }),

    /** @deprecated 使用 teamAssets */
    list: async (teamId: string): Promise<WikiDetail[]> => {
      const d = await panelPost<{ items: WikiDetail[]; total: number }>('/wiki/list', { team_id: teamId });
      return d.items ?? [];
    },

    /** 团队 Wiki 池（meta list-accessible visibility=team + KS join） */
    teamAssets: async (teamId: string): Promise<WikiDetail[]> => {
      const items = await listTeamAssets('/wiki/team-assets', teamId);
      return items.map(assetItemToWiki);
    },

    /** 获取详情（含 status，用于 ingest 后轮询） */
    get: (wikiId: string): Promise<WikiDetail> =>
      panelPost('/wiki/get', { wiki_id: wikiId }),

    /** 触发异步 ingest（返回后轮询 get 看 status） */
    ingest: (wikiId: string): Promise<void> =>
      panelPost('/wiki/ingest', { wiki_id: wikiId }),

    /** 触发 ingest 后轮询 wiki/get，用真实 status/internal_status 驱动进度展示。 */
    ingestWithPolling: async (wikiId: string, callbacks: IngestStreamCallbacks, _teamId: string): Promise<void> => {
      try {
        callbacks.onProgress?.({ type: 'file_start', detail: i18n.t('knowledgeApi.ingest.triggering'), done: 0, total: 100, ts: Date.now() });
        try {
          await knowledgeApi.wiki.ingest(wikiId);
        } catch (err: unknown) {
          // 已经在 pending/processing 时，KS 会返回 409 busy；前端继续轮询现有任务。
          if (!(err instanceof KnowledgeApiError && err.code === 409)) throw err;
        }

        const maxAttempts = 300; // 最多约 10 分钟；每次都实际查询 wiki/get。
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          await new Promise(r => setTimeout(r, attempt === 1 ? 800 : 2000));
          const detail = await knowledgeApi.wiki.get(wikiId);
          const stage = wikiStageLabel(detail.status, detail.internal_status);
          const done = wikiProgressPercent(detail.status, detail.internal_status);
          const pageHint = typeof detail.page_count === 'number' ? i18n.t('knowledgeApi.ingest.currentPage', { count: detail.page_count }) : '';
          callbacks.onProgress?.({
            type: 'file_done',
            detail: i18n.t('knowledgeApi.ingest.check', { attempt, stage, pageHint }),
            done,
            total: 100,
            ts: Date.now(),
          });

          if (detail.status === 'ready') {
            callbacks.onProgress?.({ type: 'batch_done', detail: i18n.t('knowledgeApi.ingest.complete'), done: 100, total: 100, ts: Date.now() });
            const count = detail.page_count ?? 0;
            callbacks.onComplete?.({ total: count, ingested: count });
            return;
          }
          if (detail.status === 'failed') {
            callbacks.onError?.(detail.sync_error || i18n.t('knowledgeApi.ingest.failed'));
            return;
          }
        }
        callbacks.onError?.(i18n.t('knowledgeApi.ingest.timeout'));
      } catch (err: unknown) {
        callbacks.onError?.(err instanceof Error ? err.message : String(err));
      }
    },

    /** 删除 */
    delete: (wikiId: string): Promise<void> =>
      panelPost('/wiki/delete', { wiki_ids: [wikiId] }),

    /** 图谱 */
    graph: (wikiId: string): Promise<GraphData> =>
      panelPost('/wiki/graph', { wiki_id: wikiId }),

    /** 页面列表 */
    pages: async (wikiId: string): Promise<WikiPage[]> => {
      const d = await panelPost<{ items: WikiPage[] }>('/wiki/page/ls', { wiki_id: wikiId });
      return d.items ?? [];
    },

    /** 读页面（含 raw/sources/...） */
    read: async (wikiId: string, path: string): Promise<{ content: string }> => {
      const d = await panelPost<{ items: Array<{ ref: string; content?: string; not_found?: boolean }> }>(
        '/wiki/page/read', { wiki_id: wikiId, refs: [path] }
      );
      const item = d.items?.[0];
      if (item?.not_found) throw new Error(i18n.t('knowledgeApi.pageNotFound', { path }));
      return { content: item?.content ?? '' };
    },

    /** 删除 processed wiki 页面 */
    pageDelete: (wikiId: string, refs: string[]): Promise<void> =>
      panelPost('/wiki/page/rm', { wiki_id: wikiId, refs }),

    /** 全文搜索 */
    search: (wikiId: string, query: string, limit?: number): Promise<{
      results: Array<{ path: string; title: string; snippet: string; score: number; type: string }>;
    }> =>
      panelPost('/wiki/search', { wiki_id: wikiId, query, limit: limit ?? 20 }),

    /** raw 文件列表 */
    rawList: async (wikiId: string): Promise<{ files: Array<{ filename: string; size: number }> }> => {
      const d = await panelPost<{ items: Array<{ filename: string; size: number }> }>(
        '/wiki/raw/ls', { wiki_id: wikiId }
      );
      return { files: d.items ?? [] };
    },

    /** raw 文件读取 */
    rawRead: (wikiId: string, filenames: string[]): Promise<{ items: Array<{ filename: string; content?: string; not_found?: boolean }> }> =>
      panelPost('/wiki/raw/read', { wiki_id: wikiId, filenames }),

    /** 删除 raw 原始文档 */
    rawDelete: (wikiId: string, filenames: string[]): Promise<void> =>
      panelPost('/wiki/raw/rm', { wiki_id: wikiId, filenames }),

    /** raw 文件上传 */
    upload: (opts: { teamId: string; wikiId: string; filename: string; content: string }): Promise<void> =>
      panelPost('/wiki/raw/write', { team_id: opts.teamId, wiki_id: opts.wikiId, files: [{ filename: opts.filename, content: opts.content }] }),

    allocate: (teamId: string, wikiId: string, agentId: string): Promise<void> =>
      allocateKnowledge(teamId, wikiId, agentId),

    unbind: (wikiId: string, agentId: string): Promise<void> =>
      unbindKnowledge(wikiId, agentId),

    agentFixed: async (agentId: string): Promise<KnowledgeFixedItem[]> => {
      const items = await listAgentFixedKnowledge(agentId);
      return items.filter((it) => it.asset_type === 'llm_wiki');
    },
  },

  // ---- Code-Graph ----

  code: {
    /** 创建（注册仓库） */
    create: (opts: { teamId: string; repoUrl: string; branch?: string; repoName?: string }): Promise<CodeGraphDetail> =>
      panelPost('/code-graph/create', { team_id: opts.teamId, repo_url: opts.repoUrl, branch: opts.branch ?? 'main', repo_name: opts.repoName }),

    /** @deprecated 使用 teamAssets */
    list: async (teamId: string): Promise<CodeGraphDetail[]> => {
      const d = await panelPost<{ items: CodeGraphDetail[]; total: number }>('/code-graph/list', { team_id: teamId });
      return d.items ?? [];
    },

    /** 团队 Code 池 */
    teamAssets: async (teamId: string): Promise<CodeGraphDetail[]> => {
      const items = await listTeamAssets('/code-graph/team-assets', teamId);
      return items.map(assetItemToCode);
    },

    /** code ready 后登记 meta（create 时不写 meta） */
    registerMeta: (teamId: string, codeGraphId: string): Promise<void> =>
      panelPost('/code-graph/register-meta', { team_id: teamId, code_graph_id: codeGraphId }),

    /** 触发 sync（异步，同 ingest 轮询 get） */
    sync: (codeGraphId: string): Promise<void> =>
      panelPost('/code-graph/sync', { code_graph_id: codeGraphId }),

    /** 删除 */
    delete: (codeGraphId: string): Promise<void> =>
      panelPost('/code-graph/delete', { code_graph_ids: [codeGraphId] }),

    /** 代码搜索（返回 { text, isError } 文本块） */
    search: (opts: { codeGraphId: string; query: string; kind?: string; limit?: number }): Promise<{ text: string; isError: boolean }> =>
      panelPost('/code-graph/search', { code_graph_id: opts.codeGraphId, query: opts.query, ...(opts.kind && opts.kind !== 'any' ? { kind: opts.kind } : {}), limit: opts.limit ?? 10 }),

    /** 代码探索（返回 { text, isError } 文本块） */
    explore: (codeGraphId: string, query: string): Promise<{ text: string; isError: boolean }> =>
      panelPost('/code-graph/explore', { code_graph_id: codeGraphId, query }),

    /** 详情（用于 sync 后轮询） */
    get: (codeGraphId: string): Promise<CodeGraphDetail> =>
      panelPost('/code-graph/get', { code_graph_id: codeGraphId }),

    allocate: (teamId: string, codeGraphId: string, agentId: string): Promise<void> =>
      allocateKnowledge(teamId, codeGraphId, agentId),

    unbind: (codeGraphId: string, agentId: string): Promise<void> =>
      unbindKnowledge(codeGraphId, agentId),

    agentFixed: async (agentId: string): Promise<KnowledgeFixedItem[]> => {
      const items = await listAgentFixedKnowledge(agentId);
      return items.filter((it) => it.asset_type === 'code_graph');
    },
  },

  // ---- Connectors（导入 iwiki / TAPD 文档） ----
  connectors: {
    pull: (name: string, params: Record<string, unknown>): Promise<void> =>
      panelPost('/connectors/pull', { name, ...params }),
  },
};

// ========================= 工具函数 =========================

/** 轮询 wiki ingest 状态直到 ready/failed */
export async function pollWikiStatus(wikiId: string, maxAttempts = 30, intervalMs = 3000): Promise<WikiDetail> {
  for (let i = 0; i < maxAttempts; i++) {
    const detail = await knowledgeApi.wiki.get(wikiId);
    if (detail.status === 'ready' || detail.status === 'failed') return detail;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(i18n.t('knowledgeApi.wikiIngestTimeout', { wikiId }));
}

/** 轮询 code-graph sync 状态 */
export async function pollCodeGraphStatus(codeGraphId: string, maxAttempts = 30, intervalMs = 5000): Promise<CodeGraphDetail> {
  for (let i = 0; i < maxAttempts; i++) {
    const detail = await knowledgeApi.code.get(codeGraphId);
    if (detail.status === 'ready' || detail.status === 'failed') return detail;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(i18n.t('knowledgeApi.codeGraphSyncTimeout', { codeGraphId }));
}

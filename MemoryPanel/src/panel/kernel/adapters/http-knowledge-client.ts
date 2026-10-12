/**
 * Knowledge HTTP 客户端 — 调 core 的 /v3/wiki/* 和 /v3/code-graph/*.
 *
 * 路径与请求体严格对齐 docs/knowledge/knowledge-api.yaml（07/08/11 定稿）。
 * 注：core router 实际监听 `/v3/wiki/*`、`/v3/code-graph/*`，
 * 故此处 baseUrl 不含 /v3，路径带 /v3 前缀。
 *
 * 与 HttpSkillClient 同模式：Bearer + service-id + envelope 解析。
 */
import { CoreUpstreamError } from '../../domain/errors.js';
import type {
  KnowledgeClientPort,
  WikiDetail,
  WikiListResult,
  WikiIngestResult,
  WikiGraphData,
  WikiSearchResult,
  BatchDeleteResult,
  RawFileEntry,
  PageEntry,
  WikiRawReadItem,
  WikiRawWriteFile,
  WikiRawWriteItem,
  WikiRawRmResult,
  WikiPageReadItem,
  WikiPageWriteItem,
  WikiPageWriteResultItem,
  WikiPageRmResult,
  CodeGraphDetail,
  CodeGraphListResult,
  CodeGraphSyncResult,
  CodeGraphToolResult,
  SourceProviderList,
  WikiSourceListResult,
  WikiSourceImportResult,
  SourceCredentialStatus,
  ResourceType,
} from '../ports/knowledge-client-port.js';

export interface KnowledgeClientConfig {
  baseUrl: string;
  authToken: string;
  serviceId?: string;
  timeoutMs?: number;
}

interface CoreEnvelope<T> {
  code: number;
  message?: string;
  request_id?: string;
  data?: T;
}

export class HttpKnowledgeClient implements KnowledgeClientPort {
  constructor(private readonly cfg: KnowledgeClientConfig) {}

  /**
   * 统一请求入口。KS 的外部来源接口（source-provider / source-credential）
   * 用 GET/DELETE + query，故不能只支持 POST。
   */
  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    opts?: { body?: unknown; query?: Record<string, string>; userId?: string; teamId?: string },
  ): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 15_000);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.cfg.authToken) headers.Authorization = `Bearer ${this.cfg.authToken}`;
      if (this.cfg.serviceId) headers['x-tdai-service-id'] = this.cfg.serviceId;
      // 资源级凭据接口需要 team_id（KS 用于越权门控）+ user_id（审计）
      if (opts?.teamId) headers['x-tdai-team-id'] = opts.teamId;
      if (opts?.userId) headers['x-tdai-user-id'] = opts.userId;

      const qs = opts?.query
        ? '?' + new URLSearchParams(
            Object.entries(opts.query).filter(([, v]) => v !== undefined && v !== ''),
          ).toString()
        : '';
      const resp = await fetch(`${this.cfg.baseUrl}${path}${qs}`, {
        method,
        headers,
        body: method === 'GET' ? undefined : JSON.stringify(opts?.body ?? {}),
        signal: ctrl.signal,
      });
      const json = (await resp.json()) as CoreEnvelope<T>;
      if (json.code !== undefined && json.code !== 0) {
        throw new CoreUpstreamError(
          'CORE_UPSTREAM_ERROR',
          resp.status >= 400 ? resp.status : 502,
          json.message || `core error code ${json.code}`,
          json.code,
        );
      }
      if (!resp.ok) {
        throw new CoreUpstreamError('CORE_UPSTREAM_ERROR', resp.status, json.message || `HTTP ${resp.status}`, 0);
      }
      return json.data as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** POST 便捷封装（绝大多数 KS 接口是 POST + JSON body）。 */
  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, { body });
  }

  // ═══════════════ 外部来源（工蜂 / GitHub / GitLab）═══════════════
  //
  // 均为 KS 的薄转发：来源清单与凭据存储的唯一真相源都在 KS，Panel 只带上
  // 实例凭证与调用者身份。凭据挂在**资源**上（resource_type + resource_id），
  // 与用户/access-key 解耦；team 门控由 KS 用 x-tdai-team-id 校验。

  /** 已启用的 codegraph 来源列表（前端下拉数据源）。 */
  async sourceProviderListCode(): Promise<SourceProviderList> {
    return this.request<SourceProviderList>('GET', '/v3/source-provider/code');
  }

  /** 已启用的 wiki 来源列表（前端下拉数据源）。 */
  async sourceProviderListWiki(): Promise<SourceProviderList> {
    return this.request<SourceProviderList>('GET', '/v3/source-provider/wiki');
  }

  /**
   * 列远端文档树（resolveRoot + listPages）。
   * 凭据由 KS 按 wiki_id 从凭据表注入，Panel 不接触明文。
   */
  async wikiSourceList(params: {
    wikiId: string;
    sourceUrl: string;
    providerId: string;
    crawl?: { mode?: 'tree' | 'links'; maxDepth?: number };
    actor: { teamId: string; userId: string };
  }): Promise<WikiSourceListResult> {
    return this.request<WikiSourceListResult>('POST', '/v3/wiki-source/list', {
      body: {
        wiki_id: params.wikiId,
        source_url: params.sourceUrl,
        provider_id: params.providerId,
        ...(params.crawl ? { crawl: params.crawl } : {}),
      },
      ...params.actor,
    });
  }

  /** 导入远端文档（拉取 + 写盘，不触发 ingest）。pageIds 省略 → 全部非目录节点。 */
  async wikiSourceImport(params: {
    wikiId: string;
    sourceUrl: string;
    providerId: string;
    pageIds?: string[];
    actor: { teamId: string; userId: string };
  }): Promise<WikiSourceImportResult> {
    return this.request<WikiSourceImportResult>('POST', '/v3/wiki-source/import', {
      body: {
        wiki_id: params.wikiId,
        source_url: params.sourceUrl,
        provider_id: params.providerId,
        ...(params.pageIds ? { page_ids: params.pageIds } : {}),
      },
      ...params.actor,
    });
  }

  /** 某资源当前的凭据状态（仅元数据）。未配置 → data.credential 为 null，Panel 层直接透传。 */
  async sourceCredentialStatus(
    resourceType: ResourceType,
    resourceId: string,
    actor: { teamId: string; userId: string },
  ): Promise<SourceCredentialStatus | null> {
    const res = await this.request<{ configured: boolean; credential: SourceCredentialStatus | null }>(
      'GET',
      '/v3/source-credential/status',
      { query: { resource_type: resourceType, resource_id: resourceId }, ...actor },
    );
    return res.credential;
  }

  /** 写入 / 更新某资源的令牌。明文只在本次 body 内经 Panel 转发给 KS，不写日志。 */
  async sourceCredentialPut(
    resourceType: ResourceType,
    resourceId: string,
    actor: { teamId: string; userId: string },
    input: { provider_id: string; cred_kind: string; secret: string; username?: string },
  ): Promise<SourceCredentialStatus> {
    const res = await this.request<{ credential: SourceCredentialStatus }>(
      'PUT',
      '/v3/source-credential/put',
      {
        body: {
          resource_type: resourceType,
          resource_id: resourceId,
          ...input,
        },
        ...actor,
      },
    );
    return res.credential;
  }

  /** 删除某资源的令牌。 */
  async sourceCredentialDelete(
    resourceType: ResourceType,
    resourceId: string,
    actor: { teamId: string; userId: string },
  ): Promise<{ deleted: boolean }> {
    return this.request<{ deleted: boolean }>('DELETE', '/v3/source-credential/delete', {
      query: { resource_type: resourceType, resource_id: resourceId },
      ...actor,
    });
  }

  // ═══════════════ Wiki · 资产层 ═══════════════

  async wikiCreate(
    teamId: string,
    name: string,
    userId?: string,
    sourceUrl?: string,
    sourceType?: string,
  ): Promise<WikiDetail> {
    // source_type / source_url 必须成对下发：KS 侧拒绝只给其一的请求。
    return this.post('/v3/wiki/create', {
      team_id: teamId,
      name,
      user_id: userId,
      ...(sourceUrl && sourceType ? { source_url: sourceUrl, source_type: sourceType } : {}),
    });
  }

  async wikiGet(wikiId: string): Promise<WikiDetail> {
    return this.post('/v3/wiki/get', { wiki_id: wikiId });
  }

  async wikiIngest(wikiId: string, opts?: { onBusy?: 'reject' | 'replace' }): Promise<WikiIngestResult> {
    return this.post('/v3/wiki/ingest', { wiki_id: wikiId, on_busy: opts?.onBusy });
  }

  async wikiDelete(wikiIds: string[]): Promise<BatchDeleteResult> {
    return this.post('/v3/wiki/delete', { wiki_ids: wikiIds });
  }

  async wikiList(teamId: string, opts?: { status?: string; limit?: number; offset?: number }): Promise<WikiListResult> {
    return this.post('/v3/wiki/list', { team_id: teamId, ...opts });
  }

  // ═══════════════ Wiki · raw 文件层 ═══════════════

  async wikiRawLs(wikiId: string): Promise<{ items: RawFileEntry[] }> {
    return this.post('/v3/wiki/raw/ls', { wiki_id: wikiId });
  }

  async wikiRawRead(wikiId: string, filenames: string[]): Promise<{ items: WikiRawReadItem[] }> {
    return this.post('/v3/wiki/raw/read', { wiki_id: wikiId, filenames });
  }

  async wikiRawWrite(teamId: string, wikiId: string, files: WikiRawWriteFile[], userId?: string): Promise<{ items: WikiRawWriteItem[] }> {
    return this.post('/v3/wiki/raw/write', { team_id: teamId, user_id: userId, wiki_id: wikiId, files });
  }

  async wikiRawRm(teamId: string, wikiId: string, filenames: string[], userId?: string): Promise<WikiRawRmResult> {
    return this.post('/v3/wiki/raw/rm', { team_id: teamId, user_id: userId, wiki_id: wikiId, filenames });
  }

  // ═══════════════ Wiki · page 文件层 ═══════════════

  async wikiPageLs(wikiId: string): Promise<{ items: PageEntry[] }> {
    return this.post('/v3/wiki/page/ls', { wiki_id: wikiId });
  }

  async wikiPageRead(wikiId: string, refs: string[]): Promise<{ items: WikiPageReadItem[] }> {
    return this.post('/v3/wiki/page/read', { wiki_id: wikiId, refs });
  }

  async wikiPageWrite(teamId: string, wikiId: string, pages: WikiPageWriteItem[], userId?: string): Promise<{ items: WikiPageWriteResultItem[] }> {
    return this.post('/v3/wiki/page/write', { team_id: teamId, user_id: userId, wiki_id: wikiId, pages });
  }

  async wikiPageRm(teamId: string, wikiId: string, refs: string[], userId?: string): Promise<WikiPageRmResult> {
    return this.post('/v3/wiki/page/rm', { team_id: teamId, user_id: userId, wiki_id: wikiId, refs });
  }

  // ═══════════════ Wiki · 派生视图 ═══════════════

  async wikiGraph(wikiId: string): Promise<WikiGraphData> {
    return this.post('/v3/wiki/graph', { wiki_id: wikiId });
  }

  async wikiSearch(wikiId: string, query: string, limit?: number, graph?: { hop?: number; decay?: number; minScore?: number }): Promise<WikiSearchResult> {
    return this.post('/v3/wiki/search', { wiki_id: wikiId, query, limit: limit ?? 20, ...(graph && Object.keys(graph).length > 0 ? { graph } : {}) });
  }

  async wikiUpdateMeta(wikiId: string, patch: { name?: string; summary?: string | null }): Promise<WikiDetail> {
    return this.post('/v3/wiki/update-meta', { wiki_id: wikiId, ...patch });
  }

  // ═══════════════ Code-Graph ═══════════════

  async codeGraphCreate(
    teamId: string,
    repoUrl: string,
    branch?: string,
    userId?: string,
    repoName?: string,
    opts?: { providerId?: string; secret?: string; username?: string },
  ): Promise<CodeGraphDetail> {
    return this.post('/v3/code-graph/create', {
      team_id: teamId,
      user_id: userId,
      repo_url: repoUrl,
      branch: branch ?? 'main',
      repo_name: repoName,
      ...(opts?.providerId && opts.secret
        ? {
            provider_id: opts.providerId,
            secret: opts.secret,
            ...(opts.username ? { username: opts.username } : {}),
          }
        : {}),
    });
  }

  async codeGraphList(teamId: string, opts?: { status?: string; limit?: number; offset?: number }): Promise<CodeGraphListResult> {
    return this.post('/v3/code-graph/list', { team_id: teamId, ...opts });
  }

  async codeGraphGet(codeGraphId: string): Promise<CodeGraphDetail> {
    return this.post('/v3/code-graph/get', { code_graph_id: codeGraphId });
  }

  async codeGraphSync(codeGraphId: string): Promise<CodeGraphSyncResult> {
    return this.post('/v3/code-graph/sync', { code_graph_id: codeGraphId });
  }

  async codeGraphDelete(codeGraphIds: string[]): Promise<BatchDeleteResult> {
    return this.post('/v3/code-graph/delete', { code_graph_ids: codeGraphIds });
  }

  async codeGraphUpdateMeta(codeGraphId: string, patch: { repo_name?: string; summary?: string | null }): Promise<CodeGraphDetail> {
    return this.post('/v3/code-graph/update-meta', { code_graph_id: codeGraphId, ...patch });
  }

  async codeGraphQuery(codeGraphId: string, tool: string, params: Record<string, unknown>): Promise<CodeGraphToolResult> {
    return this.post(`/v3/code-graph/${tool}`, { code_graph_id: codeGraphId, ...params });
  }
}

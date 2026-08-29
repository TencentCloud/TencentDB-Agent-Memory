/**
 * CoreKnowledgeClient — minimal HTTP client for the kernel knowledge entity API.
 *
 * Calls POST /v3/knowledge/list with {team_id} to fetch all knowledge
 * resources (wiki + code-graph) for a team. Used by KnowledgeToolsInjector
 * at session_init prewarm time.
 *
 * Auth: reuses the same `serviceToken` + `x-tdai-service-id` as CoreSkillClient
 * (same kernel endpoint, 8420).
 *
 * Pattern mirrors src/skill/core-client.ts.
 */

import type { CoreSkillConfig } from "../types.js";

type Fetcher = typeof fetch;

const TAG = "[core-knowledge-client]";

/**
 * TTL cache（2026-08-20）：kernel 偶发 timeout（现网 33% 命中率），会阻塞 prewarm。
 * 加 30s in-memory cache + stale-if-error 兜底：cache miss 后 fetch 失败时返回
 * 上次成功结果，避免 injection 空。env TDAI_KNOWLEDGE_CACHE_TTL_MS 可覆盖；0 关闭。
 */
const DEFAULT_CACHE_TTL_MS = 30_000;

function readCacheTtlMs(): number {
  const raw = process.env.TDAI_KNOWLEDGE_CACHE_TTL_MS;
  if (raw === undefined || raw === "") return DEFAULT_CACHE_TTL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_CACHE_TTL_MS;
  return n;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface KnowledgeItem {
  knowledge_id: string;
  type: "wiki" | "code-graph";
  service_url: string;
  name: string;
  summary: string | null;
  team_id: string;
  user_id: string | null;
  repo_url?: string;
  branch?: string;
  /**
   * Repo slug (`<org>/.../<repo>`) used as the anchor hint the agent matches
   * against the local workspace. Optional — derived from `repo_url` when the
   * backend does not supply it.
   */
  repo_slug?: string;
  created_at: string;
  updated_at: string;
}

interface CoreEnvelope<T> {
  code: number;
  message?: string;
  request_id?: string;
  data?: T;
}

export interface CoreKnowledgeListResult {
  items: KnowledgeItem[];
  total: number;
}

export class CoreKnowledgeClient {
  private readonly endpoint: string;
  private readonly serviceToken: string;
  private readonly serviceId: string;
  private readonly defaultTimeoutMs: number;
  private readonly fetcher: Fetcher;

  // TTL cache + stale-if-error 兜底表
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly lastGood = new Map<string, unknown>();
  private readonly cacheTtlMs: number;

  constructor(
    config: Pick<CoreSkillConfig, "endpoint" | "serviceToken" | "serviceId" | "timeoutMs">,
    fetcher: Fetcher = globalThis.fetch.bind(globalThis),
  ) {
    this.endpoint = config.endpoint.replace(/\/$/, "");
    this.serviceToken = config.serviceToken;
    this.serviceId = config.serviceId;
    this.defaultTimeoutMs = config.timeoutMs;
    this.fetcher = fetcher;
    this.cacheTtlMs = readCacheTtlMs();
  }

  /**
   * TTL cache + stale-if-error 包装。
   *  - hit（未过期）→ 直接返回 cached
   *  - miss/expired → 调 doFetch，成功写入 cache + lastGood
   *  - doFetch 抛异常或返回 null/undefined → 若 lastGood 存在则返回它并 warn
   *  - cacheTtlMs === 0 → 直通
   * doFetch 语义：成功返回值（可以是空数组），失败返回 null 或抛异常。
   */
  private async _cachedFetch<T>(cacheKey: string, doFetch: () => Promise<T | null>): Promise<T | null> {
    if (this.cacheTtlMs === 0) return doFetch();

    const now = Date.now();
    const entry = this.cache.get(cacheKey) as CacheEntry<T> | undefined;
    if (entry && entry.expiresAt > now) {
      return entry.value;
    }

    let fresh: T | null = null;
    let fetchErr: unknown = null;
    try {
      fresh = await doFetch();
    } catch (err) {
      fetchErr = err;
    }

    if (fresh !== null && fresh !== undefined) {
      this.cache.set(cacheKey, { value: fresh, expiresAt: now + this.cacheTtlMs });
      this.lastGood.set(cacheKey, fresh);
      return fresh;
    }

    const stale = this.lastGood.get(cacheKey) as T | undefined;
    if (stale !== undefined) {
      const reason = fetchErr instanceof Error ? fetchErr.message : "empty result";
      console.warn(`${TAG} stale-if-error for ${cacheKey} (reason: ${reason})`);
      return stale;
    }

    if (fetchErr) throw fetchErr;
    return null;
  }

  /**
   * List all knowledge resources for a team.
   * Returns empty array on error (graceful degradation).
   *
   * @param opts.serviceId Per-call override for `x-tdai-service-id`. Falls back
   *   to config.serviceId. Callers with a per-request spaceId (e.g. injectors
   *   reading `sessionInfo.space_id`) MUST pass it — kernel routes tenants by
   *   this header, and the config value is only correct for standalone mode.
   */
  async listKnowledge(teamId: string, opts: { serviceId?: string } = {}): Promise<KnowledgeItem[]> {
    if (!teamId) return [];

    const effectiveServiceId = opts.serviceId || this.serviceId;
    const cacheKey = `list:${teamId}:${effectiveServiceId}`;

    const result = await this._cachedFetch<KnowledgeItem[]>(cacheKey, () =>
      this._doListKnowledge(teamId, effectiveServiceId),
    );
    return result ?? [];
  }

  /** actual HTTP call, no caching. Returns null on any failure (feeds _cachedFetch stale logic). */
  private async _doListKnowledge(teamId: string, serviceId: string): Promise<KnowledgeItem[] | null> {
    const url = `${this.endpoint}/v3/knowledge/list`;
    const timeout = this.defaultTimeoutMs;

    const headers: Record<string, string> = {
      "Authorization": `Bearer ${this.serviceToken}`,
      "x-tdai-service-id": serviceId,
      "Content-Type": "application/json",
    };

    let resp: Response;
    try {
      resp = await this.fetcher(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ team_id: teamId, pagination: { limit: 200 } }),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      console.warn(`${TAG} listKnowledge fetch failed: ${(err as Error).message}`);
      return null;
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.warn(`${TAG} listKnowledge HTTP ${resp.status}: ${text.slice(0, 200)}`);
      return null;
    }

    let env: CoreEnvelope<CoreKnowledgeListResult>;
    try {
      env = (await resp.json()) as CoreEnvelope<CoreKnowledgeListResult>;
    } catch (err) {
      console.warn(`${TAG} listKnowledge non-JSON response: ${(err as Error).message}`);
      return null;
    }

    if (env.code !== 0) {
      console.warn(`${TAG} listKnowledge envelope error ${env.code}: ${env.message ?? ""}`);
      return null;
    }

    return env.data?.items ?? [];
  }

  /**
   * 按 knowledge_id 批量联查明细（Proxy per-agent 路径）。
   * 服务鉴权（bearer + service-id），无需 user-key。空 ids → []。
   *
   * @param opts.serviceId Per-call override；带 spaceId 的调用方必须传。
   */
  async listKnowledgeByIds(
    teamId: string,
    ids: string[],
    opts: { serviceId?: string } = {},
  ): Promise<KnowledgeItem[]> {
    if (!teamId || ids.length === 0) return [];

    const effectiveServiceId = opts.serviceId || this.serviceId;
    const sortedIds = [...ids].sort().join(",");
    const cacheKey = `listByIds:${teamId}:${sortedIds}:${effectiveServiceId}`;

    const result = await this._cachedFetch<KnowledgeItem[]>(cacheKey, async () => {
      const env = await this._post<CoreKnowledgeListResult>(
        `${this.endpoint}/v3/knowledge/list`,
        { team_id: teamId, knowledge_ids: ids },
        {},
        opts.serviceId,
      );
      // env=null 表示 HTTP/decode 失败 → 传播 null 让 _cachedFetch 走 stale 逻辑；
      // env.data.items 为 [] 是"合法空结果"（正常缓存）。
      if (!env) return null;
      return env.data?.items ?? [];
    });
    return result ?? [];
  }

  /**
   * 取某 agent 被绑定的 knowledge asset_id（= knowledge_id）集合。
   * 走内核 meta `/v3/meta/agent-fixed-asset/list-with-detail`（ForCaller，需 user-key）。
   * 过滤 asset_type ∈ {llm_wiki, code_graph}。失败/无 user-key → []。
   *
   * @param opts.serviceId Per-call override；带 spaceId 的调用方必须传。
   */
  async listAgentKnowledgeIds(
    agentId: string,
    userKey: string,
    opts: { serviceId?: string } = {},
  ): Promise<string[]> {
    if (!agentId || !userKey) return [];

    const effectiveServiceId = opts.serviceId || this.serviceId;
    // userKey 不入 key —— 同 agent 的 fixed-asset 绑定是 agent 级视图。
    const cacheKey = `listAgentIds:${agentId}:${effectiveServiceId}`;

    const result = await this._cachedFetch<string[]>(cacheKey, async () => {
      const env = await this._post<{ items?: Array<{ asset_id: string; asset_type: string; status?: string }> }>(
        `${this.endpoint}/v3/meta/agent-fixed-asset/list-with-detail`,
        // asset_types 服务端过滤 —— 无关类型（skill / chat_memory）不再占分页额度，
        // 避免 wiki/code_graph 被 skill 挤出默认 limit=20 后拿不到。
        // 依赖 core commit da04d194 (feat/meta asset_types filter)。
        { agent_id: agentId, apply_visibility_filter: true, touch_usage: false, asset_types: ["llm_wiki", "code_graph"] },
        { "x-tdai-user-key": userKey },
        opts.serviceId,
      );
      if (!env) return null;
      const items = env.data?.items ?? [];
      return items
        .filter((it) => it.status !== "archived" && it.status !== "deprecated" && it.status !== "failed")
        .map((it) => it.asset_id);
    });
    return result ?? [];
  }

  private async _post<T>(
    url: string,
    body: unknown,
    extraHeaders: Record<string, string>,
    serviceIdOverride?: string,
  ): Promise<CoreEnvelope<T> | null> {
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${this.serviceToken}`,
      "x-tdai-service-id": serviceIdOverride || this.serviceId,
      "Content-Type": "application/json",
      ...extraHeaders,
    };
    let resp: Response;
    try {
      resp = await this.fetcher(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.defaultTimeoutMs),
      });
    } catch (err) {
      console.warn(`${TAG} POST ${url} fetch failed: ${(err as Error).message}`);
      return null;
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.warn(`${TAG} POST ${url} HTTP ${resp.status}: ${text.slice(0, 200)}`);
      return null;
    }
    try {
      const env = (await resp.json()) as CoreEnvelope<T>;
      if (env.code !== 0) {
        console.warn(`${TAG} POST ${url} envelope error ${env.code}: ${env.message ?? ""}`);
        return null;
      }
      return env;
    } catch (err) {
      console.warn(`${TAG} POST ${url} non-JSON: ${(err as Error).message}`);
      return null;
    }
  }
}

// ── Singleton + test injection ──────────────────────────────────────────────

let _client: CoreKnowledgeClient | null = null;
let _clientKey = "";
let _forced = false;

function configKey(c: Pick<CoreSkillConfig, "endpoint" | "serviceToken" | "serviceId" | "timeoutMs">): string {
  return `${c.endpoint}::${c.serviceToken}::${c.serviceId}::${c.timeoutMs}`;
}

export function getCoreKnowledgeClient(config: Pick<CoreSkillConfig, "endpoint" | "serviceToken" | "serviceId" | "timeoutMs">): CoreKnowledgeClient {
  if (_forced && _client) return _client;
  const key = configKey(config);
  if (!_client || _clientKey !== key) {
    _client = new CoreKnowledgeClient(config);
    _clientKey = key;
  }
  return _client;
}

/** Test hook — pass null to clear. Sticky until cleared. */
export function setCoreKnowledgeClient(client: CoreKnowledgeClient | null): void {
  _client = client;
  _clientKey = "";
  _forced = client !== null;
}

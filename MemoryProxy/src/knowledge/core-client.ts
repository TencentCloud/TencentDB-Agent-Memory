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

  constructor(
    config: Pick<CoreSkillConfig, "endpoint" | "serviceToken" | "serviceId" | "timeoutMs">,
    fetcher: Fetcher = globalThis.fetch.bind(globalThis),
  ) {
    this.endpoint = config.endpoint.replace(/\/$/, "");
    this.serviceToken = config.serviceToken;
    this.serviceId = config.serviceId;
    this.defaultTimeoutMs = config.timeoutMs;
    this.fetcher = fetcher;
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

    const url = `${this.endpoint}/v3/knowledge/list`;
    const timeout = this.defaultTimeoutMs;

    const headers: Record<string, string> = {
      "Authorization": `Bearer ${this.serviceToken}`,
      "x-tdai-service-id": opts.serviceId || this.serviceId,
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
      return [];
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.warn(`${TAG} listKnowledge HTTP ${resp.status}: ${text.slice(0, 200)}`);
      return [];
    }

    let env: CoreEnvelope<CoreKnowledgeListResult>;
    try {
      env = (await resp.json()) as CoreEnvelope<CoreKnowledgeListResult>;
    } catch (err) {
      console.warn(`${TAG} listKnowledge non-JSON response: ${(err as Error).message}`);
      return [];
    }

    if (env.code !== 0) {
      console.warn(`${TAG} listKnowledge envelope error ${env.code}: ${env.message ?? ""}`);
      return [];
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
    const env = await this._post<CoreKnowledgeListResult>(
      `${this.endpoint}/v3/knowledge/list`,
      { team_id: teamId, knowledge_ids: ids },
      {},
      opts.serviceId,
    );
    return env?.data?.items ?? [];
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
    const env = await this._post<{ items?: Array<{ asset_id: string; asset_type: string; status?: string }> }>(
      `${this.endpoint}/v3/meta/agent-fixed-asset/list-with-detail`,
      { agent_id: agentId, apply_visibility_filter: true, touch_usage: false },
      { "x-tdai-user-key": userKey },
      opts.serviceId,
    );
    const items = env?.data?.items ?? [];
    return items
      .filter((it) => it.asset_type === "llm_wiki" || it.asset_type === "code_graph")
      .filter((it) => it.status !== "archived" && it.status !== "deprecated" && it.status !== "failed")
      .map((it) => it.asset_id);
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

/**
 * CoreSkillClient — minimal HTTP client for the openclaw-plugin skill gateway.
 *
 * Scope: only the endpoints the proxy itself calls.
 *   - POST /v3/skill/search              → SkillInjector RAG 检索.
 *   - POST /v3/skill/listing             → SkillInjector owner-agent listing.
 *   - POST /v3/skill/conversation/add    → handler-glue 新链路, 每轮真人对话结束推送.
 *   - POST /v3/skill/extract 等其他方法保留在类里, 供 agent 通过 skill-bridge
 *     反代时透传使用 (agent 通过 curl 直接命中, 不由 proxy 主动触发)。
 *
 * The other /v3/skill/* endpoints are NOT wrapped here on purpose — the LLM
 * curls them directly via the /skill-bridge reverse proxy, so wrapping them
 * would just be dead code. See `docs/design/2026-06-17-team-skill-proxy-runtime.md`.
 *
 * Auth: `Authorization: Bearer <serviceToken>` + `x-tdai-service-id`.
 * Error model: throws plain `Error` on !ok or non-zero envelope code; callers
 * (injectors / trigger) wrap in try/catch and degrade silently.
 *
 * Test injection: pass a custom `fetcher` to the constructor.
 *
 * Singleton: `getCoreSkillClient(config)` keys on (endpoint, serviceToken,
 *   serviceId, timeoutMs); changing any field rebuilds. Test override via
 *   `setCoreSkillClient(...)`.
 */

import type { CoreSkillConfig } from "../types.js";

type Fetcher = typeof fetch;

const TAG = "[core-skill-client]";

/**
 * 身份字段。
 *
 * 重要：`user_id` 是 **可选** 的——skill 表上的 `user_id` 列只是 audit
 * （"上一次写入的 caller 是谁"），而非 ownership。skill 的归属维度由 schema
 * 的唯一索引 `(team_id, owner_agent_id, name)` 决定，与 user_id 无关。
 *
 * 因此 read 路径（search / list）**不应该** 传 user_id 过滤，否则会把所有
 * "非当前 caller 写入"的 skill 全部毙掉（包括同 team / 同 agent 共享的 skill）。
 * write 路径（extract / save / update）才需要 user_id 用于审计。
 *
 * Plugin 端 store 已经是 "传啥过滤啥" 的语义（`if (opts.user_id) WHERE user_id=?`），
 * 这里把字段改成可选即可让 read 路径自然跳过该过滤。
 */
export interface IdFields {
  /** 可选 — 仅 audit 用。read 路径不要传，否则会过滤掉团队共享 skill。 */
  user_id?: string;
  team_id: string;
  agent_id?: string;
  task_id?: string;
}

export interface SkillSummary {
  skill_id: string;
  name: string;
  description: string;
  version: number;
  is_head?: boolean;
  status?: "active" | "archived";
  owner_user_id?: string;
  owner_agent_id?: string;
  team_id?: string;
  task_id?: string;
  created_at_ms?: number;
  updated_at_ms?: number;
}

export interface SearchHit extends SkillSummary {
  score: number;
  snippet?: string;
}

export interface SearchSkillsInput extends IdFields {
  query: string;
  top_k?: number;                        // 1..50, default 10
  mode?: "bm25" | "embedding" | "hybrid"; // default 'hybrid'
}

export interface SearchSkillsResult {
  items: SearchHit[];
}

export interface ExtractMessage {
  role: "user" | "assistant" | "tool_call" | "tool_result";
  content: string;
  timestamp?: string;                    // ISO 8601
}

/**
 * `/v3/skill/conversation/add` 请求体里单条消息形状。
 *
 * 相较于 `ExtractMessage`：
 *   - 允许 `system` role（跟设计 §11.1 的 5 种 role 对齐）
 *   - `tool_call` / `tool_result` 必须携带 `tool_name` + `tool_call_id`
 *   - `timestamp` 可以是数字（ms epoch）或 ISO 8601 字符串
 */
export interface ConversationTurnMessage {
  role: "user" | "assistant" | "tool_call" | "tool_result" | "system";
  content: string;
  tool_name?: string;
  tool_call_id?: string;
  timestamp?: number | string;
}

export interface ExtractSkillInput extends IdFields {
  session_id?: string;
  messages: ExtractMessage[];
  mode?: "sync" | "async";               // default 'async'
  options?: {
    max_iterations?: number;
    dedupe?: boolean;
    review_kind?: "skill_only" | "memory_only" | "combined";
  };
}

export interface ExtractAsyncResult {
  task_id: string;
}

/**
 * `/v3/skill/conversation/add` 输入。
 *
 * 强约束：
 *   - session_id / space_id / user_id / team_id / agent_id 全部必填
 *   - ID 字段不能包含 `|`（Core 拒绝，返回 400）
 *   - messages 是本轮增量（user + 中间 tool_call/tool_result + assistant 总结），
 *     不重传历史（Core 不去重，重传会造成 buffer 重复）
 *   - 同 session 必须严格串行（一轮 200 之后才发下一轮）
 *
 * 详见 `2026-07-15-skill-trigger-in-core-design.md` §11.1 & §13。
 */
export interface ConversationAddInput extends IdFields {
  session_id: string;
  space_id?: string;
  messages: ConversationTurnMessage[];
}

/**
 * 归档触发时的元数据；`status: "ok"` 时不带此字段。
 */
export interface ConversationAddArchived {
  task_id: string;
  archived_at_ms: number;
  archive_key: string;
  reason: "tool_calls" | "bytes" | "compressed" | "oversize";
}

export interface ConversationAddResult {
  status: "ok" | "archived";
  archived?: ConversationAddArchived;
}

/** Input for /v3/skill/conversation/force-archive — 手动强制归档。 */
export interface ForceArchiveInput {
  space_id: string;
  user_id: string;
  team_id: string;
  agent_id: string;
  session_id: string;
  reason?: string;
  task_id?: string;
}

/** Response from /v3/skill/conversation/force-archive. */
export interface ForceArchiveResponse {
  status: "archived" | "empty";
  task_id?: string;
  archived_at_ms?: number;
  archive_key?: string;
  message?: string;
}

/**
 * Input for /v3/skill/list — owner-agent skill enumeration.
 *
 * Used by skill-bridge team-search to build the "agent 自有全量" 部分的
 * whitelist（见 `docs/design/2026-08-10-skill-search-scope-fix.md` §4）。
 * limit 走 core schema 上限 1000，一次拿完，不分页。
 */
export interface ListSkillsInput extends IdFields {
  filters?: {
    owner_agent_id?: string;
    name_prefix?: string;
    status?: Array<"active" | "archived">;
  };
  pagination?: { limit?: number; offset?: number };
}

/** Result from /v3/skill/list. */
export interface ListSkillsResult {
  items: SkillSummary[];
  total: number;
}

/** Input for /v3/skill/listing — owner-agent skill injection. */
export interface ListingInput extends IdFields {
  /** Optional search query; when set, plugin uses FTS BM25 to match relevant skills. */
  query?: string;
  /** char budget for the rendered listing block. Default 8000 in plugin. */
  char_budget?: number;
}

/** Result from /v3/skill/listing. `listing` is the pre-rendered `<available_skills>` block. */
export interface ListingResult {
  mode: "full" | "search";
  listing: string;
  hits: Array<{ skill_id: string; version: number; name: string }>;
}

/** Core gateway envelope (mirrors `tdai-memory-plugin/src/gateway/v2-router.ts:145-150`). */
interface CoreEnvelope<T> {
  code: number;
  message?: string;
  request_id?: string;
  data?: T;
  error?: { code: number; message: string };
}

export interface CoreSkillRequestOptions {
  /** Per-call override; falls back to config.timeoutMs. */
  timeoutMs?: number;
  /**
   * Per-call override for `x-tdai-service-id`. Falls back to config.serviceId.
   *
   * Used by callers that know the real tenant/instance ID for this request
   * (e.g. SkillInjector reads it from `sessionInfo.space_id`, which was
   * extracted from the request URL path `/{agent}/{spaceId}/...`).
   *
   * Kernel routes tenants by this header — a static config value is wrong
   * whenever the caller has a per-request spaceId available.
   */
  serviceId?: string;
}

export class CoreSkillClient {
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

  async searchSkills(
    input: SearchSkillsInput,
    opts: CoreSkillRequestOptions = {},
  ): Promise<SearchSkillsResult> {
    return this.post<SearchSkillsResult>("/v3/skill/search", input, opts);
  }

  async extractSkill(
    input: ExtractSkillInput,
    opts: CoreSkillRequestOptions = {},
  ): Promise<ExtractAsyncResult | { cached: boolean; cache_key: string; candidates: unknown[] }> {
    return this.post("/v3/skill/extract", input, opts);
  }

  /**
   * `POST /v3/skill/conversation/add` — 新链路：每轮增量推送到 core，
   * core 内部决定归档 + 抽取时机。见 §21.2。
   *
   * **同步等待**：本方法内部 `await` fetch → envelope 解析。调用方必须
   * 也 `await` 本方法，保证同 session 严格串行（Core 侧的核心前提）。
   */
  async addConversation(
    input: ConversationAddInput,
    opts: CoreSkillRequestOptions = {},
  ): Promise<ConversationAddResult> {
    return this.post<ConversationAddResult>("/v3/skill/conversation/add", input, opts);
  }

  /**
   * `POST /v3/skill/conversation/force-archive` — 手动强制归档当前 session buffer。
   * 跳过阈值判断，直接调 trigger.archive()。
   */
  async forceArchive(
    input: ForceArchiveInput,
    opts: CoreSkillRequestOptions = {},
  ): Promise<ForceArchiveResponse> {
    return this.post<ForceArchiveResponse>("/v3/skill/conversation/force-archive", input, opts);
  }

  /**
   * `POST /v3/skill/list` — 枚举 agent 自有 skill 的 skill_id / 元数据。
   *
   * skill-bridge team-search 用来扩大 whitelist：把 agent 自己（含 private）
   * 的 skill 也纳入检索池，避免 session-init `<available_skills>` 20 条上限
   * 之外的私有 skill 永远搜不到。见
   * `docs/design/2026-08-10-skill-search-scope-fix.md`。
   *
   * 语义：默认只返回 head + active。owner 归属由 (team_id, agent_id) 决定。
   */
  async listSkills(
    input: ListSkillsInput,
    opts: CoreSkillRequestOptions = {},
  ): Promise<ListSkillsResult> {
    return this.post<ListSkillsResult>("/v3/skill/list", input, opts);
  }

  /**
   * Call /v3/skill/listing to get the agent's owned skills.
   * Without a query, the plugin routes to list-head (full listing when ≤ topK,
   * search when > topK). The response includes a pre-rendered `<available_skills>`
   * block that can be injected verbatim into the system prompt.
   */
  async listListing(
    input: ListingInput,
    opts: CoreSkillRequestOptions = {},
  ): Promise<ListingResult> {
    return this.post<ListingResult>("/v3/skill/listing", input, opts);
  }

  /**
   * plugin 端 Zod schema 要求 team_id 和 agent_id 互绑：
   * 要么都传（有值），要么都不传（undefined/空）。
   * 如果 agent_id 为空但 team_id 有值，触发 "must both be provided or both be omitted"。
   *
   * 修复策略：当 team_id 有值而 agent_id 为空时，填充 "default" 作为 agent_id。
   * plugin core 层本身也会对 undefined agent_id fallback 到 "default"（见 skill-core.ts）。
   */
  private normalizeTeamAgent(body: Record<string, unknown>): void {
    const teamId = body.team_id;
    const agentId = body.agent_id;
    if (teamId && (agentId === undefined || agentId === '')) {
      body.agent_id = 'default';
    }
    // 如果两个都为空，清理 key（不带到 plugin 端）
    if (!body.team_id && !body.agent_id) {
      delete body.team_id;
      delete body.agent_id;
    }
  }

  /** Generic POST → unwraps the envelope. Public for tests / future endpoints. */
  async post<T>(
    path: string,
    body: unknown,
    opts: CoreSkillRequestOptions = {},
  ): Promise<T> {
    // 浅拷贝 body，避免 normalizeTeamAgent 副作用污染调用者传入的对象。
    // 原先直接修改 body 会导致调用方的输入对象被意外改写（例如 agent_id
    // 被填入 "default"），引发跨调用或重试时的数据错乱。
    let normalizedBody: unknown = body;
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      normalizedBody = { ...(body as Record<string, unknown>) };
      this.normalizeTeamAgent(normalizedBody as Record<string, unknown>);
    }
    const url = `${this.endpoint}${path.startsWith("/") ? path : "/" + path}`;
    const timeout = opts.timeoutMs ?? this.defaultTimeoutMs;

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
        body: JSON.stringify(normalizedBody),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      throw new Error(`${TAG} ${path} fetch failed: ${(err as Error).message}`);
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`${TAG} ${path} HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }

    let env: CoreEnvelope<T>;
    try {
      env = (await resp.json()) as CoreEnvelope<T>;
    } catch (err) {
      throw new Error(`${TAG} ${path} non-JSON response: ${(err as Error).message}`);
    }

    if (env.code !== 0) {
      const msg = env.error?.message ?? env.message ?? `code=${env.code}`;
      throw new Error(`${TAG} ${path} envelope error ${env.code}: ${msg}`);
    }

    return (env.data ?? ({} as T));
  }
}

// ── Singleton + test injection ──────────────────────────────────────────────

let _client: CoreSkillClient | null = null;
let _clientKey = "";
let _forced = false;

function configKey(c: CoreSkillConfig): string {
  return `${c.endpoint}::${c.serviceToken}::${c.serviceId}::${c.timeoutMs}`;
}

export function getCoreSkillClient(config: CoreSkillConfig): CoreSkillClient {
  if (_forced && _client) return _client;
  const key = configKey(config);
  if (!_client || _clientKey !== key) {
    _client = new CoreSkillClient(config);
    _clientKey = key;
  }
  return _client;
}

/** Test hook — pass null to clear. Sticky until cleared. */
export function setCoreSkillClient(client: CoreSkillClient | null): void {
  _client = client;
  _clientKey = "";
  _forced = client !== null;
}

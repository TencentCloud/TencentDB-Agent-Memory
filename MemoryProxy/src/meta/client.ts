/**
 * MetadataClient — lightweight HTTP client for kernel /v3/meta/* APIs.
 *
 * Replaces ProxyControlClient's 6 TMC calls. Reuses CoreSkillConfig
 * (endpoint/serviceToken/serviceId) — same kernel gateway as skill/knowledge clients.
 *
 * Auth headers:
 *   Authorization: Bearer <serviceToken>
 *   x-tdai-service-id: <serviceId>
 *   x-tdai-user-key: <userKey>  (omit when empty)
 *
 * Error model:
 *   - HTTP non-200 → throws generic Error with status code
 *   - Non-zero envelope code → throws Error with code
 *   - 404 on get* → throws NotFoundError (has .notFound = true)
 *
 * Pagination: all list* methods transparently aggregate across pages up to
 * PAGINATION_HARD_LIMIT (500). Exceeding that logs a warning and truncates.
 */

import type { CoreSkillConfig } from "../types.js";

type Fetcher = typeof fetch;

const TAG = "[metadata-client]";
export const PAGINATION_HARD_LIMIT = 500;
const LIST_PAGE_SIZE = 100;
const FA_PAGE_SIZE = 100;

// ── Core envelope shape ──────────────────────────────────────────────────────

interface CoreEnvelope<T> {
  code: number;
  message?: string;
  data?: T | null;
}

interface PaginatedResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

interface FixedAssetDetailResult {
  agent: Record<string, unknown>;
  items: Record<string, unknown>[];
  total: number;
  limit: number;
  offset: number;
}

// ── Entity types (subset of kernel entities we consume) ──────────────────────

export interface TeamEntity {
  team_id: string;
  name: string;
  description?: string | null;
  owner_user_id?: string;
  status?: string;
}

export interface AgentEntity {
  agent_id: string;
  team_id: string;
  owner_user_id?: string;
  name: string;
  description?: string | null;
  prompt?: string | null;
  visibility?: string;
  status?: string;
}

export interface TaskEntity {
  task_id: string;
  team_id: string;
  creator_user_id?: string;
  title: string;
  description?: string | null;
  status?: string;
  source_type?: string;
}

/**
 * /v3/meta/task/create 请求入参。
 *
 * 权限约束（内核）：caller 必须是 team 活跃成员，且 creator_user_id 强制 == caller。
 * mem:create-task 命令层已经保证 creator_user_id = sessionInfo.user_id，不允许伪造。
 */
export interface CreateTaskInput {
  team_id: string;
  creator_user_id: string;
  title: string;
  description?: string;
  status?: string;
  source_type?: string;
  /** 可选：由调用方指定 task_id；缺省时内核自动生成。mem 命令族不传，交给内核生成。 */
  task_id?: string;
  /**
   * 可选：关联的 Agent。TAPD 需求：mem:create-task 需要"关联当前 Agent"。
   * 内核会把它写进 task 的 agent_ids 或元数据字段（具体行为由内核决定，proxy 只透传）。
   */
  agent_id?: string;
}

/**
 * /v3/meta/task/update 请求入参。
 *
 * 权限约束（内核）：caller 必须 == task.creator_user_id。
 * mem:update-task 命令层在调用本 API 前会先做 owner-check，非 creator 时直接返错，
 * 不会走到这里（见需求 Q4 决策 B —— 不越权改核心权限模型）。
 */
export interface UpdateTaskPatch {
  /** 标题按需求约定不允许更新，此处仅描述 / 状态可改。 */
  description?: string;
  status?: string;
}

export interface FixedAssetItem {
  asset_id: string;
  asset_type: string;
  name?: string;
  description?: string | null;
  status?: string;
  visibility?: string;
  injection_mode?: string;
  priority?: number;
  created_at?: string;
}

export interface AgentFixedAssetDetail {
  agent: Record<string, unknown>;
  items: FixedAssetItem[];
  total: number;
}

// ── Participation log ────────────────────────────────────────────────────────
//
// One append per session-init 完成 —— 记录 (team, task, agent, user) 四元组的
// 参与事件。语义与 `task-agent/link`（声明关系）不同：这里是"实际发生了一次
// session"的追加日志，前端看板据此展示"参与 User / Agent"。见 v3.2 §34/35。

export interface ParticipationLogEntity {
  id?: string;
  team_id: string;
  task_id: string;
  agent_id: string;
  user_id: string;
  source?: string;
  metadata_json?: string;
  created_at?: string;
}

export interface AppendParticipationLogInput {
  team_id: string;
  task_id: string;
  agent_id: string;
  user_id: string;
  /** 来源标识，例：`context_proxy:claude-code`。省略则内核默认 `unknown`。 */
  source?: string;
  metadata_json?: string;
  /** ISO8601 UTC；省略则用服务端当前时间。 */
  created_at?: string;
}

export interface ListParticipationLogsInput {
  team_id: string;
  task_id?: string;
  agent_id?: string;
  user_id?: string;
  created_after?: string;
  created_before?: string;
  /** 是否按 user_id 去重（内核默认 false）。仅 user 维度生效，agent 需前端自行 dedupe。 */
  dedupe?: boolean;
}

/**
 * One item returned by /v3/meta/asset/list-accessible.
 *
 * `asset_id` is the external asset id. For skill assets, the convention is
 * asset_id === skill_id (see team-memory-control panel note).
 * Kernel-side ACL/visibility filtering has already been applied.
 */
export interface AccessibleAssetItem {
  asset_id: string;
  team_id: string;
  asset_type: string;
  name?: string;
  description?: string | null;
  owner_user_id?: string;
  visibility?: string;
  status?: string;
  version?: number;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface ListAccessibleAssetsInput {
  user_id: string;
  team_id: string;
  asset_type?: string;
  /** Default 'read' when omitted. */
  action?: "read" | "write" | "use";
  /**
   * Server-side visibility whitelist. Aligns with the frontend team-asset tab
   * (only surface visibility='team' skills — protects owners' private ones).
   */
  visibility?: string;
  agent_id?: string;
}

// ── NotFoundError ────────────────────────────────────────────────────────────

export class NotFoundError extends Error {
  readonly notFound = true;
  constructor(public readonly resourceType: string, public readonly resourceId: string) {
    super(`${resourceType} not found: ${resourceId}`);
    this.name = "NotFoundError";
  }
}

// ── Client ───────────────────────────────────────────────────────────────────

export class MetadataClient {
  private readonly endpoint: string;
  private readonly serviceToken: string;
  private readonly serviceId: string;
  private readonly defaultTimeoutMs: number;
  private readonly fetcher: Fetcher;

  /**
   * @param serviceId - Instance/tenant ID (e.g. "mem-example001"). Comes from the
   *   caller's request path `/proxy/<spaceId>/...` and is used as the kernel's
   *   `x-tdai-service-id` header for DB routing. MUST be a real instance ID,
   *   not a static value like "context-proxy" (kernel rejects unknown instances
   *   with `invalid_user_key`).
   */
  constructor(
    config: Pick<CoreSkillConfig, "endpoint" | "serviceToken" | "timeoutMs">,
    serviceId: string,
    private readonly userKey: string,
    fetcher: Fetcher = globalThis.fetch.bind(globalThis),
  ) {
    this.endpoint = config.endpoint.replace(/\/$/, "");
    this.serviceToken = config.serviceToken;
    this.serviceId = serviceId;
    this.defaultTimeoutMs = config.timeoutMs;
    this.fetcher = fetcher;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** List all teams for a user (paginated aggregation). */
  async listTeams(userId: string): Promise<TeamEntity[]> {
    return this.fetchAll<TeamEntity>(
      "/v3/meta/team/list",
      { user_id: userId },
      LIST_PAGE_SIZE,
    );
  }

  /**
   * List agents for a team, optionally scoped to a specific owner.
   *
   * When `ownerUserId` is a non-empty string, kernel returns only the agents
   * owned by that user within the team (per `agentListSchema` — kernel
   * intersects `team_id` and `owner_user_id` when both are provided). This is
   * used by session-init to show each user only their own agents.
   *
   * @param teamId       Team scope (required).
   * @param ownerUserId  Optional owner filter. Empty string / undefined → team-wide list.
   */
  async listAgents(teamId: string, ownerUserId?: string): Promise<AgentEntity[]> {
    const body: Record<string, unknown> = { team_id: teamId, status: "active" };
    if (ownerUserId) body.owner_user_id = ownerUserId;
    return this.fetchAll<AgentEntity>(
      "/v3/meta/agent/list",
      body,
      LIST_PAGE_SIZE,
    );
  }

  /** List all tasks for a team (paginated aggregation). */
  async listTasks(teamId: string): Promise<TaskEntity[]> {
    return this.fetchAll<TaskEntity>(
      "/v3/meta/task/list",
      { team_id: teamId, status: "running" },
      LIST_PAGE_SIZE,
    );
  }

  /** Get a single agent by ID. Throws NotFoundError on 404. */
  async getAgent(agentId: string): Promise<AgentEntity> {
    return this.getOne<AgentEntity>("/v3/meta/agent/get", { agent_id: agentId }, "agent");
  }

  /** Get a single task by ID. Throws NotFoundError on 404. */
  async getTask(taskId: string): Promise<TaskEntity> {
    return this.getOne<TaskEntity>("/v3/meta/task/get", { task_id: taskId }, "task");
  }

  /**
   * Create a new task under a team.
   *
   * mem:create-task 命令族入口。约束见 `CreateTaskInput` 注释：
   *   - creator_user_id 必须 == 当前 caller
   *   - team_id 必须是 caller 的活跃 team
   * 内核 envelope 直接返回落盘后的 TaskEntity（含生成的 task_id）。
   */
  async createTask(input: CreateTaskInput): Promise<TaskEntity> {
    const body: Record<string, unknown> = {
      team_id: input.team_id,
      creator_user_id: input.creator_user_id,
      title: input.title,
    };
    if (input.description !== undefined) body.description = input.description;
    if (input.status !== undefined) body.status = input.status;
    if (input.source_type !== undefined) body.source_type = input.source_type;
    if (input.task_id !== undefined) body.task_id = input.task_id;
    if (input.agent_id !== undefined) body.agent_id = input.agent_id;
    return this.fetch<TaskEntity>("/v3/meta/task/create", body);
  }

  /**
   * Patch an existing task's description / status. Title is immutable per 产品需求。
   *
   * 调用方需先做 owner-check（caller == creator）；本方法不做二次校验，
   * 内核会以 401/403 拒绝非 creator。
   */
  async updateTask(taskId: string, patch: UpdateTaskPatch): Promise<TaskEntity> {
    const body: Record<string, unknown> = { task_id: taskId };
    if (patch.description !== undefined) body.description = patch.description;
    if (patch.status !== undefined) body.status = patch.status;
    return this.fetch<TaskEntity>("/v3/meta/task/update", body);
  }

  /**
   * List assets the given user can access in a team, applying kernel-side
   * visibility × ACL filtering (see permission-checker.ts). Paginated aggregation.
   *
   * Mirrors the frontend team-asset tab call
   * (team-memory-control/web/src/lib/teamApi.ts assetsApi.listAccessible), so
   * proxy and panel see the same set for any given (user, team, visibility).
   *
   * Used by skill-bridge team-wide search: pass `visibility: 'team'` to obtain
   * the visible skill_id whitelist, then hand the ids to /v3/skill/search so
   * private skills owned by other users stay invisible.
   */
  async listAccessibleAssets(
    input: ListAccessibleAssetsInput,
  ): Promise<AccessibleAssetItem[]> {
    return this.fetchAll<AccessibleAssetItem>(
      "/v3/meta/asset/list-accessible",
      {
        user_id: input.user_id,
        team_id: input.team_id,
        asset_type: input.asset_type,
        // Default matches the kernel doc (§listAccessibleAssets) — 'read' when omitted.
        // Send explicitly so proxy behavior is deterministic and independent of
        // kernel defaults drifting.
        action: input.action ?? "read",
        visibility: input.visibility,
        agent_id: input.agent_id,
      },
      LIST_PAGE_SIZE,
    );
  }

  /**
   * Append a participation event for (team, task, agent, user).
   *
   * Called fire-and-forget from session-init completion —— 失败不阻断注入路径。
   * 内核为 append-only，同一四元组重复调用会累积多条；前端展示时按 user_id
   * 走 `listParticipationLogs({dedupe:true})`，agent 维度靠客户端 dedupe。
   */
  async appendParticipationLog(
    input: AppendParticipationLogInput,
  ): Promise<ParticipationLogEntity> {
    const body: Record<string, unknown> = {
      team_id: input.team_id,
      task_id: input.task_id,
      agent_id: input.agent_id,
      user_id: input.user_id,
    };
    if (input.source !== undefined) body.source = input.source;
    if (input.metadata_json !== undefined) body.metadata_json = input.metadata_json;
    if (input.created_at !== undefined) body.created_at = input.created_at;
    return this.fetch<ParticipationLogEntity>(
      "/v3/meta/participation-log/append",
      body,
    );
  }

  /**
   * List participation logs, paginated aggregation. `dedupe:true` only
   * de-duplicates by `user_id` (kernel doc §35) —— 需要按 agent_id 去重时，
   * 请在调用侧再走一遍 client-side dedupe。
   */
  async listParticipationLogs(
    input: ListParticipationLogsInput,
  ): Promise<ParticipationLogEntity[]> {
    const body: Record<string, unknown> = { team_id: input.team_id };
    if (input.task_id !== undefined) body.task_id = input.task_id;
    if (input.agent_id !== undefined) body.agent_id = input.agent_id;
    if (input.user_id !== undefined) body.user_id = input.user_id;
    if (input.created_after !== undefined) body.created_after = input.created_after;
    if (input.created_before !== undefined) body.created_before = input.created_before;
    if (input.dedupe !== undefined) body.dedupe = input.dedupe;
    return this.fetchAll<ParticipationLogEntity>(
      "/v3/meta/participation-log/list",
      body,
      LIST_PAGE_SIZE,
    );
  }

  /**
   * Get agent fixed assets with detail (paginated aggregation).
   *
   * `applyVisibilityFilter=true`（默认）：让内核基于 canBindAsset 过滤掉
   * agent 无法访问的绑定 —— 典型场景：其它成员把资产切成 private 后，
   * 老的 fixed-asset 表里还残留绑定行，但 caller 已经不能使用；带 filter
   * 后 injection / memory-bridge 只会拿到当前仍然可用的绑定。
   *
   * 传 false 只用于需要看到"物理绑定"的场景（e.g. 管理面板 debug）。
   */
  async getAgentFixedAssets(
    agentId: string,
    opts: { applyVisibilityFilter?: boolean } = {},
  ): Promise<AgentFixedAssetDetail> {
    const applyVisibilityFilter = opts.applyVisibilityFilter !== false;
    const allItems: FixedAssetItem[] = [];
    let agent: Record<string, unknown> | null = null;
    let offset = 0;
    let total = 0;

    while (allItems.length < PAGINATION_HARD_LIMIT) {
      const resp = await this.fetch<FixedAssetDetailResult>(
        "/v3/meta/agent-fixed-asset/list-with-detail",
        {
          agent_id: agentId,
          limit: FA_PAGE_SIZE,
          offset,
          apply_visibility_filter: applyVisibilityFilter,
        },
      );
      agent = agent ?? resp.agent;
      total = resp.total;
      const pageItems = resp.items as unknown as FixedAssetItem[];
      allItems.push(...pageItems);
      // 停止条件（任一命中即停）：
      //   1. 累计 items 数 ≥ total（正常场景）
      //   2. 本页返 0 条（apply_visibility_filter 过滤后 items 可能全空，
      //      但内核 total 仍是过滤前的原始行数 —— 不 break 会永远翻页；
      //      2026-07-11 修：新加此条防死循环）
      //   3. 本页返 < FA_PAGE_SIZE（小于一页 → 到底）
      if (allItems.length >= total) break;
      if (pageItems.length === 0) break;
      if (pageItems.length < FA_PAGE_SIZE) break;
      offset += FA_PAGE_SIZE;
    }

    if (allItems.length >= PAGINATION_HARD_LIMIT && allItems.length < total) {
      console.warn(`${TAG} getAgentFixedAssets truncated at ${PAGINATION_HARD_LIMIT} (total=${total})`);
    }

    return { agent: agent ?? {}, items: allItems, total };
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  private async getOne<T>(
    path: string,
    body: Record<string, unknown>,
    resourceType: string,
  ): Promise<T> {
    try {
      const data = await this.fetch<T>(path, body);
      return data;
    } catch (err) {
      if (err instanceof Error && /404/.test(err.message)) {
        throw new NotFoundError(resourceType, String(body[`${resourceType}_id`] ?? ""));
      }
      throw err;
    }
  }

  /** Paginated aggregation for list endpoints. */
  private async fetchAll<T>(
    path: string,
    body: Record<string, unknown>,
    pageSize: number,
  ): Promise<T[]> {
    const allItems: T[] = [];
    let offset = 0;
    let total = 0;

    while (allItems.length < PAGINATION_HARD_LIMIT) {
      const result = await this.fetch<PaginatedResult<T>>(
        path,
        { ...body, limit: pageSize, offset },
      );
      total = result.total;
      allItems.push(...result.items);
      if (allItems.length >= total) break;
      offset += pageSize;
    }

    if (allItems.length >= PAGINATION_HARD_LIMIT && allItems.length < total) {
      console.warn(
        `${TAG} ${path} truncated at ${PAGINATION_HARD_LIMIT} (total=${total})`,
      );
    }

    return allItems;
  }

  /** Core fetch with envelope unwrapping. */
  private async fetch<T>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.endpoint}${path}`;
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${this.serviceToken}`,
      "x-tdai-service-id": this.serviceId,
      "Content-Type": "application/json",
    };
    if (this.userKey) {
      headers["x-tdai-user-key"] = this.userKey;
    }

    let resp: Response;
    try {
      resp = await this.fetcher(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.defaultTimeoutMs),
      });
    } catch (err) {
      throw new Error(`${TAG} ${path} fetch failed: ${(err as Error).message}`);
    }

    if (!resp.ok) {
      let detail = "";
      try {
        detail = await resp.text();
      } catch { /* ignore */ }
      console.log(
        `[wb-debug] metadata-client req path=${path} status=${resp.status} url=${url} serviceId=${this.serviceId} userKey.len=${this.userKey?.length ?? 0} userKey.prefix=${(this.userKey ?? "").slice(0, 20)} serviceToken.len=${this.serviceToken?.length ?? 0} body.len=${detail.length} body.head=${detail.slice(0, 300)}`,
      );
      throw new Error(`${TAG} ${path} HTTP ${resp.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }

    const env = (await resp.json()) as CoreEnvelope<T>;

    if (env.code !== 0) {
      throw new Error(`${TAG} ${path} envelope error ${env.code}: ${env.message ?? ""}`);
    }

    if (env.data === null || env.data === undefined) {
      throw new Error(`${TAG} ${path} unexpected null data`);
    }

    return env.data as T;
  }
}

// ── Singleton + test injection ──────────────────────────────────────────────

let _client: MetadataClient | null = null;
let _clientKey = "";
let _forced = false;

function clientKey(cfg: Pick<CoreSkillConfig, "endpoint" | "serviceToken" | "timeoutMs">, serviceId: string, userKey: string): string {
  return `${cfg.endpoint}::${cfg.serviceToken}::${serviceId}::${cfg.timeoutMs}::${userKey}`;
}

/**
 * @param serviceId - Real kernel instance ID (e.g. "mem-example001") extracted
 *   from the caller's request path `/proxy/<spaceId>/...`. Do NOT pass the
 *   static config value `coreSkill.serviceId` here — kernel uses this header
 *   for tenant DB routing.
 */
export function getMetadataClient(
  config: Pick<CoreSkillConfig, "endpoint" | "serviceToken" | "timeoutMs">,
  serviceId: string,
  userKey: string,
): MetadataClient {
  if (_forced && _client) return _client;
  const key = clientKey(config, serviceId, userKey);
  if (!_client || _clientKey !== key) {
    _client = new MetadataClient(config, serviceId, userKey);
    _clientKey = key;
  }
  return _client;
}

/** Test hook — pass null to clear. */
export function setMetadataClient(client: MetadataClient | null): void {
  _client = client;
  _clientKey = "";
  _forced = client !== null;
}
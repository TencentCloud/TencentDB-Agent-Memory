import type {
  TdaiAgentCtx,
  TdaiIdentity,
  TdaiL1Memory,
  TdaiL2Entry,
  TdaiL2File,
  TdaiL3Core,
  TdaiMemoryConfig,
  TdaiMessage,
} from "./types.js";
import { log } from "../report/log.js";
import { createHash } from "node:crypto";

interface TdaiEnvelope<T = unknown> {
  code?: number;
  message?: string;
  data?: T;
}

const TDAI_MESSAGE_CONTENT_MAX_CHARS = 8192;
const TDAI_CONVERSATION_MAX_MESSAGES = 100;

// ── L0 user 消息去重 ──────────────────────────────────────────────────────
// 背景：agent 客户端（DSH / Claude Code / Hermes 等）是「一个提问 → N 步工具
// 循环 → N 个 HTTP 请求」，每步都携带同一条 user 消息；而 addConversation 按
// 「每个请求」调用，于是同一条 user 消息被反复写入 L0（实测 22–309 倍），
// 下游 L1 抽取为这些重复内容重复付费。
// 语义：同一 (agent, session, task) 下，内容相同的 user 消息在 TTL 窗口内只写
// 一次；assistant 消息不受影响（保证最终回复不丢）。水位在写入成功后才记录，
// 失败重试仍会真正写入（宁重勿丢）；进程重启水位清空，最多多写一轮。
// TTL / 上限目前为常量，可按需调整。
const L0_USER_DEDUP_TTL_MS = 10 * 60 * 1000;
const L0_USER_DEDUP_MAX_ENTRIES = 4096;
const l0UserDedupSeen = new Map<string, number>();

function l0UserDedupKey(identity: TdaiIdentity, userContent: string): string {
  const hash = createHash("sha1").update(userContent).digest("hex").slice(0, 16);
  return `${identity.agentId}|${identity.sessionId}|${identity.taskId}|${hash}`;
}

/** 命中 = 该内容在 TTL 内已写过；同时顺手做过期清理。 */
function l0UserDedupHit(key: string, now: number): boolean {
  const seenAt = l0UserDedupSeen.get(key);
  if (seenAt !== undefined && now - seenAt < L0_USER_DEDUP_TTL_MS) return true;
  if (l0UserDedupSeen.size >= L0_USER_DEDUP_MAX_ENTRIES) {
    for (const [k, t] of l0UserDedupSeen) {
      if (now - t >= L0_USER_DEDUP_TTL_MS) l0UserDedupSeen.delete(k);
    }
  }
  return false;
}

/**
 * Split messages to fit the gateway schema without losing content or breaking
 * UTF-16 surrogate pairs. The gateway validates string.length, so this limit
 * intentionally uses JavaScript code units rather than UTF-8 bytes.
 */
function chunkConversationMessages(messages: TdaiMessage[]): TdaiMessage[] {
  return messages.flatMap((message) => {
    if (message.content.length <= TDAI_MESSAGE_CONTENT_MAX_CHARS) return [message];

    const chunks: TdaiMessage[] = [];
    let start = 0;
    while (start < message.content.length) {
      let end = Math.min(start + TDAI_MESSAGE_CONTENT_MAX_CHARS, message.content.length);
      if (
        end < message.content.length
        && isHighSurrogate(message.content.charCodeAt(end - 1))
        && isLowSurrogate(message.content.charCodeAt(end))
      ) {
        end -= 1;
      }
      chunks.push({ role: message.role, content: message.content.slice(start, end) });
      start = end;
    }
    return chunks;
  });
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xD800 && code <= 0xDBFF;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xDC00 && code <= 0xDFFF;
}

// ── 共享工厂 (Phase 0.4, 2026-09-28) ─────────────────────────────────────
/**
 * 建 per-request TdaiClient。原本 handler / anthropicHandler / codexHandler /
 * workbuddyHandler 各写一遍完全相同的 factory (workbuddy 版漏传 spaceId 是
 * 已知 bug, 见 handler-audit §2.2)。
 *
 * `spaceId` (来自 URL `/{agent}/{spaceId}/...`) 覆盖 config.tdai.serviceId,
 * 让多租户请求写到正确的 kernel tenant; 不传 spaceId 时回退全局默认 (兼容
 * 老单租户部署)。
 *
 * memory 未启用时返 null, 调用侧靠 `if (client)` 短路。
 */
export function buildTdaiClientForRequest(
  config: {
    tdai: {
      enabled?: boolean;
      endpoint?: string;
      apiKey?: string;
      serviceId?: string;
      memory: {
        enabled?: boolean;
        writeL0?: boolean;
        recallL1?: boolean;
        injectL2L3?: boolean;
        l1Limit?: number;
        l2Limit?: number;
        timeoutMs?: number;
      };
    };
  },
  spaceId?: string,
): TdaiClient | null {
  const t = config.tdai;
  if (!t?.enabled || !t.memory?.enabled || !t.endpoint) return null;
  // 与 handler/anthropic 的 createTdaiClient 完全一致的字段透传;
  // 老 factory 也没做 defaults — 依赖 config 加载器 fillDefaults 已经填过。
  return new TdaiClient({
    enabled: t.enabled && t.memory.enabled,
    endpoint: t.endpoint,
    apiKey: t.apiKey ?? "",
    serviceId: spaceId || t.serviceId || "",
    writeL0: t.memory.writeL0 ?? false,
    recallL1: t.memory.recallL1 ?? false,
    injectL2L3: t.memory.injectL2L3 ?? false,
    l1Limit: t.memory.l1Limit ?? 0,
    l2Limit: t.memory.l2Limit ?? 0,
    timeoutMs: t.memory.timeoutMs ?? 0,
  });
}

// ── ACL types ─────────────────────────────────────────────────────────────
export type AclAction = "read" | "write" | "delete" | "grant";

export interface AclCheckParams {
  /**
   * 请求发起者的 user_key（原始 `sk-mem-...`）。
   *
   * tdai `/v3/meta/*` 路由要求 `x-tdai-user-key` header 才能通过 Layer 3
   * 用户鉴权（否则 401 missing_user_key）。这里传入的 user_key 会：
   *   1. 作为 `x-tdai-user-key` header 走鉴权（"你是谁"）
   *   2. tdai 服务端会用它解析出 user_id，用于 checkAssetPermission 判定
   *
   * 因此 body 里**不再需要** user_id —— tdai 从 header 自解析。
   */
  user_key: string;
  /** 目标资产 id，如 `chat_memory-{team}-{agent}`。 */
  asset_id: string;
  action: AclAction;
  /** 可选：显式限定检查作用于哪个 agent。 */
  agent_id?: string;
}

export interface AclCheckResult {
  allowed: boolean;
  reason?: string;
}

export class TdaiClient {
  constructor(private config: TdaiMemoryConfig) {}

  isEnabled(): boolean {
    return this.config.enabled && !!this.config.endpoint;
  }

  async addConversation(identity: TdaiIdentity, messages: TdaiMessage[]): Promise<void> {
    if (!this.isEnabled() || !this.config.writeL0 || messages.length === 0) return;

    const userLenForLog = (messages[0]?.content ?? "").length;

    // L0 user 去重：命中则本轮只写 assistant（若有），不再重复写 user。
    const now = Date.now();
    let outgoing = messages;
    let pendingDedupKey: string | null = null;
    const userIdx = messages.findIndex((m) => m.role === "user" && m.content.trim().length > 0);
    if (userIdx >= 0) {
      const dedupKey = l0UserDedupKey(identity, messages[userIdx].content);
      if (l0UserDedupHit(dedupKey, now)) {
        outgoing = messages.filter((_, i) => i !== userIdx);
        log.info("tdai-recorder:write-l0-dedup", {
          session: identity.sessionId,
          agent: identity.agentId,
          userLen: messages[userIdx].content.length,
          remaining: outgoing.length,
        });
      } else {
        pendingDedupKey = dedupKey;
      }
    }
    if (outgoing.length === 0) return;

    const chunkedMessages = chunkConversationMessages(outgoing);
    log.info("tdai-recorder:write-l0", {
      team: identity.teamId,
      agent: identity.agentId,
      user: identity.userId,
      session: identity.sessionId,
      task: identity.taskId,
      msgs: outgoing.length,
      chunks: chunkedMessages.length,
      userLen: userLenForLog,
    });

    for (let offset = 0; offset < chunkedMessages.length; offset += TDAI_CONVERSATION_MAX_MESSAGES) {
      const batch = chunkedMessages.slice(offset, offset + TDAI_CONVERSATION_MAX_MESSAGES);
      await this.postForCtx(
        "/v3/conversation/add",
        { teamId: identity.teamId, userId: identity.userId, agentId: identity.agentId },
        {
          team_id: identity.teamId,
          user_id: identity.userId,
          agent_id: identity.agentId,
          session_id: identity.sessionId,
          task_id: identity.taskId,
          messages: batch,
        },
        identity.sessionId,
        identity.taskId,
        { includeSession: true, includeTask: true, throwOnError: true },
      );
    }

    // 写入成功后才记录水位：失败重试时不会误跳过 user 消息。
    if (pendingDedupKey) l0UserDedupSeen.set(pendingDedupKey, now);
  }

  async searchL1(identity: TdaiIdentity, query: string): Promise<TdaiL1Memory[]> {
    return this.searchL1ForCtx(
      { teamId: identity.teamId, userId: identity.userId, agentId: identity.agentId },
      query,
      identity.sessionId,
      identity.taskId,
    );
  }

  /**
   * Multi-agent variant: search L1 against a specific (team, user, agent)
   * triplet, while keeping the caller's session/task on the wire.
   *   - 用于"自有 + 借入"召回中的某一个 agent
   *   - 不带 query 直接返空（与原行为一致）
   */
  async searchL1ForCtx(
    ctx: TdaiAgentCtx,
    query: string,
    sessionId: string,
    taskId?: string,
    limit?: number,
  ): Promise<TdaiL1Memory[]> {
    if (!this.isEnabled() || !this.config.recallL1 || !query.trim()) return [];
    const data = await this.postForCtx<{ items?: Array<Record<string, unknown>> }>(
      "/v3/atomic/search",
      ctx,
      {
        team_id: ctx.teamId,
        user_id: ctx.userId,
        agent_id: ctx.agentId,
        session_id: sessionId,
        task_id: taskId,
        query: query.slice(0, 2048),
        limit: limit ?? this.config.l1Limit,
      },
      sessionId,
      taskId,
      { includeSession: true, includeTask: true },
    );
    return (data.items ?? [])
      .map((item) => ({
        id: String(item.id ?? ""),
        type: typeof item.type === "string" ? item.type : undefined,
        content: typeof item.content === "string" ? item.content : "",
        score: typeof item.score === "number" ? item.score : undefined,
        updatedAt: typeof item.updated_at === "string" ? item.updated_at : undefined,
      }))
      .filter((m) => m.id && m.content);
  }

  async listL2(identity: TdaiIdentity): Promise<TdaiL2Entry[]> {
    return this.listL2ForCtx({
      teamId: identity.teamId,
      userId: identity.userId,
      agentId: identity.agentId,
    });
  }

  async listL2ForCtx(ctx: TdaiAgentCtx): Promise<TdaiL2Entry[]> {
    if (!this.isEnabled() || !this.config.injectL2L3) return [];
    const data = await this.postForCtx<{ entries?: Array<Record<string, unknown>> }>(
      "/v3/scenario/ls",
      ctx,
      {
        team_id: ctx.teamId,
        agent_id: ctx.agentId,
        path_prefix: "",
      },
      "",
      undefined,
      { includeSession: false, includeTask: false },
    );
    return (data.entries ?? [])
      .map((entry) => ({
        path: String(entry.path ?? ""),
        summary: typeof entry.summary === "string" ? entry.summary : undefined,
        updatedAt: typeof entry.updated_at === "string" ? entry.updated_at : undefined,
      }))
      .filter((entry) => entry.path && !entry.path.endsWith("/"))
      .slice(0, this.config.l2Limit);
  }

  async readL2(identity: TdaiIdentity, path: string): Promise<TdaiL2File | null> {
    return this.readL2ForCtx(
      { teamId: identity.teamId, userId: identity.userId, agentId: identity.agentId },
      path,
    );
  }

  async readL2ForCtx(ctx: TdaiAgentCtx, path: string): Promise<TdaiL2File | null> {
    if (!this.isEnabled() || !this.config.injectL2L3 || !path) return null;
    const data = await this.postForCtx<Record<string, unknown> | null>(
      "/v3/scenario/read",
      ctx,
      {
        team_id: ctx.teamId,
        agent_id: ctx.agentId,
        path,
      },
      "",
      undefined,
      { includeSession: false, includeTask: false },
    );
    const content = typeof data?.content === "string" ? data.content : "";
    if (!content) return null;
    return {
      path,
      content,
      updatedAt: typeof data?.updated_at === "string" ? data.updated_at : undefined,
    };
  }

  async readL3(identity: TdaiIdentity): Promise<TdaiL3Core | null> {
    return this.readL3ForCtx({
      teamId: identity.teamId,
      userId: identity.userId,
      agentId: identity.agentId,
    });
  }

  async readL3ForCtx(ctx: TdaiAgentCtx): Promise<TdaiL3Core | null> {
    if (!this.isEnabled() || !this.config.injectL2L3) return null;
    const data = await this.postForCtx<Record<string, unknown> | null>(
      "/v3/core/read",
      ctx,
      {
        team_id: ctx.teamId,
        agent_id: ctx.agentId,
      },
      "",
      undefined,
      { includeSession: false, includeTask: false },
    );
    const content = typeof data?.content === "string" ? data.content : "";
    if (!content) return null;
    return { content, updatedAt: typeof data?.updated_at === "string" ? data.updated_at : undefined };
  }

  private async postForCtx<T>(
    path: string,
    ctx: TdaiAgentCtx,
    body: Record<string, unknown>,
    sessionId: string,
    taskId: string | undefined,
    options: { includeSession: boolean; includeTask: boolean; throwOnError?: boolean } = { includeSession: true, includeTask: true },
  ): Promise<T> {
    const base = this.config.endpoint.replace(/\/$/, "");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.config.apiKey || "local-proxy"}`,
        "x-tdai-service-id": this.config.serviceId || "default",
        "x-tdai-team-id": ctx.teamId,
        "x-tdai-user-id": ctx.userId,
        "x-tdai-agent-id": ctx.agentId,
      };
      if (options.includeSession && sessionId) headers["x-tdai-session-id"] = sessionId;
      if (options.includeTask && taskId) headers["x-tdai-task-id"] = taskId;

      const res = await fetch(`${base}${path}`, {
        method: "POST",
        signal: controller.signal,
        headers,
        body: JSON.stringify(stripUndefined(body)),
      });
      if (!res.ok) {
        if (options.throwOnError) throw new Error(`TDAI ${path} failed: HTTP ${res.status}`);
        return {} as T;
      }
      const envelope = await res.json() as TdaiEnvelope<T>;
      if (typeof envelope.code === "number" && envelope.code !== 0) {
        if (options.throwOnError) throw new Error(`TDAI ${path} failed: code ${envelope.code}`);
        return {} as T;
      }
      return (envelope.data ?? {}) as T;
    } catch (error) {
      if (options.throwOnError) throw error;
      return {} as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── ACL check ──────────────────────────────────────────────────────────
  //
  // 与 memory 读取调用（postForCtx 默认模式）**语义相反**：
  //   - postForCtx 读取失败返回空，让注入路径降级；L0 写入开启 throwOnError
  //   - checkAcl 网络/HTTP/envelope 错要抛出 —— 让上层 fail-closed 拒绝注入
  //     并打 error 日志（否则 acl 服务挂了会静默变成"全部允许"，越权）
  //
  // 因此本方法不复用 postForCtx，独立实现 —— 但仍然复用同一份 config
  // （endpoint / apiKey / serviceId / timeoutMs）。

  /**
   * 校验 user_id 对某 asset 的权限。
   *
   * 抛错场景（fetch/超时/HTTP 非 2xx/envelope code≠0/data.allowed 非 boolean）
   * 应当由调用方 catch 后按业务需要处理 —— 注入路径请用 checkAclOrDeny 便捷函数。
   */
  async checkAcl(params: AclCheckParams): Promise<AclCheckResult> {
    if (!this.isEnabled()) {
      // 未启用 tdai 时按"通过"处理，与其他 memory 方法在 disabled 下的返回一致。
      return { allowed: true, reason: "tdai_disabled" };
    }
    const base = this.config.endpoint.replace(/\/$/, "");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const res = await fetch(`${base}/v3/meta/acl/check`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey || "local-proxy"}`,
          "x-tdai-service-id": this.config.serviceId || "default",
          // Layer 3 用户鉴权：tdai v3 meta 路由要求此 header 才能通过，否则
          // 401 missing_user_key。Proxy 侧的当前请求发起者 user_key 直接用作
          // 调用者身份。
          "x-tdai-user-key": params.user_key,
        },
        body: JSON.stringify({
          // body user_key = 要**检查权限的目标用户**（这里跟调用者是同一个人 —— proxy
          // 场景下永远是自己给自己校验）。schema (userIdOrKeyFields.refine)
          // 要求 user_id 或 user_key 至少一个 —— 我们复用 header 那个 key。
          user_key: params.user_key,
          asset_id: params.asset_id,
          action: params.action,
          agent_id: params.agent_id,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`acl/check http ${res.status}: ${body.slice(0, 200)}`);
      }
      const envelope = (await res.json()) as TdaiEnvelope<AclCheckResult>;
      if (typeof envelope.code === "number" && envelope.code !== 0) {
        throw new Error(`acl/check envelope code=${envelope.code} msg=${envelope.message ?? ""}`);
      }
      const data = envelope.data;
      if (!data || typeof data.allowed !== "boolean") {
        throw new Error(`acl/check malformed response: ${JSON.stringify(data).slice(0, 200)}`);
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * 注入路径便捷函数：包一层 try/catch + error 日志。
 *
 * 语义：
 *   - allowed=true                  → 放行
 *   - allowed=false                 → 拒绝（正常，由调用方决定是否 warn）
 *   - 底层调用抛错                  → 拒绝 + error 日志（fail-closed）
 *
 * 使用场景：resolveFixedAssetCtxs 里逐个 ctx 过滤时，不希望一次网络错就
 * 让整个注入路径抛异常，用这个便捷函数把异常转成"拒绝"信号即可。
 */
export async function checkAclOrDeny(
  client: TdaiClient,
  params: AclCheckParams,
): Promise<AclCheckResult> {
  try {
    return await client.checkAcl(params);
  } catch (err) {
    log.error(
      "[tdai-acl] check_failed",
      { user_key_masked: maskUserKey(params.user_key), asset_id: params.asset_id, action: params.action },
      err instanceof Error ? err : new Error(String(err)),
    );
    return { allowed: false, reason: "acl_check_error" };
  }
}

function stripUndefined(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

/** 打印敏感 userKey 时脱敏：只保留前 6 位 + 后 4 位。 */
function maskUserKey(key: string | undefined): string {
  if (!key) return "";
  if (key.length <= 12) return "***";
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

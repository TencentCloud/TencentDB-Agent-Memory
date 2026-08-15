/**
 * POST /v3/session/refresh-cache
 *
 * 核心逻辑：基于 session init 信息重新执行 prewarmFromConfig，刷新 COS 上的注入缓存。
 * 除了 hook 侧的缓存，同时也会重新拉一次 Agent/Task 的 detail 覆写到 SessionStore，
 * 让"任务描述 / Agent 描述"这类 session-init 时快照下来的字段也跟着刷新。
 *
 * 两种使用方式：
 *   1. 函数调用（mem:sync 内部用）— import refreshSessionCache()
 *   2. HTTP 接口（面板前端用）— createSessionRefreshHandler() 注册路由
 */

import type { Context } from "hono";
import type { ProxyConfig } from "../types.js";
import { getSessionStore } from "../session/store.js";
import { prewarmFromConfig } from "../injection/index.js";
import type { SessionInitState, AgentDetail, TaskDetail } from "../session/types.js";
import { getMetadataClient } from "../meta/client.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface RefreshInput {
  sessionKey: string;
  agentSource: string;
  config: ProxyConfig;
  spaceId: string;
  callerUserKey?: string;
}

export interface RefreshResult {
  success: boolean;
  /** Hook 缓存刷新的 hookId 列表（skill/memory/knowledge/... injector 各自的 id）。 */
  refreshed: string[];
  skipped: string[];
  /** 是否成功重拉了 agent detail（覆写到 SessionStore）。 */
  agentRefreshed: boolean;
  /** 是否成功重拉了 task detail（覆写到 SessionStore）。 */
  taskRefreshed: boolean;
  tookMs: number;
  error?: string;
}

// ── Core Logic ─────────────────────────────────────────────────────────────

/**
 * 重新拉一次 Agent + Task detail 并覆写到 SessionStore。
 *
 * 失败仅 warn 不抛：agent/task detail 拉不到属于"降级"场景，hook 缓存刷新仍然
 * 应当继续。返回值告诉 caller 哪一项成功了以便文案里说明。
 */
async function refreshAgentTaskDetail(
  state: SessionInitState,
  compositeKey: string,
  config: ProxyConfig,
  spaceIdFromCaller: string,
  callerUserKey: string | undefined,
): Promise<{ agentRefreshed: boolean; taskRefreshed: boolean }> {
  const sessionInfo = state.sessionInfo;
  if (!sessionInfo) return { agentRefreshed: false, taskRefreshed: false };

  // ServiceId (space) 取自 sessionInfo；调用方传入的 spaceId 作为兜底。
  const serviceId = sessionInfo.space_id || spaceIdFromCaller || "";
  // MetadataClient 需要 x-tdai-user-key，优先 sessionInfo，再退到调用方。
  const userKey = sessionInfo.user_key || callerUserKey || "";

  if (!serviceId || !userKey || !config.coreSkill?.endpoint) {
    // 缺少 kernel 调用要素 → 直接跳过 detail 刷新，不视为错误。
    return { agentRefreshed: false, taskRefreshed: false };
  }

  const client = getMetadataClient(config.coreSkill, serviceId, userKey);

  const agentId = sessionInfo.agent_id;
  const taskId = sessionInfo.task_id;
  const shouldFetchTask = !!taskId && taskId !== (config as any).defaultTaskId;

  const [agentRes, taskRes] = await Promise.allSettled([
    agentId
      ? client.getAgent(agentId).then((a) => ({
          id: a.agent_id,
          name: a.name,
          description: a.description ?? undefined,
          prompt: a.prompt ?? undefined,
        } as AgentDetail))
      : Promise.resolve(null as AgentDetail | null),
    shouldFetchTask
      ? client.getTask(taskId!).then((t) => ({
          id: t.task_id,
          name: t.title,
          description: t.description ?? undefined,
        } as TaskDetail))
      : Promise.resolve(null as TaskDetail | null),
  ]);

  let agentRefreshed = false;
  let taskRefreshed = false;
  let nextAgent: AgentDetail | null | undefined = state.agentDetail;
  let nextTask: TaskDetail | null | undefined = state.taskDetail;

  if (agentRes.status === "fulfilled" && agentRes.value) {
    nextAgent = agentRes.value;
    agentRefreshed = true;
  } else if (agentRes.status === "rejected") {
    console.warn(
      `[session-refresh] getAgent failed for ${compositeKey}: ` +
        (agentRes.reason instanceof Error ? agentRes.reason.message : String(agentRes.reason)),
    );
  }

  if (taskRes.status === "fulfilled" && taskRes.value) {
    nextTask = taskRes.value;
    taskRefreshed = true;
  } else if (taskRes.status === "rejected") {
    console.warn(
      `[session-refresh] getTask failed for ${compositeKey}: ` +
        (taskRes.reason instanceof Error ? taskRes.reason.message : String(taskRes.reason)),
    );
  }

  if (agentRefreshed || taskRefreshed) {
    const nextState: SessionInitState = {
      ...state,
      agentDetail: nextAgent ?? null,
      taskDetail: nextTask ?? null,
    };
    try {
      await getSessionStore().set(compositeKey, nextState);
    } catch (err) {
      console.warn(
        `[session-refresh] store.set failed for ${compositeKey}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  return { agentRefreshed, taskRefreshed };
}

/**
 * 刷新当前 session 的全部注入缓存。
 *
 * 从 SessionStore 取 sessionInfo → 重拉 Agent/Task detail 覆写 store →
 * 构建 PrewarmInput → 调用 prewarmFromConfig()
 */
export async function refreshSessionCache(input: RefreshInput): Promise<RefreshResult> {
  const { sessionKey, agentSource, config, spaceId, callerUserKey } = input;

  // 参数校验
  if (!sessionKey) {
    return {
      success: false, refreshed: [], skipped: [],
      agentRefreshed: false, taskRefreshed: false,
      tookMs: 0, error: "session_key is required",
    };
  }

  // 从 SessionStore 取 session 状态
  const compositeKey = `${agentSource}:${sessionKey}`;
  const store = getSessionStore();
  const state: SessionInitState | undefined = store.get(compositeKey);

  if (!state) {
    return {
      success: false, refreshed: [], skipped: [],
      agentRefreshed: false, taskRefreshed: false,
      tookMs: 0, error: `Session not found: ${sessionKey}`,
    };
  }

  if (!state.sessionInfo) {
    return {
      success: false, refreshed: [], skipped: [],
      agentRefreshed: false, taskRefreshed: false,
      tookMs: 0, error: `Session not initialized: ${sessionKey}`,
    };
  }

  const t0 = Date.now();

  // Step 1: 尝试重拉 agent/task detail 并覆写 SessionStore。
  //         失败不阻断 hook 缓存刷新，只是最终返回值里 agentRefreshed/taskRefreshed 为 false。
  const { agentRefreshed, taskRefreshed } = await refreshAgentTaskDetail(
    state, compositeKey, config, spaceId, callerUserKey,
  );

  // Step 2: 用最新 state 里的 agent/task detail 构造 PrewarmInput。
  const latestState = store.get(compositeKey) ?? state;
  const sessionInfo = latestState.sessionInfo!;
  const agentDetail = latestState.agentDetail ?? null;
  const taskDetail = latestState.taskDetail ?? null;

  try {
    const result = await prewarmFromConfig(
      config,
      {
        keyId: compositeKey,
        userId: sessionInfo.user_id || "anonymous",
        agentSource,
        spaceId,
        sessionInfo,
        agentDetail,
        taskDetail,
        callerUserKey,
      },
      // 刷新场景必须 clearBefore=true —— 首次 session_init 复用同一入口时不带
      // 这个选项,保留 "cache miss 由 pipeline 走 execute() self-heal" 的语义;
      // 刷新时开启后,任何 hook 拿到 []/超时/异常都会连带旧缓存一起清掉,防止
      // "资产已解绑但注入还带着老快照" 的场景(尤其 knowledge 的 wiki/code-graph
      // 全解绑 → prewarm 返回空 → 默认逻辑不写 → COS 上老 <knowledge_tools>
      // 无限续命)。详见 `injection/prewarm.ts` 的 PrewarmOptions.clearBefore 注释。
      { clearBefore: true },
    );
    const tookMs = Date.now() - t0;
    return {
      success: true,
      refreshed: result.cachedHookIds,
      skipped: result.skipped.map((s) => (typeof s === "string" ? s : s.hookId)),
      agentRefreshed,
      taskRefreshed,
      tookMs,
    };
  } catch (err) {
    const tookMs = Date.now() - t0;
    return {
      success: false, refreshed: [], skipped: [],
      agentRefreshed, taskRefreshed,
      tookMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── HTTP Handler ───────────────────────────────────────────────────────────

/**
 * 创建 HTTP handler，注册到 server.ts。
 * 走 admin auth 鉴权（复用 admin-auth.ts 的模式）。
 */
export function createSessionRefreshHandler(config: ProxyConfig) {
  return async (c: Context): Promise<Response> => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ code: 40001, message: "Invalid JSON body", request_id: `refresh-${Date.now()}` }, 400);
    }

    const sessionKey = typeof body.session_key === "string" ? body.session_key : "";
    const agentSource = typeof body.agent_source === "string" ? body.agent_source : "claude-code";
    const callerUserKey = typeof body.user_key === "string" ? body.user_key : undefined;
    const spaceId = typeof body.space_id === "string" ? body.space_id : "";

    const result = await refreshSessionCache({
      sessionKey,
      agentSource,
      config,
      spaceId,
      callerUserKey,
    });

    const requestId = `refresh-${Date.now()}`;

    if (!result.success) {
      const status = result.error?.includes("not found") ? 404 : 400;
      return c.json({ code: status === 404 ? 40401 : 40001, message: result.error, request_id: requestId }, status);
    }

    return c.json({
      code: 0,
      message: "ok",
      request_id: requestId,
      data: {
        refreshed: result.refreshed,
        skipped: result.skipped,
        agent_refreshed: result.agentRefreshed,
        task_refreshed: result.taskRefreshed,
        took_ms: result.tookMs,
      },
    });
  };
}

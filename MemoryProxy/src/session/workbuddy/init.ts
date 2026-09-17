/**
 * WorkBuddy session-init —— **header-preselect-only** 独立实现。
 *
 * ⚠️ 独立性铁律：本文件不 import 任何 sibling handler / sibling session 模块
 * (session/codebuddy/*, session/codex/*, session/claude-code/*)。只依赖
 * **多 client 共用的通用基础设施**：
 *   - session/store.ts        （通用 KV store）
 *   - session/preset.ts       （header解析 + 校验，client-agnostic）
 *   - session/registrar.ts    （SessionInfo 构造）
 *   - session/context-injector.ts（session_context XML 生成）
 *   - session/types.ts（通用类型）
 *   - meta/client.ts          （TDAI kernel API客户端）
 *
 * ============================================================================
 * WorkBuddy 客户端语义
 * ============================================================================
 * 抓包结论（详见 docs/workbuddy-recon/）：
 *   - Wire protocol：OpenAI Responses API（同 codex 底层协议）
 *   - **系统提示词不含 request_user_input 类 form 工具**（真实抓包证实）
 *   - 客户端无法弹交互式选择表单让用户选 team/agent/task
 *
 * 因此本 session-init 的行为退化为纯**入口守门**：
 *   - 请求 header 含完整 team+agent+task ID → 校验后直接注册 → 继续注入
 *   - 缺任一 → **静默 bypass**（透传上游，不注入资产）
 *   - 已有 session state（同 sessionKey 复用）→ 走recovered 快通道
 *
 * 与 CB/codex/CC 三家 session-init 状态机的**关键差异**：
 *   1. 不返回 `intercepted=true`（本客户端不能接收 form response）
 *   2. 不做 Default gate 检测（客户端本身不发 gate 信号）
 *   3. 不做 MORE 分页（不需要交互）
 *   4. 不做 form 拦截（客户端无 form 工具）
 * ============================================================================
 */

import type { SessionInitConfig } from "../../types.js";
import type { MetadataClient } from "../../meta/client.js";
import type { SessionStore, SessionIdentity } from "../store.js";
import { buildSessionInfo } from "../registrar.js";
import type {
  AgentDetail,
  SessionInfo,
  SessionInitState,
  TaskDetail,
} from "../types.js";
import { buildSessionContextBlockWithToggles } from "../context-injector.js";
import {
  parsePresetIdentity,
  resolvePresetIdentity,
  type PresetIdentity,
} from "../preset.js";

// ── Result type ──────────────────────────────────────────────────────────────

/**
 * WorkBuddy session-init 结果。与 CB/CC/codex 三家的 SessionInitResult 语义
 * 对齐（sessionInfo/agentDetail/taskDetail/systemAppend/bypassed 字段名一致），
 * 但**独立类型**避免跨 handler 类型共享。
 */
export interface WorkbuddySessionInitResult {
  /**
   * 会话是否已成功注册。false 时caller 应跳过 injection、直接透传上游。
   */
  bypassed: boolean;
  /** 注册成功时的 SessionInfo；bypass 分支为 null。 */
  sessionInfo: SessionInfo | null;
  /** Agent 详情（含 prompt / persona）；bypass 分支为 null。 */
  agentDetail: AgentDetail | null;
  /** Task 详情（含 description / goal）；bypass 分支为 null。 */
  taskDetail: TaskDetail | null;
  /**
   * 预构造的 `<session_context>` block；供injection 阶段合成 body 时预填
   * system message。bypass 分支为 null。
   */
  systemAppend: string | null;
  /**
   * 本轮是否**新注册**（recovered 快通道复用 = false, 首次注册 = true）。
   * 用于决定是否触发 injection prewarm。
   */
  justRegistered: boolean;
  /**
   * 走 bypass 时的原因，用于日志/埋点分析：
   *   - "no-header"：请求未带 x-tdai-team-id 头（客户端无 form 兜底 → 直接绕过）
   *   - "incomplete-header"：header 有 team 但缺 agent或 task
   *   - "mismatch"：header值与 kernel 返回的 team/agent 列表不一致
   *   - "kernel-error"：调用 kernel API 失败
   *   - "config-disabled"：sessionInit.enabled=false 或 headerAutoSelect.enabled=false
   */
  bypassReason?:
    | "no-header"
    | "incomplete-header"
    | "mismatch"
    | "kernel-error"
    | "config-disabled";
}

// ── Request context ──────────────────────────────────────────────────────────

/**
 * 调用 handleWorkbuddySessionInit 时透传的运行时上下文（与请求无关的参数从
 * 独立参数走）。
 */
export interface WorkbuddyRequestContext {
  /** SSE stream 标志——供未来 form 场景使用；本 handler 当前不构造 form 响应。 */
  stream: boolean;
  /** 客户端请求的模型 ID；透传给日志/埋点。 */
  modelId: string;
}

// ── Main entry ──────────────────────────────────────────────────────────────

/**
 * WorkBuddy session-init 入口。
 *
 * 流程（详见 module doc 顶部）：
 *   1. sessionInit.enabled=false → bypass(config-disabled)
 *   2. 从 store 复用已有 state → 直接 recovered 快通道
 *   2.5 **DEBUG**：`sessionInit.debugForceIdentity` 齐全（team+agent+task）→
 *      跳过 header 与 kernel listTeams 校验，直接用固定三元组注册（本地/e2e 专用）
 *   3. 解析 preset identity（三header）：
 *      - 无 team header → bypass(no-header)
 *      - 有 team header 但缺 agent 或 task → bypass(incomplete-header)
 *      - team+agent+task 齐全 → 拉 kernel team list 校验
 *        - resolvePresetIdentity.canRegister=true → 完成注册
 *        - 校验失败 → bypass(mismatch)
 *   4. 注册成功后落 store（下一轮走 recovered 分支）
 *
 * @param sessionKey     去重键（一般是客户端 session_id 或 fallback keyId:traceId）
 * @param userId         apiKey 解析出的用户 ID（可为 null）
 * @param config         SessionInitConfig（含 headerAutoSelect 配置）
 * @param store          通用 SessionStore（多 client 共用，`workbuddy:` 前缀隔离）
 * @param reqCtx         请求运行时上下文
 * @param headers        小写化后的请求头 map
 * @param agentSource    固定为 "workbuddy"（compositeKey 前缀）
 * @param metadataClient TDAI kernel 客户端；bypass 分支可传 undefined
 * @param userKey        原始 apiKey，落 SessionInfo.user_key
 * @param spaceId        URL path 里的 spaceId
 */
export async function handleWorkbuddySessionInit(
  sessionKey: string,
  userId: string | null,
  config: SessionInitConfig,
  store: SessionStore,
  reqCtx: WorkbuddyRequestContext,
  headers: Record<string, string>,
  agentSource: string,
  metadataClient: MetadataClient | undefined,
  userKey: string | undefined,
  spaceId: string | undefined,
): Promise<WorkbuddySessionInitResult> {
  void reqCtx; // 保留供未来扩展（form / MORE 分页时会用到 stream/modelId）

  // ── 1. 配置门控 ────────────────────────────────────────────────────────────
  if (!config.enabled) {
    return bypassResult("config-disabled");
  }

  const compositeKey = `${agentSource}:${sessionKey}`;
  const identity: SessionIdentity = {
    userId: userId || "anonymous",
    agentSource,
    sessionId: sessionKey,
    spaceId: spaceId || "",
  };

  // ── 2. 复用已有 state（recovered 快通道）─────────────────────────────────
  // getOrRecover 内部自动 bind 身份，无需另外调store.bind
  const recovered = await store.getOrRecover(compositeKey, identity, {
    metadataClient,
    messages: [], // WorkBuddy 无form → 不需要历史扫描回收
  });

  if (recovered && recovered.status === "initialized") {
    const sessionInfo = recovered.sessionInfo ?? null;
    const agentDetail = recovered.agentDetail ?? null;
    const taskDetail = recovered.taskDetail ?? null;
    const bypassed = Boolean(recovered.bypassed);

    const systemAppend = bypassed
      ? null
      : buildSessionContextBlockWithToggles(
          agentDetail,
          taskDetail,
          config,
          sessionKey,
        );

    return {
      bypassed,
      sessionInfo: bypassed ? null : sessionInfo,
      agentDetail: bypassed ? null : agentDetail,
      taskDetail: bypassed ? null : taskDetail,
      systemAppend,
      justRegistered: false,
    };
  }

  // ── 2.5 DEBUG BYPASS：debugForceIdentity 强制注入（本地开发 / e2e）─────────
  // 目的：绕过 header 解析 + kernel listTeams 校验，用配置里指定的固定三元组
  //       (team_id, agent_id, task_id) 直接完成注册。仅用于本地跑通/联调。
  // 语义与 CC 版对齐：需要 team+agent+task 三者齐全才能走这条路（缺任一即忽略
  // debug 配置、退回正常 preset 流程），保证 injection 需要的 task 一定存在。
  if (
    config.debugForceIdentity &&
    config.debugForceIdentity.team_id &&
    config.debugForceIdentity.agent_id &&
    config.debugForceIdentity.task_id
  ) {
    // 提到局部常量，让 TS 把 task_id 收窄成 string（原类型是 string | undefined）
    const forcedTeamId: string = config.debugForceIdentity.team_id;
    const forcedAgentId: string = config.debugForceIdentity.agent_id;
    const forcedTaskId: string = config.debugForceIdentity.task_id;
    const forcedUserId = identity.userId;
    console.log(
      `[workbuddy-init] session=${compositeKey} DEBUG bypass — force identity ` +
        `team=${forcedTeamId} agent=${forcedAgentId} task=${forcedTaskId} user=${forcedUserId}`,
    );

    // 尝试补 agent/task detail（失败降级为空）—— 与主路径 5. 段落一致
    let agentDetail: AgentDetail | null = null;
    let taskDetail: TaskDetail | null = null;
    if (metadataClient) {
      try {
        const agent = await metadataClient.getAgent(forcedAgentId);
        agentDetail = {
          id: agent.agent_id,
          name: agent.name,
          description: agent.description ?? undefined,
          prompt: agent.prompt ?? undefined,
        };
      } catch (err) {
        console.warn(
          `[workbuddy-init] DEBUG getAgent(${forcedAgentId}) failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      try {
        const task = await metadataClient.getTask(forcedTaskId);
        taskDetail = {
          id: task.task_id,
          name: task.title,
          description: task.description ?? undefined,
        };
      } catch (err) {
        console.warn(
          `[workbuddy-init] DEBUG getTask(${forcedTaskId}) failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const sessionInfo = buildSessionInfo(
      {
        session_id: sessionKey,
        team_id: forcedTeamId,
        agent_id: forcedAgentId,
        task_id: forcedTaskId,
        user_id: forcedUserId,
      },
      userKey,
      spaceId,
    );

    await store.set(compositeKey, {
      status: "initialized",
      keyId: compositeKey,
      startedAt: Date.now(),
      attemptCount: 0,
      bypassed: false,
      sessionInfo,
      userId: identity.userId,
      agentDetail,
      taskDetail,
    } as SessionInitState);

    const systemAppend = buildSessionContextBlockWithToggles(
      agentDetail,
      taskDetail,
      config,
      sessionKey,
    );

    return {
      bypassed: false,
      sessionInfo,
      agentDetail,
      taskDetail,
      systemAppend,
      justRegistered: true,
    };
  }

  // ── 3. 解析 preset identity ────────────────────────────────────────────────
  const preset: PresetIdentity | undefined = parsePresetIdentity(config, headers);
  if (!preset || !preset.teamId) {
    // 无 team header → WorkBuddy 客户端无 form 兜底 → 直接 bypass
    await persistBypass(store, compositeKey, identity);
    return bypassResult("no-header");
  }
  if (!preset.agentId || !preset.taskId) {
    // team 齐了但缺 agent 或 task → 无法完整注册，直接 bypass
    // （resolvePresetIdentity 也会返回 canRegister=false，此处提前 return 减少 kernel 调用）
    await persistBypass(store, compositeKey, identity);
    return bypassResult("incomplete-header");
  }

  // ── 4. 拉 kernel team list 校验 preset ────────────────────────────────────
  if (!metadataClient) {
    // 没有 kernel 客户端（config 未配置 tdai.endpoint / apiKey 不完整）→ bypass
    // 不落 store bypass —— 配置修复后可自动恢复
    return bypassResult("kernel-error");
  }

  // 通过 kernel 拉取当前用户可见的 team 列表，并fan-out 补齐 agents / tasks
  // （resolvePresetIdentity 需要 TeamOption[] 结构）
  let teams: import("../types.js").TeamOption[];
  try {
    const teamsRaw = await metadataClient.listTeams(identity.userId);
    teams = await Promise.all(
      teamsRaw.map(async (t) => {
        const [agentsRaw, tasksRaw] = await Promise.all([
          metadataClient.listAgents(t.team_id).catch(() => []),
          metadataClient.listTasks(t.team_id).catch(() => []),
        ]);
        return {
          team_id: t.team_id,
          team_name: t.name ?? t.team_id,
          agents: agentsRaw.map((a) => ({
            agent_id: a.agent_id,
            agent_name: a.name ?? a.agent_id,
          })),
          tasks: tasksRaw.map((tk) => ({
            task_id: tk.task_id,
            task_name: tk.title ?? tk.task_id,
          })),
        };
      }),
    );
  } catch (err) {
    console.warn(
      `[workbuddy-init] session=${sessionKey} listTeams failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    // 不落 store bypass —— kernel 错误可能是临时的，下一轮请求可以重试
    return bypassResult("kernel-error");
  }

  const resolution = resolvePresetIdentity(teams, preset);
  if (!resolution.canRegister) {
    // 校验失败：header 值与用户可见 team/agent/task 不一致 → 长期 bypass
    // （客户端下一轮请求还是会带同一 header，重试无益）
    await persistBypass(store, compositeKey, identity);
    return bypassResult("mismatch");
  }

  // ── 5. 拉 agent / task detail ─────────────────────────────────────────────
  let agentDetail: AgentDetail | null = null;
  let taskDetail: TaskDetail | null = null;
  try {
    if (resolution.agentId) {
      const agent = await metadataClient.getAgent(resolution.agentId);
      agentDetail = {
        id: agent.agent_id,
        name: agent.name,
        description: agent.description ?? undefined,
        prompt: agent.prompt ?? undefined,
      };
    }
  } catch (err) {
    console.warn(
      `[workbuddy-init] getAgent(${resolution.agentId}) failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    if (resolution.taskId) {
      const task = await metadataClient.getTask(resolution.taskId);
      taskDetail = {
        id: task.task_id,
        name: task.title,
        description: task.description ?? undefined,
      };
    }
  } catch (err) {
    console.warn(
      `[workbuddy-init] getTask(${resolution.taskId}) failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── 6. 构造 SessionInfo & 落 store ────────────────────────────────────────
  const sessionInfo = buildSessionInfo(
    {
      session_id: sessionKey,
      team_id: resolution.teamId!,
      agent_id: resolution.agentId!,
      task_id: resolution.taskId,
      user_id: userId || "anonymous",
    },
    userKey,
    spaceId,
  );

  const initState: SessionInitState = {
    status: "initialized",
    keyId: compositeKey,
    startedAt: Date.now(),
    attemptCount: 0,
    bypassed: false,
    sessionInfo,
    userId: identity.userId,
    agentDetail,
    taskDetail,
  };
  await store.set(compositeKey, initState);

  const systemAppend = buildSessionContextBlockWithToggles(
    agentDetail,
    taskDetail,
    config,
    sessionKey,
  );

  return {
    bypassed: false,
    sessionInfo,
    agentDetail,
    taskDetail,
    systemAppend,
    justRegistered: true,
  };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function bypassResult(
  reason: WorkbuddySessionInitResult["bypassReason"],
): WorkbuddySessionInitResult {
  return {
    bypassed: true,
    sessionInfo: null,
    agentDetail: null,
    taskDetail: null,
    systemAppend: null,
    justRegistered: false,
    bypassReason: reason,
  };
}

/**
 * 把 bypass 决定落进 SessionStore（terminal `initialized` + `bypassed=true`），
 * 下一轮请求会走 recovered 快通道直接返回 bypass。
 *
 * bypassReason 不落 store（SessionInitState 无此字段）；仅在本 handler
 * return value 侧携带。
 */
async function persistBypass(
  store: SessionStore,
  compositeKey: string,
  identity: SessionIdentity,
): Promise<void> {
  store.bind(compositeKey, identity);
  try {
    await store.set(compositeKey, {
      status: "initialized",
      keyId: compositeKey,
      startedAt: Date.now(),
      attemptCount: 0,
      bypassed: true,
      sessionInfo: null,
      userId: identity.userId,
      agentDetail: null,
      taskDetail: null,
    });
  } catch (err) {
    console.warn(
      `[workbuddy-init] persistBypass failed for key=${compositeKey}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

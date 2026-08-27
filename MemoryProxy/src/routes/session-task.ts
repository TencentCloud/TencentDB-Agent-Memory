/**
 * mem:create-task / mem:update-task 的核心业务：
 * 从当前 session 上下文出发，生成 Task 并写入 metadata，绑定到 session。
 *
 * 交互模型（"用户确认"闸门 —— 破坏性操作前必须先 draft、后 confirm）：
 *   - createTaskFromSession
 *       未绑真实 task → LLM 生成 title+description → 直接落库+绑定（一步到位）
 *       已绑真实 task → 生成新 draft → 写 pending → 返 pending，等用户 confirm/cancel
 *   - updateTaskFromSession
 *       未绑 task_id → 拦截返错，引导用户先 mem:create-task
 *       已绑：拉当前 task → 生成 draft（含 status 建议）→ 写 pending → 返 pending
 *              非 creator 不再拒绝，改为把 warning 挂到 pending 上,confirm 时告知用户
 *   - confirmPendingTaskAction / cancelPendingTaskAction
 *       从 pending-store 取出 payload,执行真正的创建 / 更新 / 覆盖绑定 / 清 pending
 *
 * 关键约束（kernel 对齐）：
 *   - create 时传 agent_id,让 kernel 关联当前 Agent (TAPD 需求原文)
 *   - 落库时**不改 title**（对齐既有产品约定,kernel 允许改但产品不改）
 *   - update 时 status 由 LLM 提议,proxy 直接透传给 kernel,不做枚举校验
 *   - creator_user_id / team_id 严格取 sessionInfo,防止越权
 *   - taskDraft 未配置 = 直接返 "config missing"（不做本地兜底）
 */

import type { Context } from "hono";
import type { ProxyConfig } from "../types.js";
import type { MemCommandMessage } from "../mem-command/types.js";
import { getSessionStore } from "../session/store.js";
import type { SessionInitState, SessionInfo } from "../session/types.js";
import { getMetadataClient } from "../meta/client.js";
import type { TaskEntity } from "../meta/client.js";
import { generateTaskDraft } from "../mem-command/task-draft-generator.js";
import {
  clearPending,
  getPending,
  makePendingKey,
  setPending,
  type PendingCreatePayload,
  type PendingUpdatePayload,
} from "../mem-command/pending-store.js";

// ── 输入 / 输出类型 ────────────────────────────────────────────────────────

export interface CreateTaskFromSessionInput {
  sessionKey: string;
  agentSource: string;
  config: ProxyConfig;
  spaceId: string;
  /** 用户提示（mem:create-task 后的自由文本），可空 */
  hint?: string;
  /** 最近对话（用于生成草稿） */
  recentMessages: MemCommandMessage[];
  /**
   * 用户在 mem:create-task 后写明的 title（原文，40 字截断由调用方负责）。
   *   - 有值：title 锁定，LLM 只负责生成 description；LLM 失败降级为 desc 留空、task 照样落库。
   *   - 无值：title + description 都由 LLM 从对话推断；LLM 失败则直接返错。
   */
  lockedTitle?: string;
}

export interface UpdateTaskFromSessionInput {
  sessionKey: string;
  agentSource: string;
  config: ProxyConfig;
  spaceId: string;
  hint?: string;
  recentMessages: MemCommandMessage[];
  /**
   * 用户在 mem:update-task 后写明的 description（原文）。
   *   - 有值：description 直接替换为该文本，不调 LLM。
   *   - 无值：调 LLM diff 出新 description（changed=false 时不落库）。
   */
  directDescription?: string;
}

/** confirm/cancel 入参（不带 recentMessages，因为 draft 已在 pending 里） */
export interface PendingActionInput {
  sessionKey: string;
  agentSource: string;
  config: ProxyConfig;
  spaceId: string;
}

/** create 命令首次调用时的 pending 摘要（给命令层拼预览文案用） */
export interface PendingCreateInfo {
  kind: "create";
  draftTitle: string;
  draftDescription: string;
  currentTaskId: string;
  currentTaskTitle?: string;
}

/** update 命令首次调用时的 pending 摘要 */
export interface PendingUpdateInfo {
  kind: "update";
  taskId: string;
  currentTitle?: string;
  currentDescription?: string;
  currentStatus?: string;
  draftDescription: string;
  statusSuggestion?: string;
}

export type PendingInfo = PendingCreateInfo | PendingUpdateInfo;

export interface TaskFromSessionResult {
  success: boolean;
  /** 成功时的 taskId */
  taskId?: string;
  /** 成功时的最终 title */
  title?: string;
  /** 成功时的最终 description */
  description?: string;
  /** 成功时的最终 status */
  status?: string;
  /** update 模式：LLM 判定为 "无需更新" 时 true —— 未落库 */
  noUpdateNeeded?: boolean;
  /**
   * create 模式：session 已绑定 task_id，此前的兼容位；新交互下会同时给 pending。
   * 保留字段名以兼容 HTTP handler 的响应外壳（respond() 里读它决定 409）。
   */
  alreadyBound?: boolean;
  /**
   * 首次调用生成了 pending 草稿等待用户确认。未落库；命令层需拼预览文案，
   * 引导下一轮回复 `mem:create-task confirm` / `mem:update-task confirm` 或 `... cancel`。
   */
  pending?: PendingInfo;
  /** confirm 分支：session 上没有对应 pending（可能超时/被取消/未生成过） */
  noPending?: boolean;
  /** cancel 分支：是否命中并清理了 pending */
  cancelled?: boolean;
  /** create 覆盖分支：原来绑定的旧 task_id（用于返回文案） */
  previousTaskId?: string;
  /** 失败原因，供调用方拼用户可见文案 */
  error?: string;
}

// ── 内部：取 session state 的通用检查 ─────────────────────────────────────

interface ResolvedSession {
  state: SessionInitState;
  sessionInfo: SessionInfo;
  teamId: string;
  userId: string;
  currentTaskId?: string;
}

function resolveSession(
  sessionKey: string,
  agentSource: string,
  config: ProxyConfig,
): ResolvedSession | { error: string } {
  if (!sessionKey) return { error: "session_key is required" };

  const compositeKey = `${agentSource}:${sessionKey}`;
  const store = getSessionStore();
  const state = store.get(compositeKey);

  if (!state || !state.sessionInfo) {
    return { error: `Session not found: ${sessionKey}` };
  }

  const sessionInfo = state.sessionInfo;
  const teamId = sessionInfo.team_id ?? "";
  const userId = sessionInfo.user_id ?? "";
  if (!teamId || !userId) {
    return { error: "session missing team_id/user_id (initialization incomplete)" };
  }

  // "本次不关联任务" 走 config.sessionInit.defaultTaskId（虚拟值，kernel 不存在），
  // 视为**未绑真实 task** —— 允许 create-task，禁止 update-task（后者会用 no-task 分支返错）。
  const rawTaskId = sessionInfo.task_id;
  const defaultTaskId = config.sessionInit?.defaultTaskId;
  const isVirtualDefault = !!rawTaskId && !!defaultTaskId && rawTaskId === defaultTaskId;
  const currentTaskId = isVirtualDefault ? undefined : rawTaskId;

  return { state, sessionInfo, teamId, userId, ...(currentTaskId ? { currentTaskId } : {}) };
}

// ── 内部：检查并取 taskDraft 配置 ─────────────────────────────────────────

function resolveTaskDraftConfig(config: ProxyConfig) {
  const draft = config.memCommand?.taskDraft;
  if (!draft || !draft.enabled) {
    return { error: "task_draft is not configured (see config.memCommand.taskDraft)" } as const;
  }
  return { cfg: draft } as const;
}

function getClientFromResolved(resolved: ResolvedSession, config: ProxyConfig, fallbackSpaceId: string) {
  return getMetadataClient(
    config.coreSkill,
    resolved.sessionInfo.space_id ?? fallbackSpaceId,
    resolved.sessionInfo.user_key ?? "",
  );
}

function normalizeDesc(d: string | null | undefined): string | undefined {
  return d == null ? undefined : d;
}

/** 由 resolved session 生成 pending key（含 team/agent/session 三元组）。 */
function pendingKeyOf(resolved: ResolvedSession, agentSource: string, sessionKey: string): string {
  return makePendingKey({
    team_id: resolved.teamId,
    // pending-store 的 agent 用 sessionInfo.agent_id (kernel 侧概念),缺失就用 agentSource 兜底
    agent_id: resolved.sessionInfo.agent_id ?? agentSource,
    session_id: sessionKey,
  });
}

// ── 内部：真正落库的两个原子操作（首次直落 / confirm 时也走这里） ────────

/**
 * 执行 create：调 kernel createTask，然后绑定 session。
 * agent_id 会尝试从 sessionInfo 取；缺就不传（由 kernel 决定）。
 */
async function doCreateAndBind(
  resolved: ResolvedSession,
  input: { sessionKey: string; agentSource: string; config: ProxyConfig; spaceId: string },
  title: string,
  description: string,
): Promise<{ ok: true; task: TaskEntity; bindWarning?: string } | { ok: false; error: string }> {
  let created: TaskEntity;
  try {
    const client = getClientFromResolved(resolved, input.config, input.spaceId);
    created = await client.createTask({
      team_id: resolved.teamId,
      creator_user_id: resolved.userId,
      title,
      description,
      ...(resolved.sessionInfo.agent_id ? { agent_id: resolved.sessionInfo.agent_id } : {}),
    });
  } catch (err) {
    return { ok: false, error: `metadata createTask failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    await bindTaskIdToSession(input.sessionKey, input.agentSource, created.task_id);
  } catch (err) {
    return {
      ok: true,
      task: created,
      bindWarning: `task created but session bind failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, task: created };
}

// ── 核心：create-task ─────────────────────────────────────────────────────
//
// 交互分层：
//   未绑 + 任意参数 → LLM 生成 draft → 立即落库（不需要 confirm）
//   已绑真实 task → LLM 生成 draft → 写 pending，等 confirm/cancel

export async function createTaskFromSession(
  input: CreateTaskFromSessionInput,
): Promise<TaskFromSessionResult> {
  const resolved = resolveSession(input.sessionKey, input.agentSource, input.config);
  if ("error" in resolved) return { success: false, error: resolved.error };

  const draftCfg = resolveTaskDraftConfig(input.config);
  if ("error" in draftCfg) return { success: false, error: draftCfg.error };

  // Step 1: LLM 生成草稿（lockedTitle 情况下只出 description）
  const draft = await generateTaskDraft(draftCfg.cfg, {
    mode: "create",
    hint: input.hint,
    recentMessages: input.recentMessages,
    ...(input.lockedTitle ? { lockedTitle: input.lockedTitle } : {}),
  });

  // Step 1a: 结果归一化
  //
  // 三挡降级（2026-08-18 修复失败率过高问题）：
  //   1) draft.ok=true          → 用 LLM 结果
  //   2) draft.ok=false + lockedTitle → title=lockedTitle, desc=""
  //   3) draft.ok=false + 无参数 → "未命名任务_yyMMdd_HHmm" 兜底，desc=""，让用户后续 mem:update-task 补
  //
  // 之前第 3 挡是"严格返错"，导致 LLM 一波动就要用户重试 3 次——非常糟糕的 UX。
  // 现在给个默认名并绑上，用户拿到 taskId 后可以随时补描述；
  // 兜底错误信息通过 bindWarning 透传给上层，UI 层可以选择性提示"AI 命名失败，已使用默认名"。
  let finalTitle: string;
  let finalDescription: string;
  let draftFallbackWarning: string | undefined;
  if (draft.ok) {
    finalTitle = draft.title;
    finalDescription = draft.description;
  } else if (input.lockedTitle) {
    // 有参数 + LLM 失败 → 降级：title 用参数、desc 留空
    finalTitle = input.lockedTitle;
    finalDescription = "";
    draftFallbackWarning = `AI description failed (${draft.error}); saved with empty description`;
  } else {
    // 无参数 + LLM 失败 → 兜底："未命名任务_yyMMdd_HHmm"
    finalTitle = buildFallbackTaskTitle();
    finalDescription = "";
    draftFallbackWarning = `AI draft failed (${draft.error}); saved with default title, use mem:update-task to refine`;
  }

  // Step 2a：已绑真实 task → 写 pending，等 confirm 覆盖绑定
  if (resolved.currentTaskId) {
    let boundTitle: string | undefined;
    try {
      const client = getClientFromResolved(resolved, input.config, input.spaceId);
      const t = await client.getTask(resolved.currentTaskId);
      boundTitle = t.title;
    } catch {
      // 拉不到旧 task title 也不阻塞（只影响预览显示）
    }
    const key = pendingKeyOf(resolved, input.agentSource, input.sessionKey);
    const payload: PendingCreatePayload = {
      kind: "create",
      draft: {
        title: finalTitle,
        description: finalDescription,
        ...(input.hint ? { hint: input.hint } : {}),
      },
      currentTaskId: resolved.currentTaskId,
      ...(boundTitle ? { currentTaskTitle: boundTitle } : {}),
    };
    setPending(key, payload);
    return {
      success: true,
      alreadyBound: true,
      taskId: resolved.currentTaskId,
      ...(boundTitle ? { title: boundTitle } : {}),
      pending: {
        kind: "create",
        draftTitle: finalTitle,
        draftDescription: finalDescription,
        currentTaskId: resolved.currentTaskId,
        ...(boundTitle ? { currentTaskTitle: boundTitle } : {}),
      },
      ...(draftFallbackWarning ? { error: draftFallbackWarning } : {}),
    };
  }

  // Step 2b：未绑 → 直接落库
  const persisted = await doCreateAndBind(resolved, input, finalTitle, finalDescription);
  if (!persisted.ok) return { success: false, error: persisted.error };
  const created = persisted.task;
  // 合并两类 warning：AI 兜底 + 绑定失败，都通过 error 字段透传给上层
  // （字段名 error 是历史遗留；语义是"success=true 但有 warning"）
  const combinedWarning = [draftFallbackWarning, persisted.bindWarning]
    .filter((w): w is string => !!w)
    .join("; ");
  return {
    success: true,
    taskId: created.task_id,
    title: created.title,
    description: normalizeDesc(created.description),
    status: created.status,
    ...(combinedWarning ? { error: combinedWarning } : {}),
  };
}

/**
 * 生成"未命名任务_yyyyMMdd_HHmm"作为 LLM 兜底 title。
 *
 * 时间戳精确到分钟，可读性 & 可搜性平衡：
 *   - 用户看到"未命名任务_260818_1710"能马上定位是啥时候创的
 *   - 不用秒，避免连续创建重名 —— 而且分钟内连开两个 task 是异常操作
 * 保证 ≤ MAX_TITLE_LEN(40) 字。
 */
function buildFallbackTaskTitle(): string {
  const now = new Date();
  const yy = String(now.getFullYear() % 100).padStart(2, "0");
  const MM = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const HH = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `未命名任务_${yy}${MM}${dd}_${HH}${mm}`;
}

// ── 核心：update-task ─────────────────────────────────────────────────────
//
// 交互分层（每次都需要 confirm）：
//   未绑 → 拦截返错，让用户先 create-task
//   已绑 → 拉当前 task → 生成 draft（含 status 建议）→ 写 pending → 返 pending
//          非 creator 直接拒（kernel 也不支持跨用户 update，proxy 侧提前给出建议 create-task 的指引）

export async function updateTaskFromSession(
  input: UpdateTaskFromSessionInput,
): Promise<TaskFromSessionResult> {
  const resolved = resolveSession(input.sessionKey, input.agentSource, input.config);
  if ("error" in resolved) return { success: false, error: resolved.error };

  if (!resolved.currentTaskId) {
    return {
      success: false,
      error:
        "no task bound to this session (session is in \"本次不关联任务\" mode or task_id missing); " +
        "use mem:create-task to create and bind a new task first",
    };
  }

  // 无参数分支才需要 LLM 配置
  if (!input.directDescription) {
    const draftCfg = resolveTaskDraftConfig(input.config);
    if ("error" in draftCfg) return { success: false, error: draftCfg.error };
  }

  // Step 1: 拉当前 task
  const client = getClientFromResolved(resolved, input.config, input.spaceId);
  let current: TaskEntity;
  try {
    current = await client.getTask(resolved.currentTaskId);
  } catch (err) {
    return {
      success: false,
      error: `metadata getTask failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 非 creator 直接拒（kernel 侧仍以 owner-check 拒绝跨用户 update，proxy 侧提前阻断以给出清晰指引）
  if (current.creator_user_id && current.creator_user_id !== resolved.userId) {
    return {
      success: false,
      error: "not_creator",
    };
  }

  // Step 2: 决定新 description + statusSuggestion
  let newDescription: string;
  let statusSuggestion: string | undefined;
  if (input.directDescription !== undefined) {
    // 有参数：直接替换，不调 LLM，也不出 status 建议
    newDescription = input.directDescription;
  } else {
    const draftCfg = resolveTaskDraftConfig(input.config);
    if ("error" in draftCfg) return { success: false, error: draftCfg.error };

    const draft = await generateTaskDraft(draftCfg.cfg, {
      mode: "update",
      hint: input.hint,
      recentMessages: input.recentMessages,
      currentTask: {
        title: current.title,
        description: current.description ?? "",
        status: current.status ?? "running",
      },
    });
    if (!draft.ok) return { success: false, error: `draft failed: ${draft.error}` };
    if (!draft.changed) {
      // LLM 判无改动 → 不写 pending，直接返 noUpdateNeeded
      return {
        success: true,
        noUpdateNeeded: true,
        taskId: current.task_id,
        title: current.title,
        description: normalizeDesc(current.description),
        status: current.status,
      };
    }
    newDescription = draft.description;
    statusSuggestion = draft.suggestedStatus;
  }

  // Step 3: 写 pending，等 confirm
  const key = pendingKeyOf(resolved, input.agentSource, input.sessionKey);
  const payload: PendingUpdatePayload = {
    kind: "update",
    draft: {
      taskId: current.task_id,
      description: newDescription,
      ...(statusSuggestion ? { statusSuggestion } : {}),
      ...(current.title ? { currentTitle: current.title } : {}),
      ...(current.status ? { currentStatus: current.status } : {}),
      ...(input.hint ? { hint: input.hint } : {}),
    },
  };
  setPending(key, payload);

  return {
    success: true,
    taskId: current.task_id,
    title: current.title,
    description: normalizeDesc(current.description),
    status: current.status,
    pending: {
      kind: "update",
      taskId: current.task_id,
      ...(current.title ? { currentTitle: current.title } : {}),
      ...(current.description ? { currentDescription: current.description } : {}),
      ...(current.status ? { currentStatus: current.status } : {}),
      draftDescription: newDescription,
      ...(statusSuggestion ? { statusSuggestion } : {}),
    },
  };
}

// ── 核心：confirm / cancel ────────────────────────────────────────────────

/**
 * 用户回复 `mem:create-task confirm` 或 `mem:update-task confirm` 时调用。
 * 根据 pending 里的 kind 分派：
 *   - create → doCreateAndBind（覆盖原绑定）
 *   - update → kernel updateTask（description + status 透传）
 * 落库成功后清 pending；失败时保留 pending（用户可重试）。
 */
export async function confirmPendingTaskAction(
  input: PendingActionInput,
): Promise<TaskFromSessionResult> {
  const resolved = resolveSession(input.sessionKey, input.agentSource, input.config);
  if ("error" in resolved) return { success: false, error: resolved.error };

  const key = pendingKeyOf(resolved, input.agentSource, input.sessionKey);
  const payload = getPending(key);
  if (!payload) {
    return { success: false, noPending: true, error: "no pending task action (may have expired or been cancelled)" };
  }

  if (payload.kind === "create") {
    const previousTaskId = payload.currentTaskId;
    const persisted = await doCreateAndBind(
      resolved,
      input,
      payload.draft.title,
      payload.draft.description,
    );
    if (!persisted.ok) {
      // 落库失败保留 pending 让用户重试
      return { success: false, error: persisted.error };
    }
    clearPending(key);
    const t = persisted.task;
    return {
      success: true,
      taskId: t.task_id,
      title: t.title,
      description: normalizeDesc(t.description),
      status: t.status,
      previousTaskId,
      ...(persisted.bindWarning ? { error: persisted.bindWarning } : {}),
    };
  }

  // update 分支
  const client = getClientFromResolved(resolved, input.config, input.spaceId);
  let updated: TaskEntity;
  try {
    updated = await client.updateTask(payload.draft.taskId, {
      description: payload.draft.description,
      ...(payload.draft.statusSuggestion ? { status: payload.draft.statusSuggestion } : {}),
    });
  } catch (err) {
    return {
      success: false,
      error: `metadata updateTask failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  clearPending(key);
  return {
    success: true,
    taskId: updated.task_id,
    title: updated.title,
    description: normalizeDesc(updated.description),
    status: updated.status,
  };
}

/**
 * 用户回复 `mem:create-task cancel` 或 `mem:update-task cancel` 时调用：
 * 清 pending，不落库。返回 cancelled=true 让命令层拼提示文案。
 */
export async function cancelPendingTaskAction(
  input: PendingActionInput,
): Promise<TaskFromSessionResult> {
  const resolved = resolveSession(input.sessionKey, input.agentSource, input.config);
  if ("error" in resolved) return { success: false, error: resolved.error };

  const key = pendingKeyOf(resolved, input.agentSource, input.sessionKey);
  const existed = clearPending(key);
  return { success: true, cancelled: existed };
}

// ── 内部：把 taskId 写回 sessionInfo ──────────────────────────────────────

async function bindTaskIdToSession(
  sessionKey: string,
  agentSource: string,
  taskId: string,
): Promise<void> {
  const compositeKey = `${agentSource}:${sessionKey}`;
  const store = getSessionStore();
  const state = store.get(compositeKey);
  if (!state || !state.sessionInfo) {
    throw new Error(`session ${sessionKey} vanished during bind`);
  }
  const newSessionInfo: SessionInfo = { ...state.sessionInfo, task_id: taskId };
  const newState: SessionInitState = { ...state, sessionInfo: newSessionInfo };
  await store.set(compositeKey, newState);
}

// ── HTTP Handlers ─────────────────────────────────────────────────────────

/**
 * POST /v3/session/create-task
 *
 * 面板前端 / e2e 用。body 形如：
 *   { session_key, agent_source, space_id, hint?, locked_title?, recent_messages?: [...] }
 * 若不带 recent_messages，会返 "no recent messages" —— 面板要主动传（从
 * conversation/query 拉最近 N 条）。
 */
export function createSessionCreateTaskHandler(config: ProxyConfig) {
  return async (c: Context): Promise<Response> => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ code: 40001, message: "Invalid JSON body", request_id: `create-task-${Date.now()}` }, 400);
    }

    const parsed = parseCreateTaskBody(body);
    if ("error" in parsed) {
      return c.json({ code: 40001, message: parsed.error, request_id: `create-task-${Date.now()}` }, 400);
    }

    const result = await createTaskFromSession({ ...parsed, config });
    return respond(c, result, "create-task");
  };
}

/**
 * POST /v3/session/update-task —— 同上，但走 update 分支。
 */
export function createSessionUpdateTaskHandler(config: ProxyConfig) {
  return async (c: Context): Promise<Response> => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ code: 40001, message: "Invalid JSON body", request_id: `update-task-${Date.now()}` }, 400);
    }

    const parsed = parseUpdateTaskBody(body);
    if ("error" in parsed) {
      return c.json({ code: 40001, message: parsed.error, request_id: `update-task-${Date.now()}` }, 400);
    }

    const result = await updateTaskFromSession({ ...parsed, config });
    return respond(c, result, "update-task");
  };
}

// ── HTTP body 解析 ────────────────────────────────────────────────────────

function parseCommonBody(
  body: Record<string, unknown>,
):
  | { sessionKey: string; agentSource: string; spaceId: string; hint?: string; recentMessages: MemCommandMessage[] }
  | { error: string } {
  const sessionKey = typeof body.session_key === "string" ? body.session_key : "";
  if (!sessionKey) return { error: "session_key is required" };
  const agentSource = typeof body.agent_source === "string" ? body.agent_source : "claude-code";
  const spaceId = typeof body.space_id === "string" ? body.space_id : "";
  const hint = typeof body.hint === "string" ? body.hint : undefined;

  const rawMsgs = Array.isArray(body.recent_messages) ? body.recent_messages : [];
  const recentMessages: MemCommandMessage[] = [];
  for (const m of rawMsgs) {
    if (!m || typeof m !== "object") continue;
    const obj = m as Record<string, unknown>;
    const role = obj.role;
    const content = obj.content;
    if (
      (role === "user" || role === "assistant" || role === "system") &&
      typeof content === "string" &&
      content.length > 0
    ) {
      recentMessages.push({ role, content });
    }
  }

  return { sessionKey, agentSource, spaceId, hint, recentMessages };
}

function parseCreateTaskBody(
  body: Record<string, unknown>,
):
  | {
      sessionKey: string;
      agentSource: string;
      spaceId: string;
      hint?: string;
      recentMessages: MemCommandMessage[];
      lockedTitle?: string;
    }
  | { error: string } {
  const base = parseCommonBody(body);
  if ("error" in base) return base;
  const lockedTitle = typeof body.locked_title === "string" && body.locked_title.trim().length > 0
    ? body.locked_title.trim()
    : undefined;
  return { ...base, ...(lockedTitle ? { lockedTitle } : {}) };
}

function parseUpdateTaskBody(
  body: Record<string, unknown>,
):
  | {
      sessionKey: string;
      agentSource: string;
      spaceId: string;
      hint?: string;
      recentMessages: MemCommandMessage[];
      directDescription?: string;
    }
  | { error: string } {
  const base = parseCommonBody(body);
  if ("error" in base) return base;
  const directDescription = typeof body.direct_description === "string"
    ? body.direct_description
    : undefined;
  return { ...base, ...(directDescription !== undefined ? { directDescription } : {}) };
}

function respond(c: Context, result: TaskFromSessionResult, tag: string): Response {
  const requestId = `${tag}-${Date.now()}`;
  if (!result.success) {
    const isNoPending = result.noPending === true;
    const isNotFound = result.error?.includes("not found") || result.error?.includes("no task bound");
    const status = isNoPending ? 404 : isNotFound ? 404 : 500;
    const code = isNoPending ? 40402 : isNotFound ? 40401 : 50001;
    return c.json(
      {
        code,
        message: result.error,
        request_id: requestId,
      },
      status,
    );
  }
  return c.json({
    code: 0,
    message: "ok",
    request_id: requestId,
    data: {
      task_id: result.taskId,
      title: result.title,
      description: result.description,
      status: result.status,
      no_update_needed: result.noUpdateNeeded ?? false,
      ...(result.pending ? { pending: result.pending } : {}),
      ...(result.cancelled !== undefined ? { cancelled: result.cancelled } : {}),
      ...(result.previousTaskId ? { previous_task_id: result.previousTaskId } : {}),
    },
  });
}

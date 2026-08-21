/**
 * Claude Code Session Initialization — 状态机入口.
 *
 * Flow:
 *   1. uninitialized → 内核拉 teams[], 发 `AskUserQuestion` form
 *   2. pending_team_select → 解析 JSON tool_result team 选择, 发 agent_select form
 *   3. pending_agent_select → 解析 agent (支持分页), 发 task_select form
 *   4. pending_task_select → 解析 task (支持分页), fetch 详情, register, inject
 *   5. initialized → 每次请求 strip + inject
 */

import type { SessionInitConfig } from "../../types.js";
import type {
  AgentDetail,
  SessionInitData,
  SessionInitState,
  SessionRegistrationData,
  TaskDetail,
  TaskInTeam,
  TeamOption,
} from "../types.js";
import { DEFAULT_TASK_LABEL } from "../types.js";
import { SessionStore } from "../store.js";
import { buildSessionInfo } from "../registrar.js";
import {
  injectSessionContextWithToggles,
  buildSessionContextBlockWithToggles,
} from "../context-injector.js";
import type { MetadataClient } from "../../meta/client.js";
import { resolvePresetIdentity, type PresetIdentity } from "../preset.js";

import { buildFormResponse, FormData, MORE_LABEL } from "./form.js";
import { computePagination } from "./pagination.js";
import { emitSessionInitTelemetryIfCompleted } from "../init-telemetry.js";
import {
  extractFromOptionText,
  extractTeamFromOptionText,
  extractTaskFromOptionText,
  extractAssetConfirm,
  extractStructured,
  resolveAgent,
  resolveTask,
  BYPASS_MARKER,
  MORE_MARKER,
} from "./extractor.js";
import { getLastUserMessageText } from "./cleaner.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SessionRequestContext {
  stream: boolean;
  modelId: string;
  /**
   * Wire protocol of the incoming request. Anthropic keeps the system prompt
   * on `body.system` (not in `messages`), so session-context injection cannot
   * ride on the returned `messages` array — the caller has to apply the
   * returned {@link SessionInitResult.systemAppend} to `body.system` itself.
   * When omitted, treated as "openai" (historical default; messages-carried
   * injection stays effective).
   */
  protocol?: "openai" | "anthropic";
}

export interface SessionInitResult {
  intercepted: boolean;
  response?: Response;
  messages?: Record<string, unknown>[];
  sessionInfo?: import("../types.js").SessionInfo | null;
  justRegistered?: boolean;
  agentDetail?: AgentDetail | null;
  taskDetail?: TaskDetail | null;
  bypassed?: boolean;
  /**
   * Anthropic-only: the pre-built `<session_context>` string that MUST be
   * appended to `body.system` by the caller (see {@link SessionRequestContext.protocol}).
   * `null` / omitted = nothing to append (either not Anthropic, or agent+task
   * both empty, or both toggles off). OpenAI callers can ignore this field —
   * the injection has already been performed inside `messages`.
   */
  systemAppend?: string | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

type MessageArr = Record<string, unknown>[];

function isFreshCCConversation(messages: MessageArr): boolean {
  let userCount = 0;
  for (const m of messages) {
    const role = (m.role as string) ?? "";
    if (role === "assistant" && !containsSessionInitMarker(m)) return false;
    if (role === "tool") return false;
    if (role === "user") userCount++;
    if (userCount > 5) return false;
  }
  return userCount <= 5;
}

function containsSessionInitMarker(msg: Record<string, unknown>): boolean {
  const content = msg.content;
  if (!Array.isArray(content)) return false;
  for (const block of content as any[]) {
    if (block.type === "tool_use" && typeof block.id === "string" && block.id.startsWith("toolu_cc_session_init_")) {
      return true;
    }
  }
  return false;
}

async function fetchTeamsAndAgents(
  userId: string,
  config: SessionInitConfig,
  metadataClient: MetadataClient,
): Promise<{ teams: TeamOption[] }> {
  const teamsRaw = await metadataClient.listTeams(userId);
  const teamResults = await Promise.all(
    teamsRaw.map(async (t) => {
      const [agentsRaw, tasksRaw] = await Promise.all([
        // Agents are scoped to (team, owner) — each user only sees the agents
        // they created within the team. Tasks remain team-wide (unchanged).
        metadataClient.listAgents(t.team_id, userId),
        metadataClient.listTasks(t.team_id),
      ]);
      const tasks: TaskInTeam[] = tasksRaw.map((tk) => ({
        task_id: tk.task_id,
        task_name: tk.title,
      }));
      // 源头注入：defaultTaskId 配置了就作为"本次不关联任务"虚拟条目排在真
      // task 之前。下游 form/extractor/init 一个字节都不用改 —— 分页 total
      // 和 auto-select 级联唯一真相都是 tasks.length。用户选中虚拟条目 →
      // completeRegistration 用 defaultTaskId 上报 → getTask 会 404 但
      // Promise.allSettled 兜掉，taskDetail=null → 不注入 [Task]，正好是
      // "跳过 task 但保留 agent 关联"的语义。
      if (config.defaultTaskId) {
        tasks.unshift({
          task_id: config.defaultTaskId,
          task_name: DEFAULT_TASK_LABEL,
          isDefault: true,
        });
      }
      return {
        team_id: t.team_id,
        team_name: t.name,
        agents: agentsRaw.map((a) => ({
          agent_id: a.agent_id,
          agent_name: a.name,
          description: a.description ?? undefined,
        })),
        tasks,
      };
    }),
  );
  return { teams: teamResults };
}

function findTeamIdForAgent(teams: TeamOption[], agentId: string): string | undefined {
  for (const team of teams) {
    if (team.agents.some((a) => a.agent_id === agentId)) return team.team_id;
  }
  return undefined;
}

/**
 * Return the single agent_id on the given page when that page has exactly 1
 * agent AND is the last page — meaning the user would be forced to pick the
 * only real option. If so, we auto-select and skip rendering the form.
 *
 * 历史背景：旧分页策略（`3 每页 + MORE`）在 total mod 3 == 1（4、7、10…）时
 * 末页会剩 1 个，用户点 MORE 后被这个函数直接 auto-select，体验很怪。现在
 * pagination.ts 已经把 total ≤ 4 改为单页展示、total > 4 末页 solo 时把倒
 * 数第二页匀 1 个过来，正常路径下不会再触发本函数的 solo 分支。
 *
 * 保留原因：防御性兜底 —— pagination.ts 若将来改回旧策略或有 bug，本函数
 * 仍能防止渲染 1-option form；另外 total === 1 的首末页依然会命中（那个场
 * 景 init.ts 上游其实已经 advanceFromAgentPicked auto-select 掉了，但双保
 * 险无害）。
 */
function autoSelectSoloAgent(team: TeamOption | undefined, pageIndex: number): string | null {
  if (!team) return null;
  const page = computePagination(team.agents.length, pageIndex);
  if (page.isLastPage && page.count === 1) {
    return team.agents[page.start].agent_id;
  }
  return null;
}

/** Symmetric to {@link autoSelectSoloAgent} for tasks. */
function autoSelectSoloTask(team: TeamOption | undefined, pageIndex: number): string | null {
  if (!team) return null;
  const page = computePagination(team.tasks.length, pageIndex);
  if (page.isLastPage && page.count === 1) {
    return team.tasks[page.start].task_id;
  }
  return null;
}

/**
 * Given a chosen (or auto-selected) team, decide the next step in the flow
 * and either register (all auto), enter task_select, or enter agent_select.
 * Consolidates the "user picked team → what now" logic so both the
 * asset_confirm shortcut (single team) and the pending_team_select handler
 * apply the same auto-select semantics.
 */
async function advanceFromTeamPicked(
  team: TeamOption,
  cachedTeams: TeamOption[],
  compositeKey: string,
  sessionKey: string,
  userId: string | null,
  state: SessionInitState,
  config: SessionInitConfig,
  store: SessionStore,
  reqCtx: SessionRequestContext,
  strippedMsgs: MessageArr,
  metadataClient: MetadataClient | undefined,
  userKey: string | undefined,
  spaceId: string | undefined,
): Promise<SessionInitResult> {
  const teamId = team.team_id;

  if (team.agents.length === 0) {
    console.warn(
      `[session-init:cc] session=${compositeKey} team=${teamId} has no agents → bypass`,
    );
    await store.set(compositeKey, {
      ...state,
      status: "initialized",
      selectedTeamId: teamId,
      cachedTeams,
      bypassed: true,
    } as SessionInitState);
    return { intercepted: false, bypassed: true };
  }

  // Only 1 agent — pick it, then decide task step.
  if (team.agents.length === 1) {
    const agentId = team.agents[0].agent_id;
    console.log(
      `[session-init:cc] session=${compositeKey} team=${teamId} auto-select single agent=${agentId}`,
    );
    return advanceFromAgentPicked(
      team, agentId, cachedTeams, compositeKey, sessionKey, userId,
      { ...state, selectedTeamId: teamId },
      config, store, reqCtx, strippedMsgs, metadataClient, userKey, spaceId,
    );
  }

  // ≥2 agents — render agent form. Store pending_agent_select first.
  await store.set(compositeKey, {
    ...state,
    status: "pending_agent_select",
    selectedTeamId: teamId,
    cachedTeams,
    attemptCount: 0,
    agentPageIndex: 0,
  });
  console.log(
    `[session-init:cc] session=${compositeKey} team=${teamId} → pending_agent_select (agents=${team.agents.length})`,
  );
  const fd: FormData = {
    teams: cachedTeams,
    stage: "agent_select",
    selectedTeamId: teamId,
    pageIndex: 0,
    stream: reqCtx.stream,
    modelId: reqCtx.modelId,
  };
  return { intercepted: true, response: buildFormResponse(fd) };
}

/**
 * Given a chosen (or auto-selected) agent within a team, decide whether to
 * register immediately (0 or 1 task) or enter task_select (≥2 tasks).
 */
async function advanceFromAgentPicked(
  team: TeamOption,
  agentId: string,
  cachedTeams: TeamOption[],
  compositeKey: string,
  sessionKey: string,
  userId: string | null,
  state: SessionInitState,
  config: SessionInitConfig,
  store: SessionStore,
  reqCtx: SessionRequestContext,
  strippedMsgs: MessageArr,
  metadataClient: MetadataClient | undefined,
  userKey: string | undefined,
  spaceId: string | undefined,
): Promise<SessionInitResult> {
  const teamId = team.team_id;

  // 0 tasks → bypass (统一契约：team+agent+task 缺一不注入)。
  //   历史行为是"注册但 task_id=undefined，只注入 [Agent] 段"，现改为完全 bypass。
  // 1 task → auto-select，直接推进到 completeRegistration。
  if (team.tasks.length === 0) {
    console.log(
      `[session-init:cc] session=${compositeKey} team=${teamId} agent=${agentId} has 0 tasks → bypass`,
    );
    await store.set(compositeKey, {
      ...state,
      status: "initialized",
      selectedTeamId: teamId,
      selectedAgentId: agentId,
      cachedTeams,
      sessionInfo: null,
      agentDetail: null,
      taskDetail: null,
      bypassed: true,
    } as SessionInitState);
    return { intercepted: false, bypassed: true };
  }
  if (team.tasks.length === 1) {
    const taskId = team.tasks[0].task_id;
    console.log(
      `[session-init:cc] session=${compositeKey} agent=${agentId} auto-select single task=${taskId}`,
    );
    return completeRegistration(
      { agent_id: agentId, task_id: taskId },
      state, cachedTeams, teamId, compositeKey, sessionKey, userId,
      config, store, reqCtx, strippedMsgs, metadataClient, userKey, spaceId,
    );
  }

  // ≥2 tasks — render task form.
  await store.set(compositeKey, {
    ...state,
    status: "pending_task_select",
    selectedTeamId: teamId,
    selectedAgentId: agentId,
    cachedTeams,
    attemptCount: 0,
    agentPageIndex: 0,
  });
  console.log(
    `[session-init:cc] session=${compositeKey} agent=${agentId} → pending_task_select (tasks=${team.tasks.length})`,
  );
  const fd: FormData = {
    teams: cachedTeams,
    stage: "task_select",
    selectedTeamId: teamId,
    pageIndex: 0,
    stream: reqCtx.stream,
    modelId: reqCtx.modelId,
  };
  return { intercepted: true, response: buildFormResponse(fd) };
}

/**
 * Assemble the registration payload for a resolved (agent, task). Returns
 * `null` when the agent cannot be matched to any team in the cached list —
 * the caller must bypass session init in that case (there is no
 * `defaultTeamId` fallback any more).
 */
function buildRegistrationData(
  extracted: SessionInitData,
  cachedTeams: TeamOption[],
  sessionId: string,
  userId: string,
): SessionRegistrationData | null {
  const teamId = findTeamIdForAgent(cachedTeams, extracted.agent_id);
  if (!teamId) return null;
  return {
    team_id: teamId,
    user_id: userId,
    agent_id: extracted.agent_id,
    task_id: extracted.task_id,
    session_id: sessionId,
  };
}

interface ArtifactsAndContextResult {
  messages: MessageArr;
  /**
   * Anthropic-only: pre-built `<session_context>` string the HTTP handler
   * must append to `body.system`. Non-null only when `protocol === "anthropic"`
   * and at least one of agent/task would inject. See
   * {@link SessionInitResult.systemAppend}.
   */
  systemAppend: string | null;
}

function applyArtifactsAndContext(
  messages: MessageArr,
  agentDetail: AgentDetail | null | undefined,
  taskDetail: TaskDetail | null | undefined,
  sessionKey: string,
  config: SessionInitConfig,
  protocol: "openai" | "anthropic" | undefined,
): ArtifactsAndContextResult {
  // 曾经这里会按 config.keepInitArtifacts 决定要不要 stripInitArtifacts,
  // 现在**永远保留** session_init form 交互, 不做任何删除。

  // Anthropic keeps the system prompt on body.system, not in messages, so the
  // block is handed back through `systemAppend` and the handler applies it at
  // the boundary. On OpenAI (and when protocol is omitted, for callers/tests
  // that don't set it), we retain the historical messages-based injection.
  let out: MessageArr;
  let systemAppend: string | null = null;
  if (protocol === "anthropic") {
    systemAppend = buildSessionContextBlockWithToggles(agentDetail, taskDetail, config, sessionKey);
    out = messages;
  } else {
    out = injectSessionContextWithToggles(messages, agentDetail, taskDetail, config, sessionKey) as MessageArr;
  }

  const injected = out;
  const injectedChanged = protocol === "anthropic" ? systemAppend !== null : injected !== messages;
  if (injectedChanged) {
    const finalRoles = (injected as unknown[]).map((m: any) => m.role);
    console.log(
      `[session-init:cc] session=${sessionKey} processed: ${messages.length} msgs, ` +
        `ctx=${agentDetail ? "Y" : "N"}/${taskDetail ? "Y" : "N"} ` +
        `protocol=${protocol ?? "openai"} systemAppend=${systemAppend ? "Y" : "N"} final=[${finalRoles.join(",")}]`,
    );
  }
  return { messages: injected, systemAppend };
}

async function completeRegistration(
  resolved: SessionInitData,
  state: SessionInitState,
  cachedTeams: TeamOption[],
  selectedTeamId: string | undefined,
  compositeKey: string,
  sessionKey: string,
  userId: string | null,
  config: SessionInitConfig,
  store: SessionStore,
  reqCtx: SessionRequestContext,
  strippedMsgs: MessageArr,
  metadataClient?: MetadataClient,
  userKey?: string,
  spaceId?: string,
): Promise<SessionInitResult> {
  const regUserId = (state as any).userId || userId;
  if (!regUserId) {
    console.warn(
      `[session-init:cc] session=${compositeKey} no user_id available → bypass`,
    );
    await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
    return { intercepted: false, bypassed: true };
  }
  // 新增契约：只有 team + agent + task 三者齐全才注入。task_id 缺失一律 bypass —
  // 覆盖 0-task team、header 只带 team+agent、debugForceIdentity 不带 task 等场景。
  // 所有走到这里的调用方都必须先解析出 task_id；auto-select 级联负责在 tasks.length===1
  // 时自动选中，tasks.length===0 由 advanceFromAgentPicked 直接 bypass 不会到这里。
  // 这里做兜底防御，防止将来新增调用方漏传 task_id。
  if (!resolved.task_id) {
    console.warn(
      `[session-init:cc] session=${compositeKey} agent=${resolved.agent_id} without task → bypass (task required for injection)`,
    );
    await store.set(compositeKey, {
      status: "initialized",
      keyId: sessionKey,
      startedAt: state.startedAt,
      attemptCount: state.attemptCount,
      userId: regUserId,
      cachedTeams,
      selectedTeamId,
      sessionInfo: null,
      agentDetail: null,
      taskDetail: null,
      bypassed: true,
    } as SessionInitState);
    return { intercepted: false, bypassed: true };
  }
  const regData = buildRegistrationData(resolved, cachedTeams, sessionKey, regUserId);
  if (!regData) {
    console.warn(
      `[session-init:cc] session=${compositeKey} agent=${resolved.agent_id} not bound to any team → bypass`,
    );
    await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
    return { intercepted: false, bypassed: true };
  }

  let agentDetail: AgentDetail | null = null;
  let taskDetail: TaskDetail | null = null;

  if (metadataClient) {
    // 当 task_id 是 defaultTaskId（虚拟值）时，跳过 getTask 调用——
    // 内核不存在该 task，调用只会 404 产生无意义的 warn。
    const shouldFetchTask = regData.task_id && regData.task_id !== config.defaultTaskId;
    const [agentRes, taskRes] = await Promise.allSettled([
      metadataClient.getAgent(resolved.agent_id).then((a) => ({
        id: a.agent_id,
        name: a.name,
        description: a.description ?? undefined,
        prompt: a.prompt ?? undefined,
      })),
      shouldFetchTask
        ? metadataClient.getTask(regData.task_id!).then((t) => ({
            id: t.task_id,
            name: t.title,
            description: t.description ?? undefined,
          }))
        : Promise.resolve(null),
    ]);
    if (agentRes.status === "fulfilled") agentDetail = agentRes.value;
    else console.warn(`[session-init:cc] getAgent failed: ${String(agentRes.reason)}`);
    if (taskRes.status === "fulfilled") taskDetail = taskRes.value;
    else console.warn(`[session-init:cc] getTask failed: ${String(taskRes.reason)}`);
  }

  const sessionInfo = buildSessionInfo(regData, userKey, spaceId);
  console.log(
    `[session-init:cc] session=${compositeKey} → initialized ` +
      `agent=${resolved.agent_id} task=${regData.task_id ?? "-"} team=${regData.team_id} user=${sessionInfo.user_id}`,
  );

  // Fire-and-forget: 记录一条 (team, task, agent, user) 参与日志，供看板"实际参与"
  // 分区展示。bypass 路径已在上方 return，走不到这里；debug forceIdentity 路径也
  // 走 append —— 用于本地 / e2e 联调验证。失败仅 warn，不阻断 session 注入路径。
  if (
    metadataClient &&
    typeof metadataClient.appendParticipationLog === "function" &&
    regData.task_id
  ) {
    metadataClient
      .appendParticipationLog({
        team_id: regData.team_id,
        task_id: regData.task_id,
        agent_id: regData.agent_id,
        user_id: regData.user_id,
        source: "context_proxy:claude-code",
      })
      .catch((err: unknown) => {
        console.warn(
          `[session-init:cc] participation-log append failed for session=${compositeKey}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  const nextState: SessionInitState = {
    status: "initialized",
    keyId: sessionKey,
    startedAt: state.startedAt,
    attemptCount: state.attemptCount,
    sessionInfo,
    userId: regUserId,
    cachedTeams: state.cachedTeams,
    selectedTeamId: state.selectedTeamId,
    agentDetail,
    taskDetail,
  };
  await store.set(compositeKey, nextState);

  const out = applyArtifactsAndContext(strippedMsgs, agentDetail, taskDetail, compositeKey, config, reqCtx.protocol);
  return {
    intercepted: false,
    messages: out.messages,
    systemAppend: out.systemAppend,
    sessionInfo,
    justRegistered: true,
    agentDetail,
    taskDetail,
  };
}

// ── Main Handler ───────────────────────────────────────────────────────────────

/**
 * 顶层入口 wrapper：装饰 handleSessionInitInner，在完成后发一条埋点
 * （仅当 prev !== initialized && after === initialized 时）。
 *
 * 埋点装饰绝不改动状态机；失败/异常静默，业务链路零感知。
 * 详见 docs/design/2026-08-03-internal-usage-telemetry-plan.md §7.2。
 */
export async function handleSessionInit(
  sessionKey: string,
  userId: string | null,
  messages: MessageArr,
  config: SessionInitConfig,
  store: SessionStore,
  reqCtx: SessionRequestContext,
  metadataClient?: MetadataClient,
  userKey?: string,
  spaceId?: string,
  presetIdentity?: PresetIdentity,
): Promise<SessionInitResult> {
  const compositeKey = `claude-code:${sessionKey}`;
  const prevStatus = store.get(compositeKey)?.status ?? "uninitialized";
  try {
    return await handleSessionInitInner(
      sessionKey, userId, messages, config, store, reqCtx,
      metadataClient, userKey, spaceId, presetIdentity,
    );
  } finally {
    // 无论正常/异常返回都尝试发一次埋点；装饰器内部自吞异常。
    emitSessionInitTelemetryIfCompleted({
      store,
      compositeKey,
      prevStatus,
      agentSource: "claude-code",
    });
  }
}

async function handleSessionInitInner(
  sessionKey: string,
  userId: string | null,
  messages: MessageArr,
  config: SessionInitConfig,
  store: SessionStore,
  reqCtx: SessionRequestContext,
  metadataClient?: MetadataClient,
  userKey?: string,
  spaceId?: string,
  presetIdentity?: PresetIdentity,
): Promise<SessionInitResult> {
  const compositeKey = `claude-code:${sessionKey}`;
  if (sessionKey === "unknown" || !sessionKey) return { intercepted: false };

  const state = store.get(compositeKey);
  // 曾经这里会按 config.keepInitArtifacts 决定要不要 stripInitArtifacts,
  // 现在**永远保留** session_init form 交互, 不做任何删除。变量名 stripped
  // 保留只为下游调用点不用大改, 语义上就是 messages 本身。
  const stripped = messages;

  // ── DEBUG BYPASS ─────────────────────────────────────────────────────────
  // When `sessionInit.debugForceIdentity` is set (developer/e2e config),
  // register the session with the forced identity on first-touch and skip
  // the entire interactive form flow. Purely for local testing.
  if (
    config.debugForceIdentity &&
    (!state || state.status !== "initialized")
  ) {
    const forced = config.debugForceIdentity;
    // Debug path only — real production sessions never reach here.
    const forcedUserId = userId || "u_debug";
    console.log(
      `[session-init:cc] session=${compositeKey} DEBUG bypass — force identity ` +
        `team=${forced.team_id} agent=${forced.agent_id} task=${forced.task_id ?? "-"} user=${forcedUserId}`,
    );
    return completeRegistration(
      { agent_id: forced.agent_id, task_id: forced.task_id },
      // Seed a minimal state so completeRegistration has the required shape.
      (state ?? {
        status: "uninitialized",
        keyId: sessionKey,
        startedAt: Date.now(),
        attemptCount: 0,
        userId: forcedUserId,
        cachedTeams: [{
          team_id: forced.team_id,
          team_name: forced.team_id,
          agents: [{ agent_id: forced.agent_id, agent_name: forced.agent_id }],
          tasks: forced.task_id
            ? [{ task_id: forced.task_id, task_name: forced.task_id }]
            : [],
        }],
        selectedTeamId: forced.team_id,
      }) as SessionInitState,
      // completeRegistration needs cachedTeams to find team_id for agent
      [{
        team_id: forced.team_id,
        team_name: forced.team_id,
        agents: [{ agent_id: forced.agent_id, agent_name: forced.agent_id }],
        tasks: forced.task_id
          ? [{ task_id: forced.task_id, task_name: forced.task_id }]
          : [],
      }],
      forced.team_id,
      compositeKey,
      sessionKey,
      forcedUserId,
      config,
      store,
      reqCtx,
      stripped,
      metadataClient,
      userKey,
      spaceId,
    );
  }

  if ((!state || state.status === "uninitialized") && !isFreshCCConversation(messages)) {
    console.warn(
      `[session-init:cc] session=${compositeKey} state lost but conversation has history, skipping init`,
    );
    return { intercepted: false };
  }

  // ── Case 1: Uninitialized → 先弹 asset_confirm 对话框 ───────────────────
  if (!state || state.status === "uninitialized") {
    console.log(`[session-init:cc] session=${compositeKey} state=${state?.status ?? "none"} → uninitialized`);
    if (!userId) {
      console.warn(
        `[session-init:cc] session=${compositeKey} no userId, bypassing`,
      );
      await store.set(compositeKey, {
        status: "initialized",
        keyId: sessionKey,
        startedAt: Date.now(),
        attemptCount: 0,
        sessionInfo: null,
        agentDetail: null,
        taskDetail: null,
        bypassed: true,
      } as SessionInitState);
      return { intercepted: false, bypassed: true };
    }
    if (!metadataClient) {
      console.warn(
        `[session-init:cc] session=${compositeKey} no metadataClient, bypassing`,
      );
      await store.set(compositeKey, {
        status: "initialized",
        keyId: sessionKey,
        startedAt: Date.now(),
        attemptCount: 0,
        sessionInfo: null,
        agentDetail: null,
        taskDetail: null,
        bypassed: true,
      } as SessionInitState);
      return { intercepted: false, bypassed: true };
    }

    let teams: TeamOption[];
    try {
      const cfg = await fetchTeamsAndAgents(userId, config, metadataClient);
      teams = cfg.teams;
    } catch (err) {
      console.warn(
        `[session-init:cc] session=${compositeKey} kernel unavailable for user=${userId}, bypassing: ${err instanceof Error ? err.message : String(err)}`,
      );
      await store.set(compositeKey, {
        status: "initialized",
        keyId: sessionKey,
        startedAt: Date.now(),
        attemptCount: 0,
        userId,
        sessionInfo: null,
        agentDetail: null,
        taskDetail: null,
        bypassed: true,
      } as SessionInitState);
      return { intercepted: false, bypassed: true };
    }

    const totalAgents = teams.reduce((acc, t) => acc + t.agents.length, 0);
    if (totalAgents === 0) {
      console.warn(
        `[session-init:cc] session=${compositeKey} user=${userId} has no active agents, bypassing`,
      );
      await store.set(compositeKey, {
        status: "initialized",
        keyId: sessionKey,
        startedAt: Date.now(),
        attemptCount: 0,
        userId,
        cachedTeams: teams,
        sessionInfo: null,
        agentDetail: null,
        taskDetail: null,
        bypassed: true,
      } as SessionInitState);
      return { intercepted: false, bypassed: true };
    }

    // ── Header-driven pre-selection: skip forms when identity is provided ──
    if (presetIdentity && config.headerAutoSelect?.enabled) {
      const pr = resolvePresetIdentity(teams, presetIdentity);

      if (pr.hadMismatch) {
        if (config.headerAutoSelect.onMismatch === "bypass") {
          console.warn(`[session-init:cc] session=${compositeKey} preset mismatch → bypass`);
          await store.set(compositeKey, {
            status: "initialized",
            keyId: sessionKey,
            startedAt: Date.now(),
            attemptCount: 0,
            userId,
            cachedTeams: teams,
            sessionInfo: null,
            agentDetail: null,
            taskDetail: null,
            bypassed: true,
          } as SessionInitState);
          return { intercepted: false, bypassed: true };
        }
        console.warn(`[session-init:cc] session=${compositeKey} preset mismatch → fallback to form`);
        // fall through to the normal asset_confirm flow below
      } else if (pr.canRegister) {
        // team + agent resolved → register directly (task optional)
        console.log(
          `[session-init:cc] session=${compositeKey} preset hit team=${pr.teamId} agent=${pr.agentId} task=${pr.taskId ?? "-"} → register directly`,
        );
        const seedState: SessionInitState = {
          status: "uninitialized",
          keyId: sessionKey,
          startedAt: Date.now(),
          attemptCount: 0,
          userId,
          cachedTeams: teams,
          selectedTeamId: pr.teamId,
        };
        return completeRegistration(
          { agent_id: pr.agentId!, task_id: pr.taskId },
          seedState, teams, pr.teamId, compositeKey, sessionKey, userId,
          config, store, reqCtx, stripped, metadataClient, userKey, spaceId,
        );
      } else if (pr.teamId) {
        // Only team resolved → auto-select cascade from that team (skip
        // asset_confirm + team_select). advanceFromTeamPicked also handles
        // the "1 agent + 1 task" full auto-register case.
        const presetTeam = teams.find((t) => t.team_id === pr.teamId);
        if (presetTeam) {
          console.log(
            `[session-init:cc] session=${compositeKey} preset team=${pr.teamId} → advance`,
          );
          const seedState: SessionInitState = {
            status: "uninitialized",
            keyId: sessionKey,
            startedAt: Date.now(),
            attemptCount: 0,
            userId,
            cachedTeams: teams,
            selectedTeamId: pr.teamId,
          };
          return advanceFromTeamPicked(
            presetTeam, teams, compositeKey, sessionKey, userId,
            seedState, config, store, reqCtx, stripped,
            metadataClient, userKey, spaceId,
          );
        }
        // preset team not in cached list → fall through to normal asset_confirm flow
      }
    }

    await store.set(compositeKey, {
      status: "pending_asset_confirm",
      keyId: sessionKey,
      startedAt: Date.now(),
      attemptCount: 0,
      userId,
      cachedTeams: teams,
    });
    console.log(
      `[session-init:cc] session=${compositeKey} user=${userId} → pending_asset_confirm (teams=${teams.length})`,
    );
    const fd: FormData = {
      teams,
      stage: "asset_confirm",
      stream: reqCtx.stream,
      modelId: reqCtx.modelId,
    };
    return { intercepted: true, response: buildFormResponse(fd) };
  }

  // ── Case 1.25: Awaiting asset_confirm ────────────────────────────────────
  if (state.status === "pending_asset_confirm") {
    const lastUserText = getLastUserMessageText(messages);
    const choice = extractAssetConfirm(lastUserText);
    console.log(`[session-init:cc:debug] session=${compositeKey} pending_asset_confirm lastUserText=${JSON.stringify(lastUserText.slice(0,500))} choice=${choice}`);

    if (choice === false) {
      // bypass: 用户明确选择"不关联" —— 保留 form 对话原样，不删。
      await store.set(compositeKey, {
        status: "initialized",
        keyId: sessionKey,
        startedAt: state.startedAt,
        attemptCount: state.attemptCount,
        userId: state.userId,
        cachedTeams: state.cachedTeams,
        selectedTeamId: undefined,
        agentDetail: null,
        taskDetail: null,
        sessionInfo: null,
        bypassed: true,
      } as SessionInitState);
      console.log(`[session-init:cc] session=${compositeKey} user chose no-asset → bypass`);
      return { intercepted: false, messages: messages as Record<string, unknown>[], bypassed: true };
    }

    if (choice === true) {
      const teams = state.cachedTeams ?? [];

      // Auto-select cascade: 只有 1 个 team 时不弹 team form，直接推进到
      // agent 阶段（agent 内部再判断是否 auto-select）。这样"1 team + 1 agent
      // + 1 task"的最小配置在 asset_confirm=是 之后不再弹任何额外表单。
      if (teams.length === 1) {
        console.log(
          `[session-init:cc] session=${compositeKey} auto-select single team=${teams[0].team_id}`,
        );
        return advanceFromTeamPicked(
          teams[0], teams, compositeKey, sessionKey, userId,
          { ...state, cachedTeams: teams } as SessionInitState,
          config, store, reqCtx, stripped, metadataClient, userKey, spaceId,
        );
      }

      // ≥2 teams → 弹 team_select 表单。
      await store.set(compositeKey, {
        status: "pending_team_select",
        keyId: sessionKey,
        startedAt: state.startedAt,
        attemptCount: 0,
        userId: state.userId,
        cachedTeams: teams,
      });
      console.log(
        `[session-init:cc] session=${compositeKey} → pending_team_select (teams=${teams.length})`,
      );
      const fd: FormData = {
        teams,
        stage: "team",
        stream: reqCtx.stream,
        modelId: reqCtx.modelId,
      };
      return { intercepted: true, response: buildFormResponse(fd) };
    }

    // 未识别 → bypass (保留 form 对话原样)
    console.warn(`[session-init:cc] session=${compositeKey} asset-confirm unrecognized, bypassing`);
    await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
    return { intercepted: false, messages: messages as Record<string, unknown>[], bypassed: true };
  }

  // ── Case 1.5: Awaiting team selection ─────────────────────────────────────
  if (state.status === "pending_team_select") {
    const lastUserText = getLastUserMessageText(messages);
    const cachedTeams = state.cachedTeams ?? [];
    const teamId = extractTeamFromOptionText(lastUserText, cachedTeams);

    if (teamId && teamId !== BYPASS_MARKER) {
      const team = cachedTeams.find((t) => t.team_id === teamId);
      if (team) {
        // Delegate to shared auto-select cascade — same path as the
        // asset_confirm shortcut, so "1 agent + 1 task" still fully auto-picks.
        return advanceFromTeamPicked(
          team, cachedTeams, compositeKey, sessionKey, userId,
          state, config, store, reqCtx, stripped,
          metadataClient, userKey, spaceId,
        );
      }
      // Extracted teamId not in cached list — treat as unrecognized.
    }

    console.warn(`[session-init:cc] session=${compositeKey} team-select unrecognized, bypassing`);
    // bypass: 保留 form 对话原样, 不删。
    await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
    return { intercepted: false, messages: messages as Record<string, unknown>[], bypassed: true };
  }

  // ── Case 2: Awaiting agent selection ─────────────────────────────────────
  if (state.status === "pending_agent_task" || state.status === "pending_form" || state.status === "pending_agent_select") {
    const lastUserText = getLastUserMessageText(messages);
    const cachedTeams = state.cachedTeams ?? [];
    const selectedTeamId = state.selectedTeamId;
    const team = cachedTeams.find((t) => t.team_id === selectedTeamId);

    // LLM-based extraction fallback was removed — engineered paths only.
    // If neither the option-text match nor the structured parser recognises
    // the reply, the caller falls through to the retry / bypass branch.
    let extracted = extractFromOptionText(lastUserText, cachedTeams, selectedTeamId)
      ?? extractStructured(lastUserText);

    if (extracted && extracted.agent_id === MORE_MARKER) {
      const currentPage = state.agentPageIndex ?? 0;
      const nextPage = currentPage + 1;
      // 从 pagination.ts 拿 totalPages 判越界，与 form.ts 的切片同一算法。
      const totalPages = computePagination(team?.agents.length ?? 0, 0).totalPages;
      const safeNextPage = nextPage > totalPages - 1 ? 0 : nextPage;

      // 防御性：pagination.ts 已保证正常路径不会出现 solo 末页，但双保险
      // 兜住 —— 万一分页器改动出 bug，用户仍不会被 auto-select 惊到（会走
      // 到这里 auto-select，从旧行为角度也是可接受的降级）。
      const soloOnNext = autoSelectSoloAgent(team, safeNextPage);
      if (soloOnNext) {
        console.log(
          `[session-init:cc] session=${compositeKey} MORE landed on solo page ${safeNextPage} → auto-select agent=${soloOnNext}`,
        );
        return advanceFromAgentPicked(
          team!, soloOnNext, cachedTeams, compositeKey, sessionKey, userId,
          state, config, store, reqCtx, stripped, metadataClient, userKey, spaceId,
        );
      }

      await store.set(compositeKey, { ...state, agentPageIndex: safeNextPage });
      console.log(
        `[session-init:cc] session=${compositeKey} agent page ${currentPage} → ${safeNextPage}`,
      );
      const fd: FormData = {
        teams: cachedTeams,
        stage: "agent_select",
        selectedTeamId,
        pageIndex: safeNextPage,
        stream: reqCtx.stream,
        modelId: reqCtx.modelId,
      };
      return { intercepted: true, response: buildFormResponse(fd) };
    }

    if (extracted && extracted.agent_id === BYPASS_MARKER) {
      const bypassState: SessionInitState = {
        status: "initialized",
        keyId: sessionKey,
        startedAt: state.startedAt,
        attemptCount: 0,
        userId: state.userId,
        cachedTeams: cachedTeams,
        selectedTeamId: selectedTeamId,
        bypassed: true,
      } as SessionInitState;
      await store.set(compositeKey, bypassState);
      console.log(`[session-init:cc] session=${compositeKey} user chose skip-agent → bypass`);
      return { intercepted: false, messages: stripped as Record<string, unknown>[], bypassed: true };
    }

    if (extracted && extracted.agent_id) {
      const resolvedAgentId = resolveAgent(extracted.agent_id, cachedTeams, selectedTeamId);
      if (!team) {
        // Extremely unlikely (selectedTeamId set but not in cachedTeams).
        console.warn(
          `[session-init:cc] session=${compositeKey} team ${selectedTeamId} not in cache → bypass`,
        );
        await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
        return { intercepted: false, bypassed: true };
      }
      // Delegate to shared cascade — auto-selects the sole task when tasks.length === 1.
      return advanceFromAgentPicked(
        team, resolvedAgentId, cachedTeams, compositeKey, sessionKey, userId,
        state, config, store, reqCtx, stripped, metadataClient, userKey, spaceId,
      );
    }

    console.warn(`[session-init:cc] session=${compositeKey} agent-select unrecognized, bypassing`);
    // bypass: 保留 form 对话原样, 不删。
    await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
    return { intercepted: false, messages: messages as Record<string, unknown>[], bypassed: true };
  }

  // ── Case 2.5: Awaiting task selection ─────────────────────────────────────
  if (state.status === "pending_task_select") {
    const lastUserText = getLastUserMessageText(messages);
    const cachedTeams = state.cachedTeams ?? [];
    const selectedTeamId = state.selectedTeamId;
    const team = cachedTeams.find((t) => t.team_id === selectedTeamId);

    // 新版 UI 没有 "跳过" 按钮：extractor 从 answers JSON 里取 label，
    // 不再把 tool_result 全文当 answer（旧路径会因问题文案里的 "（可跳过）"
    // 触发 answer.includes("跳过") 假阳性 → 用户明确选的 task 被吞掉）。
    const extracted = extractTaskFromOptionText(lastUserText, team);

    if (extracted === MORE_MARKER) {
      const currentPage = state.agentPageIndex ?? 0;
      const nextPage = currentPage + 1;
      const totalPages = computePagination(team?.tasks.length ?? 0, 0).totalPages;
      const safeNextPage = nextPage > totalPages - 1 ? 0 : nextPage;

      // 防御性：见 agent MORE 分支的同名注释。正常路径 pagination.ts 已避免
      // solo 末页；此处保留双保险。
      const soloTaskId = autoSelectSoloTask(team, safeNextPage);
      if (soloTaskId && state.selectedAgentId) {
        console.log(
          `[session-init:cc] session=${compositeKey} MORE landed on solo task page ${safeNextPage} → auto-select task=${soloTaskId}`,
        );
        return completeRegistration(
          { agent_id: state.selectedAgentId, task_id: soloTaskId },
          state, cachedTeams, selectedTeamId, compositeKey, sessionKey, userId,
          config, store, reqCtx, stripped, metadataClient, userKey, spaceId,
        );
      }

      await store.set(compositeKey, { ...state, agentPageIndex: safeNextPage });
      console.log(
        `[session-init:cc] session=${compositeKey} task page ${currentPage} → ${safeNextPage}`,
      );
      const fd: FormData = {
        teams: cachedTeams,
        stage: "task_select",
        selectedTeamId,
        pageIndex: safeNextPage,
        stream: reqCtx.stream,
        modelId: reqCtx.modelId,
      };
      return { intercepted: true, response: buildFormResponse(fd) };
    }

    // BYPASS_MARKER = declined / 兼容旧表单显式跳过；null = 有答复但匹配不到任何 task
    // 两者都视作 "未识别"，与其它阶段的行为对齐 → bypass 整个 session-init。
    if (extracted === BYPASS_MARKER || extracted === null) {
      console.warn(`[session-init:cc] session=${compositeKey} task-select unrecognized, bypassing`);
      // bypass: 保留 form 对话原样, 不删。
      await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
      return {
        intercepted: false,
        messages: messages as Record<string, unknown>[],
        bypassed: true,
      };
    }

    // 命中 task_id
    const resolved: SessionInitData = {
      agent_id: state.selectedAgentId!,
      task_id: extracted,
    };
    return await completeRegistration(resolved, state, cachedTeams, selectedTeamId, compositeKey, sessionKey, userId, config, store, reqCtx, stripped, metadataClient, userKey, spaceId);
  }

  // ── Case 3: Initialized ───────────────────────────────────────────────────
  const bypassed = (state as any).bypassed === true;
  const agent = bypassed ? null : (state.agentDetail ?? null);
  const task = bypassed ? null : (state.taskDetail ?? null);
  const out = applyArtifactsAndContext(messages, agent, task, sessionKey, config, reqCtx.protocol);
  return {
    intercepted: false,
    messages: out.messages,
    systemAppend: out.systemAppend,
    sessionInfo: state.sessionInfo,
    bypassed,
  };
}
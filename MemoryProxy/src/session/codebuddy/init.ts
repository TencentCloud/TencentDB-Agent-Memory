/**
 * CodeBuddy Session Initialization — 状态机入口.
 *
 * Flow:
 *   1. uninitialized → 内核拉 teams[], 发 `ask_followup_question` form
 *   2. pending_team_select → 解析用户 team 选择, 发 agent_task form
 *   3. pending_agent_task → 解析 agent+task, fetch 详情, register, inject
 *   4. initialized → 每次请求 strip + inject
 */

import type { SessionInitConfig } from "../../types.js";
import type {
  AgentDetail,
  SessionInitData,
  SessionInitState,
  SessionRegistrationData,
  TaskDetail,
  TeamOption,
} from "../types.js";
import { DEFAULT_TASK_LABEL } from "../types.js";
import { SessionStore } from "../store.js";
import { buildSessionInfo } from "../registrar.js";
import { injectSessionContextWithToggles } from "../context-injector.js";
import type { MetadataClient } from "../../meta/client.js";
import { resolvePresetIdentity, type PresetIdentity } from "../preset.js";
import { listAccessibleAgentsForTeam } from "../accessible-agents.js";

import { buildFormResponse, FormData } from "./form.js";
import {
  extractFromOptionText,
  extractTeamFromOptionText,
  extractAssetConfirm,
  extractStructured,
  resolveAgent,
  resolveTask,
  BYPASS_MARKER,
} from "./extractor.js";
import { getLastUserMessageText } from "./cleaner.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SessionRequestContext {
  stream: boolean;
  modelId: string;
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
  /** 用户选"否"不关联团队资产 → bypass 路径，所有注入钩子应跳过。 */
  bypassed?: boolean;
  /**
   * Anthropic-only: pre-built `<session_context>` string the caller must
   * append to `body.system` (the ClaudeCode init module populates this;
   * CodeBuddy stays OpenAI so it is always undefined here). Kept in this
   * interface so `session/index.ts`'s union type stays uniform.
   */
  systemAppend?: string | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

type MessageArr = Record<string, unknown>[];

/** 判断是否是「全新」CodeBuddy 对话（最多一条 user、无 assistant/tool）。 */
function isFreshCBConversation(messages: MessageArr): boolean {
  let userCount = 0;
  for (const m of messages) {
    const role = (m.role as string) ?? "";
    if (role === "assistant" || role === "tool") return false;
    if (role === "user") userCount++;
    if (userCount > 1) return false;
  }
  return userCount <= 1;
}

async function fetchTeamsAndAgents(
  userId: string,
  config: SessionInitConfig,
  metadataClient: MetadataClient,
): Promise<{ teams: TeamOption[] }> {
  const teamsRaw = await metadataClient.listTeams(userId);
  const teams: TeamOption[] = [];

  // Parallel fan-out: for each team, fetch agents & tasks concurrently
  const teamResults = await Promise.all(
    teamsRaw.map(async (t) => {
      const [agentsRaw, tasksRaw] = await Promise.all([
        listAccessibleAgentsForTeam(metadataClient, t.team_id, userId),
        metadataClient.listTasks(t.team_id),
      ]);
      const tasks = tasksRaw.map((tk) => ({
        task_id: tk.task_id,
        task_name: tk.title,
      }));
      // 见 claude-code/init.ts fetchTeamsAndAgents 的同款注释：defaultTaskId
      // 在源头 unshift 到 tasks 列表头部，下游 form/extractor 走既有路径。
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
  teams.push(...teamResults);
  return { teams };
}

function findTeamIdForAgent(teams: TeamOption[], agentId: string): string | undefined {
  for (const team of teams) {
    if (team.agents.some((a) => a.agent_id === agentId)) return team.team_id;
  }
  return undefined;
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

function applyArtifactsAndContext(
  messages: MessageArr,
  agentDetail: AgentDetail | null | undefined,
  taskDetail: TaskDetail | null | undefined,
  sessionKey: string,
  config: SessionInitConfig,
): MessageArr {
  // 曾经这里会按 config.keepInitArtifacts 决定要不要 stripInitArtifacts,
  // 现在**永远保留** session_init form 交互, 不做任何删除。
  const injected = injectSessionContextWithToggles(messages, agentDetail, taskDetail, config, sessionKey);
  if (injected !== messages) {
    const finalRoles = (injected as unknown[]).map((m: any) => m.role);
    console.log(
      `[session-init:cb] session=${sessionKey} processed: ${messages.length} msgs, ` +
        `ctx=${agentDetail ? "Y" : "N"}/${taskDetail ? "Y" : "N"} final=[${finalRoles.join(",")}]`,
    );
  }
  return injected as MessageArr;
}

/**
 * Register a session given a resolved agent(+task), fetch details, inject context.
 * Shared by the interactive form path (Case 2) and the header pre-selection path.
 */
async function completeRegistration(
  resolved: SessionInitData,
  state: SessionInitState,
  cachedTeams: TeamOption[],
  compositeKey: string,
  sessionKey: string,
  userId: string | null,
  config: SessionInitConfig,
  store: SessionStore,
  messages: MessageArr,
  metadataClient?: MetadataClient,
  userKey?: string,
  spaceId?: string,
): Promise<SessionInitResult> {
  const regUserId = (state as any).userId || userId;
  if (!regUserId) {
    console.warn(
      `[session-init:cb] session=${compositeKey} no user_id available → bypass`,
    );
    await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
    return { intercepted: false, bypassed: true, justRegistered: true };
  }
  // 与 CC 侧一致：只有 team + agent + task 三者齐全才注入。task_id 缺失一律 bypass。
  // CodeBuddy 的 team+agent+task 在同一 form 里提交，用户如果没选 task 就走 bypass。
  if (!resolved.task_id) {
    console.warn(
      `[session-init:cb] session=${compositeKey} agent=${resolved.agent_id} without task → bypass (task required for injection)`,
    );
    await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
    return { intercepted: false, bypassed: true, justRegistered: true };
  }
  const regData = buildRegistrationData(resolved, cachedTeams, sessionKey, regUserId);
  if (!regData) {
    console.warn(
      `[session-init:cb] session=${compositeKey} agent=${resolved.agent_id} not bound to any team → bypass`,
    );
    await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
    return { intercepted: false, bypassed: true, justRegistered: true };
  }

  let agentDetail: AgentDetail | null = null;
  let taskDetail: TaskDetail | null = null;

  if (metadataClient) {
    // 当 task_id 是 defaultTaskId（虚拟值）时，跳过 getTask——内核不存在该 task。
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
    else console.warn(`[session-init:cb] getAgent failed: ${String(agentRes.reason)}`);
    if (taskRes.status === "fulfilled") taskDetail = taskRes.value;
    else console.warn(`[session-init:cb] getTask failed: ${String(taskRes.reason)}`);
  }

  const sessionInfo = buildSessionInfo(regData, userKey, spaceId);
  console.log(
    `[session-init:cb] session=${compositeKey} → initialized ` +
      `agent=${resolved.agent_id} task=${regData.task_id ?? "-"} team=${regData.team_id} user=${sessionInfo.user_id}`,
  );

  // Fire-and-forget: 记录参与日志（对齐 claude-code 分支，源标记为 codebuddy）。
  // bypass 场景已在上方 return，天然被过滤；失败仅 warn，不阻断注入。
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
        source: "context_proxy:codebuddy",
      })
      .catch((err: unknown) => {
        console.warn(
          `[session-init:cb] participation-log append failed for session=${compositeKey}: ${err instanceof Error ? err.message : String(err)}`,
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
    cachedTeams: state.cachedTeams ?? cachedTeams,
    selectedTeamId: state.selectedTeamId,
    agentDetail,
    taskDetail,
  };
  await store.set(compositeKey, nextState);

  const out = applyArtifactsAndContext(messages, agentDetail, taskDetail, compositeKey, config);
  return {
    intercepted: false,
    messages: out,
    sessionInfo,
    justRegistered: true,
    agentDetail,
    taskDetail,
  };
}

// ── Main Handler ───────────────────────────────────────────────────────────────

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
  agentSource: string = "codebuddy",
): Promise<SessionInitResult> {
  const compositeKey = `${agentSource}:${sessionKey}`;
  if (sessionKey === "unknown" || !sessionKey) return { intercepted: false };

  const state = store.get(compositeKey);

  // ── Safety net: state 丢失但对话已有历史 → 跳过 init（避免会话中途重弹表单）──
  if ((!state || state.status === "uninitialized") && !isFreshCBConversation(messages)) {
    console.warn(
      `[session-init:cb] session=${compositeKey} state lost but conversation has history, skipping init`,
    );
    return { intercepted: false };
  }

  // ── Case 1: Uninitialized → 先弹 asset_confirm 对话框 ───────────────────
  if (!state || state.status === "uninitialized") {
    if (!userId) {
      console.warn(
        `[session-init:cb] session=${compositeKey} no userId, passing through unintercepted`,
      );
      return { intercepted: false };
    }
    if (!metadataClient) {
      console.warn(
        `[session-init:cb] session=${compositeKey} no metadataClient, passing through unintercepted`,
      );
      return { intercepted: false };
    }

    let teams: TeamOption[];
    try {
      const cfg = await fetchTeamsAndAgents(userId, config, metadataClient);
      teams = cfg.teams;
    } catch (err) {
      console.warn(
        `[session-init:cb] session=${compositeKey} kernel unavailable for user=${userId}, passing through unintercepted: ${err instanceof Error ? err.message : String(err)}`,
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
      return { intercepted: false, bypassed: true, justRegistered: true };
    }

    const totalAgents = teams.reduce((acc, t) => acc + t.agents.length, 0);
    if (totalAgents === 0) {
      console.warn(
        `[session-init:cb] session=${compositeKey} user=${userId} has no active agents, passing through`,
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
      return { intercepted: false, bypassed: true, justRegistered: true };
    }

    // ── Header-driven pre-selection: skip forms when identity is provided ──
    if (presetIdentity && config.headerAutoSelect?.enabled) {
      const pr = resolvePresetIdentity(teams, presetIdentity);

      if (pr.hadMismatch) {
        if (config.headerAutoSelect.onMismatch === "bypass") {
          console.warn(`[session-init:cb] session=${compositeKey} preset mismatch → bypass`);
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
          return { intercepted: false, bypassed: true, justRegistered: true };
        }
        console.warn(`[session-init:cb] session=${compositeKey} preset mismatch → fallback to form`);
        // fall through to the normal asset_confirm flow below
      } else if (pr.canRegister) {
        // team + agent resolved → register directly (task optional)
        console.log(
          `[session-init:cb] session=${compositeKey} preset hit team=${pr.teamId} agent=${pr.agentId} task=${pr.taskId ?? "-"} → register directly`,
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
          seedState, teams, compositeKey, sessionKey, userId,
          config, store, messages, metadataClient, userKey, spaceId,
        );
      } else if (pr.teamId) {
        // only team resolved → jump straight to agent+task selection (skip asset_confirm + team_select)
        await store.set(compositeKey, {
          status: "pending_agent_task",
          keyId: sessionKey,
          startedAt: Date.now(),
          attemptCount: 0,
          userId,
          cachedTeams: teams,
          selectedTeamId: pr.teamId,
        });
        console.log(
          `[session-init:cb] session=${compositeKey} preset team=${pr.teamId} → pending_agent_task`,
        );
        const fd: FormData = {
          teams,
          stage: "agent_task",
          selectedTeamId: pr.teamId,
          stream: reqCtx.stream,
          modelId: reqCtx.modelId,
          protocol: reqCtx.protocol,
        };
        return { intercepted: true, response: buildFormResponse(fd) };
      }
    }

    // 先弹 asset_confirm 对话框
    await store.set(compositeKey, {
      status: "pending_asset_confirm",
      keyId: sessionKey,
      startedAt: Date.now(),
      attemptCount: 0,
      userId,
      cachedTeams: teams,
    });
    console.log(
      `[session-init:cb] session=${compositeKey} user=${userId} → pending_asset_confirm (teams=${teams.length})`,
    );
    const fd: FormData = {
      teams,
      stage: "asset_confirm",
      stream: reqCtx.stream,
      modelId: reqCtx.modelId,
      protocol: reqCtx.protocol,
    };
    return { intercepted: true, response: buildFormResponse(fd) };
  }

  // ── Case 1.25: Awaiting asset_confirm ────────────────────────────────────
  if (state.status === "pending_asset_confirm") {
    const lastUserText = getLastUserMessageText(messages);
    const choice = extractAssetConfirm(lastUserText);

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
      console.log(`[session-init:cb] session=${compositeKey} user chose no-asset → bypass`);
      return { intercepted: false, messages: messages as Record<string, unknown>[], bypassed: true, justRegistered: true };
    }

    if (choice === true) {
      const teams = state.cachedTeams ?? [];
      if (teams.length === 1) {
        const onlyTeam = teams[0];
        await store.set(compositeKey, {
          status: "pending_agent_task",
          keyId: sessionKey,
          startedAt: state.startedAt,
          attemptCount: 0,
          userId: state.userId,
          cachedTeams: teams,
          selectedTeamId: onlyTeam.team_id,
        });
        console.log(
          `[session-init:cb] session=${compositeKey} only-team=${onlyTeam.team_id} → pending_agent_task`,
        );
        const fd: FormData = {
          teams,
          stage: "agent_task",
          selectedTeamId: onlyTeam.team_id,
          stream: reqCtx.stream,
          modelId: reqCtx.modelId,
          protocol: reqCtx.protocol,
        };
        return { intercepted: true, response: buildFormResponse(fd) };
      }

      await store.set(compositeKey, {
        status: "pending_team_select",
        keyId: sessionKey,
        startedAt: state.startedAt,
        attemptCount: 0,
        userId: state.userId,
        cachedTeams: teams,
      });
      console.log(
        `[session-init:cb] session=${compositeKey} → pending_team_select (teams=${teams.length})`,
      );
      const fd: FormData = {
        teams,
        stage: "team",
        stream: reqCtx.stream,
        modelId: reqCtx.modelId,
        protocol: reqCtx.protocol,
      };
      return { intercepted: true, response: buildFormResponse(fd) };
    }

    state.attemptCount++;
    if (state.attemptCount >= config.maxRetries) {
      console.warn(`[session-init:cb] session=${compositeKey} asset-confirm max retries, abandoning`);
      await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
      return { intercepted: false, bypassed: true, justRegistered: true };
    }
    await store.set(compositeKey, state);
    const fd: FormData = {
      teams: state.cachedTeams ?? [],
      stage: "asset_confirm",
      retry: true,
      stream: reqCtx.stream,
      modelId: reqCtx.modelId,
      protocol: reqCtx.protocol,
    };
    return { intercepted: true, response: buildFormResponse(fd) };
  }

  // ── Case 1.5: Awaiting team selection ─────────────────────────────────────
  if (state.status === "pending_team_select") {
    const lastUserText = getLastUserMessageText(messages);
    const teamId = extractTeamFromOptionText(lastUserText, state.cachedTeams ?? []);

    if (teamId && teamId !== BYPASS_MARKER) {
      const next: SessionInitState = {
        ...state,
        status: "pending_agent_task",
        selectedTeamId: teamId,
        attemptCount: 0,
      };
      await store.set(compositeKey, next);
      console.log(`[session-init:cb] session=${compositeKey} team=${teamId} → pending_agent_task`);
      const fd: FormData = {
        teams: state.cachedTeams ?? [],
        stage: "agent_task",
        selectedTeamId: teamId,
        stream: reqCtx.stream,
        modelId: reqCtx.modelId,
        protocol: reqCtx.protocol,
      };
      return { intercepted: true, response: buildFormResponse(fd) };
    }

    state.attemptCount++;
    if (state.attemptCount >= config.maxRetries) {
      console.warn(`[session-init:cb] session=${compositeKey} team-select max retries, abandoning`);
      await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
      return { intercepted: false, bypassed: true, justRegistered: true };
    }
    await store.set(compositeKey, state);
    const fd: FormData = {
      teams: state.cachedTeams ?? [],
      stage: "team",
      retry: true,
      stream: reqCtx.stream,
      modelId: reqCtx.modelId,
      protocol: reqCtx.protocol,
    };
    return { intercepted: true, response: buildFormResponse(fd) };
  }

  // ── Case 2: Awaiting agent + task selection ───────────────────────────────
  if (state.status === "pending_agent_task" || state.status === "pending_form") {
    const lastUserText = getLastUserMessageText(messages);
    const cachedTeams = state.cachedTeams ?? [];
    const selectedTeamId = state.selectedTeamId;

    // LLM-based extraction fallback was removed — engineered paths only.
    // If neither the option-text match nor the structured parser recognises
    // the reply, the caller falls through to the retry / bypass branch.
    let extracted = extractFromOptionText(lastUserText, cachedTeams, selectedTeamId)
      ?? extractStructured(lastUserText);

    if (extracted && extracted.agent_id === BYPASS_MARKER) {
      console.warn(`[session-init:cb] session=${compositeKey} unexpected bypass in agent_task, treating as extraction failure`);
      extracted = null;
    }

    if (extracted) {
      const resolvedAgentId = resolveAgent(extracted.agent_id, cachedTeams, selectedTeamId);
      const resolvedTaskId = resolveTask(
        extracted.task_id,
        cachedTeams,
        resolvedAgentId,
        selectedTeamId,
      );
      const resolved: SessionInitData = {
        agent_id: resolvedAgentId,
        task_id: resolvedTaskId,
      };

      return await completeRegistration(
        resolved, state, cachedTeams, compositeKey, sessionKey, userId,
        config, store, messages, metadataClient, userKey, spaceId,
      );
    }

    // Extraction failed → retry / reset
    state.attemptCount++;
    if (state.attemptCount >= config.maxRetries) {
      console.warn(`[session-init:cb] session=${compositeKey} max retries, abandoning`);
      await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
      return { intercepted: false, bypassed: true, justRegistered: true };
    }
    await store.set(compositeKey, state);
    const fd: FormData = {
      teams: state.cachedTeams ?? [],
      stage: "agent_task",
      selectedTeamId: state.selectedTeamId,
      retry: true,
      stream: reqCtx.stream,
      modelId: reqCtx.modelId,
      protocol: reqCtx.protocol,
    };
    return { intercepted: true, response: buildFormResponse(fd) };
  }

  // ── Case 3: Initialized ───────────────────────────────────────────────────
  const bypassed = (state as any).bypassed === true;
  const agent = bypassed ? null : (state.agentDetail ?? null);
  const task = bypassed ? null : (state.taskDetail ?? null);
  const out = applyArtifactsAndContext(messages, agent, task, sessionKey, config);
  return { intercepted: false, messages: out, sessionInfo: state.sessionInfo, bypassed };
}

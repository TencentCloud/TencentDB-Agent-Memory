/**
 * Header-only session initialization for clients without an interactive form UI.
 *
 * OpenClaw and Hermes share the OpenAI/Anthropic wire handlers with other
 * clients, but they must never enter the CodeBuddy/Claude Code form state
 * machines. Their identity contract is entirely request-header driven.
 */

import type { MetadataClient } from "../../meta/client.js";
import type { SessionInitConfig } from "../../types.js";
import { buildSessionContextBlockWithToggles, injectSessionContextWithToggles } from "../context-injector.js";
import { buildSessionInfo } from "../registrar.js";
import { resolvePresetIdentity, type PresetIdentity } from "../preset.js";
import type { SessionStore, SessionIdentity } from "../store.js";
import type { AgentDetail, SessionInitState, TaskDetail, TeamOption } from "../types.js";
import type { SessionInitResult, SessionRequestContext } from "../codebuddy/init.js";

const HEADER_ONLY_AGENTS = new Set(["openclaw", "hermes"]);

export function isHeaderOnlyAgent(agentSource: string): boolean {
  return HEADER_ONLY_AGENTS.has(agentSource);
}

function bypassResult(): SessionInitResult {
  return { intercepted: false, bypassed: true, justRegistered: true };
}

async function persistBypass(
  store: SessionStore,
  compositeKey: string,
  identity: SessionIdentity,
  userId: string | null,
): Promise<SessionInitResult> {
  store.bind(compositeKey, identity);
  await store.set(compositeKey, {
    status: "initialized",
    keyId: compositeKey,
    startedAt: Date.now(),
    attemptCount: 0,
    userId: userId || "anonymous",
    sessionInfo: null,
    agentDetail: null,
    taskDetail: null,
    bypassed: true,
  } as SessionInitState);
  return bypassResult();
}

/** Validate header identity, register or bypass, and never emit a form. */
export async function handleHeaderOnlySessionInit(
  sessionKey: string,
  userId: string | null,
  messages: Record<string, unknown>[],
  config: SessionInitConfig,
  store: SessionStore,
  reqCtx: SessionRequestContext,
  agentSource: string,
  metadataClient?: MetadataClient,
  userKey?: string,
  spaceId?: string,
  presetIdentity?: PresetIdentity,
): Promise<SessionInitResult> {
  const compositeKey = `${agentSource}:${sessionKey}`;
  const identity: SessionIdentity = {
    userId: userId || "anonymous",
    agentSource,
    sessionId: sessionKey,
    spaceId: spaceId || "",
  };

  if (!config.enabled || !userId || !presetIdentity?.teamId || !presetIdentity.agentId) {
    console.warn(`[session-init:header-only] session=${compositeKey} missing required team/agent identity → bypass`);
    return persistBypass(store, compositeKey, identity, userId);
  }
  if (!config.headerAutoSelect?.enabled) {
    console.warn(`[session-init:header-only] session=${compositeKey} header auto-select disabled → bypass`);
    return persistBypass(store, compositeKey, identity, userId);
  }
  if (!metadataClient) {
    // Do not persist transient infrastructure failures; the next request may recover.
    console.warn(`[session-init:header-only] session=${compositeKey} metadata client unavailable → bypass this turn`);
    return bypassResult();
  }

  let teams: TeamOption[];
  try {
    const visibleTeams = await metadataClient.listTeams(userId);
    const selectedTeam = visibleTeams.find((team) => team.team_id === presetIdentity.teamId);
    if (!selectedTeam) {
      teams = [];
    } else {
      const [agents, tasks] = await Promise.all([
        metadataClient.listAgents(selectedTeam.team_id, userId),
        metadataClient.listTasks(selectedTeam.team_id),
      ]);
      teams = [{
        team_id: selectedTeam.team_id,
        team_name: selectedTeam.name ?? selectedTeam.team_id,
        agents: agents.map((agent) => ({
          agent_id: agent.agent_id,
          agent_name: agent.name ?? agent.agent_id,
          description: agent.description ?? undefined,
        })),
        tasks: tasks.map((task) => ({
          task_id: task.task_id,
          task_name: task.title ?? task.task_id,
        })),
      }];
    }
  } catch (err) {
    // Do not turn an outage into a terminal session decision.
    console.warn(`[session-init:header-only] session=${compositeKey} metadata lookup failed → bypass this turn: ${err instanceof Error ? err.message : String(err)}`);
    return bypassResult();
  }

  const resolution = resolvePresetIdentity(teams, presetIdentity, {
    taskMissingPolicy: config.taskMissingPolicy,
    defaultTaskId: config.defaultTaskId,
  });
  if (!resolution.canRegister) {
    // Header-only clients cannot honor onMismatch=form. Invalid or incomplete
    // identity therefore fails closed to bypass and never enters a form state.
    console.warn(
      `[session-init:header-only] session=${compositeKey} preset mismatch ` +
      `(configured=${config.headerAutoSelect.onMismatch}) → bypass (no form capability)`,
    );
    return persistBypass(store, compositeKey, identity, userId);
  }

  let agentDetail: AgentDetail | null = null;
  let taskDetail: TaskDetail | null = null;
  const shouldFetchTask = resolution.taskId && resolution.taskId !== config.defaultTaskId;
  const [agentResult, taskResult] = await Promise.allSettled([
    metadataClient.getAgent(resolution.agentId!),
    shouldFetchTask ? metadataClient.getTask(resolution.taskId!) : Promise.resolve(null),
  ]);
  if (agentResult.status === "fulfilled") {
    agentDetail = {
      id: agentResult.value.agent_id,
      name: agentResult.value.name,
      description: agentResult.value.description ?? undefined,
      prompt: agentResult.value.prompt ?? undefined,
    };
  } else {
    console.warn(`[session-init:header-only] getAgent(${resolution.agentId}) failed: ${String(agentResult.reason)}`);
  }
  if (taskResult.status === "fulfilled" && taskResult.value) {
    taskDetail = {
      id: taskResult.value.task_id,
      name: taskResult.value.title,
      description: taskResult.value.description ?? undefined,
    };
  } else if (taskResult.status === "rejected") {
    console.warn(`[session-init:header-only] getTask(${resolution.taskId}) failed: ${String(taskResult.reason)}`);
  }

  const sessionInfo = buildSessionInfo({
    session_id: sessionKey,
    team_id: resolution.teamId!,
    agent_id: resolution.agentId!,
    task_id: resolution.taskId,
    user_id: userId,
  }, userKey, spaceId);
  const state: SessionInitState = {
    status: "initialized",
    keyId: compositeKey,
    startedAt: Date.now(),
    attemptCount: 0,
    userId,
    sessionInfo,
    agentDetail,
    taskDetail,
    bypassed: false,
  };
  store.bind(compositeKey, identity);
  await store.set(compositeKey, state);

  const protocol = reqCtx.protocol ?? "openai";
  const outputMessages = protocol === "openai"
    ? injectSessionContextWithToggles(messages, agentDetail, taskDetail, config, sessionKey)
    : messages;
  const systemAppend = protocol === "anthropic"
    ? buildSessionContextBlockWithToggles(agentDetail, taskDetail, config, sessionKey)
    : null;

  console.log(
    `[session-init:header-only] session=${compositeKey} → initialized ` +
    `team=${resolution.teamId} agent=${resolution.agentId} task=${resolution.taskId ?? "-"}`,
  );
  return {
    intercepted: false,
    messages: outputMessages,
    systemAppend,
    sessionInfo,
    agentDetail,
    taskDetail,
    bypassed: false,
    justRegistered: true,
  };
}

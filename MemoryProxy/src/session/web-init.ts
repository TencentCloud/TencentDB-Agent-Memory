/**
 * Web Session Init — 无表单通道客户端的通用浏览器补全流程。
 *
 * proxy 给 LLM 回一条带 opaque 一次性 URL 的响应；用户在浏览器里打开
 * URL、选 Team / Agent / 可选 Task，最终状态落入普通的
 * SessionStore / BindingRepo —— 和交互表单流程写入的位置完全一致，
 * 后续 recovery / injection 路径无需感知这个 session 是怎么初始化的。
 *
 * challenge token 是 process-local + 短 TTL（已知 limitation：多 pod 部署
 * 需要共享 token store，暂不实现）。durable session 状态不落在本模块。
 */

import { randomBytes } from "node:crypto";

import type { MetadataClient } from "../meta/client.js";
import type { SessionStore, SessionIdentity } from "./store.js";
import type { AgentDetail, SessionInitState, TaskDetail, TeamOption } from "./types.js";
import { buildSessionInfo } from "./registrar.js";
import { resolvePresetIdentity } from "./preset.js";

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 十分钟

type MetadataReader = Pick<
  MetadataClient,
  "listTeams" | "listAgents" | "listTasks"
>;

export interface WebInitChallengeInput {
  compositeKey: string;
  sessionKey: string;
  identity: SessionIdentity;
  userKey?: string;
  metadataClient: MetadataReader;
  store: SessionStore;
}

interface WebInitChallenge extends WebInitChallengeInput {
  token: string;
  sessionScope: string;
  expiresAt: number;
  completing: boolean;
}

export interface WebInitOptions {
  teams: TeamOption[];
  expiresAt: number;
}

export type WebInitFailureCode =
  | "invalid_token"
  | "expired_token"
  | "already_initialized"
  | "completion_in_progress"
  | "invalid_selection"
  | "metadata_unavailable";

type WebInitFailure = { ok: false; code: WebInitFailureCode; message: string };

export interface WebInitCompletion {
  teamId: string;
  agentId: string;
  taskId?: string;
}

export interface WebSessionInitServiceOptions {
  ttlMs?: number;
  now?: () => number;
  tokenFactory?: () => string;
}

export class WebSessionInitService {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly tokenFactory: () => string;
  private readonly challenges = new Map<string, WebInitChallenge>();
  private readonly activeBySession = new Map<string, string>();

  constructor(options: WebSessionInitServiceOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    // 默认 256-bit 随机 —— token 是 opaque capability handle，URL 是它唯一的
    // 载体，猜测必须不可行（URL 中不含 userKey / conversation ID / asset ID）。
    this.tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
  }

  issue(input: WebInitChallengeInput): { ok: true; value: { token: string; expiresAt: number } } | WebInitFailure {
    this.pruneExpired();
    if (input.store.get(input.compositeKey)?.status === "initialized") {
      return { ok: false, code: "already_initialized", message: "This session is already initialized." };
    }

    const sessionScope = this.sessionScope(input.identity, input.compositeKey);
    // 每个 session 同时只允许一个 active challenge：重复 issue 返回未消费的
    // token 而不是再铸一个 —— 否则旧 token 仍然有效，两个浏览器 tab 可以
    // 各自 complete 产生竞态。
    const activeToken = this.activeBySession.get(sessionScope);
    if (activeToken) {
      const active = this.getActiveChallenge(activeToken);
      if (active) {
        return { ok: true, value: { token: active.token, expiresAt: active.expiresAt } };
      }
      this.remove(activeToken, sessionScope);
    }

    let token = this.tokenFactory();
    while (this.challenges.has(token)) token = this.tokenFactory();

    const challenge: WebInitChallenge = {
      ...input,
      token,
      sessionScope,
      expiresAt: this.now() + this.ttlMs,
      completing: false,
    };
    this.challenges.set(token, challenge);
    this.activeBySession.set(sessionScope, token);
    return { ok: true, value: { token, expiresAt: challenge.expiresAt } };
  }

  inspect(token: string): { ok: true; value: { expiresAt: number } } | WebInitFailure {
    const stored = this.challenges.get(token);
    if (stored && stored.expiresAt <= this.now()) {
      this.remove(token, stored.sessionScope);
      return { ok: false, code: "expired_token", message: "This session initialization link has expired." };
    }
    const challenge = this.getActiveChallenge(token);
    if (!challenge) return this.tokenFailure(token);
    if (challenge.store.get(challenge.compositeKey)?.status === "initialized") {
      this.remove(token, challenge.sessionScope);
      return { ok: false, code: "already_initialized", message: "This session is already initialized." };
    }
    return { ok: true, value: { expiresAt: challenge.expiresAt } };
  }

  async getOptions(token: string): Promise<{ ok: true; value: WebInitOptions } | WebInitFailure> {
    const inspected = this.inspect(token);
    if (inspected.ok === false) return inspected;
    const challenge = this.getActiveChallenge(token)!;

    try {
      const teams = await this.loadTeamOptions(challenge);
      // listTeams/listAgents 会让出事件循环 —— 加载期间 token 可能已被
      // complete 或已过期，返回前需要重新校验。
      const current = this.inspect(token);
      if (current.ok === false) return current;
      return { ok: true, value: { teams, expiresAt: challenge.expiresAt } };
    } catch {
      return {
        ok: false,
        code: "metadata_unavailable",
        // 异常可能来自网络或业务 envelope，不能把未受控文本带到 capability API。
        message: "Unable to load session assets. Please retry.",
      };
    }
  }

  async complete(token: string, selection: WebInitCompletion): Promise<{ ok: true; value: null } | WebInitFailure> {
    const inspected = this.inspect(token);
    if (inspected.ok === false) return inspected;
    const challenge = this.getActiveChallenge(token)!;
    if (challenge.completing) {
      return { ok: false, code: "completion_in_progress", message: "This session is already being connected." };
    }

    const teamId = selection.teamId?.trim();
    const agentId = selection.agentId?.trim();
    const taskId = selection.taskId?.trim() || undefined;
    if (!teamId || !agentId) {
      return { ok: false, code: "invalid_selection", message: "Team and Agent are required." };
    }

    // 必须在第一个 await 之前同步置位：并发到达的第二个 POST 要看到
    // completion_in_progress，而不是再发起一次并发的 store 写入。
    challenge.completing = true;
    let completed = false;
    try {
      // server-side 校验：浏览器提交的是不可信输入，所选 Team / Agent /
      // Task 必须存在于该用户可见的资产列表里（与 preset.ts 的 header
      // 校验同一原则 —— 不盲信客户端给的 id）。
      const teamsRaw = await challenge.metadataClient.listTeams(challenge.identity.userId);
      const selectedTeam = teamsRaw.find((team) => team.team_id === teamId);
      if (!selectedTeam) {
        return { ok: false, code: "invalid_selection", message: "The selected Team is not available." };
      }

      const [agentsRaw, tasksRaw] = await Promise.all([
        challenge.metadataClient.listAgents(teamId, challenge.identity.userId),
        challenge.metadataClient.listTasks(teamId),
      ]);
      const team: TeamOption = {
        team_id: selectedTeam.team_id,
        team_name: selectedTeam.name,
        agents: agentsRaw.map((agent) => ({
          agent_id: agent.agent_id,
          agent_name: agent.name,
          description: agent.description ?? undefined,
        })),
        tasks: tasksRaw.map((task) => ({
          task_id: task.task_id,
          task_name: task.title,
        })),
      };
      const resolved = resolvePresetIdentity([team], { teamId, agentId, taskId });
      if (!resolved.canRegister || (taskId && resolved.taskId !== taskId)) {
        return { ok: false, code: "invalid_selection", message: "The selected Agent or Task is not available for this Team." };
      }

      // 上面的 metadata 调用让出了事件循环。最终写入前先复用 inspect() 的完整
      // 生命周期语义：token 必须仍存在、未过期、仍是该 session 的 active token，
      // 且 Session 未被静态 header 或其他路径初始化。尤其要在 getActiveChallenge()
      // 清理过期对象之前保留 expired_token / 410，而不能退化成 invalid_token / 404。
      const currentStatus = this.inspect(token);
      if (currentStatus.ok === false) return currentStatus;

      // inspect() 成功后到同步写入门禁之间没有 await，但仍显式核对 Map 中保存的
      // 对象就是 complete() 开始时持有的原 challenge，保留 stale object identity
      // 防护，避免未来生命周期代码替换同 token 对象时旧 completion 获得写权限。
      const current = this.challenges.get(token);
      if (current !== challenge || this.activeBySession.get(challenge.sessionScope) !== token) {
        return this.tokenFailure(token);
      }

      const selectedAgent = agentsRaw.find((agent) => agent.agent_id === resolved.agentId)!;
      const selectedTask = resolved.taskId
        ? tasksRaw.find((task) => task.task_id === resolved.taskId)
        : undefined;
      const agentDetail: AgentDetail = {
        id: selectedAgent.agent_id,
        name: selectedAgent.name,
        description: selectedAgent.description ?? undefined,
        prompt: selectedAgent.prompt ?? undefined,
      };
      const taskDetail: TaskDetail | null = selectedTask
        ? {
            id: selectedTask.task_id,
            name: selectedTask.title,
            description: selectedTask.description ?? undefined,
          }
        : null;
      const sessionInfo = buildSessionInfo(
        {
          session_id: challenge.sessionKey,
          team_id: resolved.teamId!,
          agent_id: resolved.agentId!,
          task_id: resolved.taskId,
          user_id: challenge.identity.userId,
        },
        challenge.userKey,
        challenge.identity.spaceId,
      );
      const state: SessionInitState = {
        status: "initialized",
        keyId: challenge.sessionKey,
        startedAt: this.now(),
        attemptCount: 0,
        userId: challenge.identity.userId,
        cachedTeams: [team],
        selectedTeamId: resolved.teamId,
        sessionInfo,
        agentDetail,
        taskDetail,
        bypassed: false,
      };

      challenge.store.bind(challenge.compositeKey, challenge.identity);
      await challenge.store.set(challenge.compositeKey, state);
      completed = true;
      this.remove(token, challenge.sessionScope);
      console.log(
        `[session-init:web] session=${challenge.compositeKey} connected ` +
          `team=${resolved.teamId} agent=${resolved.agentId}` +
          (resolved.taskId ? ` task=${resolved.taskId}` : " (no task)"),
      );
      return { ok: true, value: null };
    } catch {
      return {
        ok: false,
        code: "metadata_unavailable",
        message: "Unable to validate session assets. Please retry.",
      };
    } finally {
      if (!completed && this.challenges.get(token) === challenge) challenge.completing = false;
    }
  }

  reset(): void {
    this.challenges.clear();
    this.activeBySession.clear();
  }

  private async loadTeamOptions(challenge: WebInitChallenge): Promise<TeamOption[]> {
    const teams = await challenge.metadataClient.listTeams(challenge.identity.userId);
    return Promise.all(teams.map(async (team) => {
      const [agents, tasks] = await Promise.all([
        challenge.metadataClient.listAgents(team.team_id, challenge.identity.userId),
        challenge.metadataClient.listTasks(team.team_id),
      ]);
      return {
        team_id: team.team_id,
        team_name: team.name,
        agents: agents.map((agent) => ({
          agent_id: agent.agent_id,
          agent_name: agent.name,
          description: agent.description ?? undefined,
        })),
        tasks: tasks.map((task) => ({
          task_id: task.task_id,
          task_name: task.title,
        })),
      };
    }));
  }

  // NUL 分隔：compositeKey 本身含 ':'（`${agentSource}:${sessionKey}`），
  // 用 ':' 拼 scope 会让不同的 (spaceId, userId) 组合碰撞到同一个 key 上。
  private sessionScope(identity: SessionIdentity, compositeKey: string): string {
    return `${identity.spaceId ?? ""}\u0000${identity.userId}\u0000${compositeKey}`;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [token, challenge] of this.challenges) {
      if (challenge.expiresAt <= now) this.remove(token, challenge.sessionScope);
    }
  }

  private getActiveChallenge(token: string): WebInitChallenge | undefined {
    const challenge = this.challenges.get(token);
    if (!challenge) return undefined;
    if (challenge.expiresAt <= this.now()) {
      this.remove(token, challenge.sessionScope);
      return undefined;
    }
    if (this.activeBySession.get(challenge.sessionScope) !== token) {
      this.challenges.delete(token);
      return undefined;
    }
    return challenge;
  }

  private tokenFailure(token: string): WebInitFailure {
    const challenge = this.challenges.get(token);
    if (challenge && challenge.expiresAt <= this.now()) {
      this.remove(token, challenge.sessionScope);
      return { ok: false, code: "expired_token", message: "This session initialization link has expired." };
    }
    return { ok: false, code: "invalid_token", message: "This session initialization link is invalid." };
  }

  private remove(token: string, sessionScope: string): void {
    this.challenges.delete(token);
    if (this.activeBySession.get(sessionScope) === token) {
      this.activeBySession.delete(sessionScope);
    }
  }
}

let service = new WebSessionInitService();

export function getWebSessionInitService(): WebSessionInitService {
  return service;
}

/** 仅用于测试，注入确定性的时钟和 token。 */
export function setWebSessionInitService(next: WebSessionInitService | null): void {
  service = next ?? new WebSessionInitService();
}

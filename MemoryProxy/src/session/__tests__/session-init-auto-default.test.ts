/**
 * session-init autoDefault（静默默认）+ initTimeoutMs（超时收敛）单元测试。
 *
 * 背景：main agent 与 sub-agent（子代理 = 也是全新 session）每次开新会话都要手选
 * team/agent/task，且 ask 表单等待用户回复会把会话初始化挂起。本测试覆盖：
 *   1. resolveAutoDefaultIdentity —— 默认值解析纯函数（team/agent/task 匹配与回退语义）。
 *   2. handleSessionInit —— uninitialized 会话在 autoDefault 开启时直接静默注册（不弹表单）。
 *   3. handleSessionInit —— pending 会话超时（超过 initTimeoutMs）后收敛到默认值。
 */
import { describe, it, expect } from "vitest";
import { SessionStore } from "../store.js";
import { resolveAutoDefaultIdentity, handleSessionInit } from "../codebuddy/init.js";
import type { SessionInitConfig } from "../../types.js";
import type { TeamOption } from "../types.js";
import type { MetadataClient } from "../../meta/client.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const teamA: TeamOption = {
  team_id: "team-abc12345",
  team_name: "Team A",
  agents: [{ agent_id: "agt-aaa11111", agent_name: "Agent A" }],
  tasks: [{ task_id: "task-x", task_name: "Task X" }],
};
const teamB: TeamOption = {
  team_id: "team-def67890",
  team_name: "Team B",
  agents: [{ agent_id: "agt-bbb22222", agent_name: "Agent B" }],
  tasks: [],
};

function baseConfig(overrides: Partial<SessionInitConfig> = {}): SessionInitConfig {
  return {
    enabled: true,
    maxRetries: 3,
    injectAgentContext: true,
    injectTaskContext: true,
    defaultTaskId: "default",
    headerAutoSelect: {
      enabled: true,
      teamHeader: "x-team-id",
      agentHeader: "x-agent-id",
      taskHeader: "x-task-id",
      onMismatch: "form",
    },
    autoDefault: { enabled: false, onUnresolved: "skip" },
    initTimeoutMs: 15 * 60 * 1000,
    ...overrides,
  };
}

const metadataClient = {
  listTeams: async () => [{ team_id: teamA.team_id, name: teamA.team_name }],
  listAgents: async () => [{ agent_id: "agt-aaa11111", name: "Agent A" }],
  listTasks: async () => [{ task_id: "task-x", title: "Task X" }],
  getAgent: async (id: string) => ({ agent_id: id, name: "Agent A" }),
  getTask: async (id: string) => ({ task_id: id, title: "Task X" }),
  appendParticipationLog: async () => {},
} as unknown as MetadataClient;

const reqCtx = { stream: false, modelId: "test-model" } as Parameters<typeof handleSessionInit>[5];

function userMessages(): Record<string, unknown>[] {
  return [{ role: "user", content: "hi" }];
}

// ── resolveAutoDefaultIdentity ────────────────────────────────────────────────

describe("resolveAutoDefaultIdentity", () => {
  it("returns null when autoDefault is disabled", () => {
    const cfg = baseConfig({ autoDefault: { enabled: false, onUnresolved: "skip" } });
    expect(resolveAutoDefaultIdentity([teamA, teamB], cfg)).toBeNull();
  });

  it("resolves default team/agent/task when no ids configured", () => {
    const cfg = baseConfig({ autoDefault: { enabled: true, onUnresolved: "skip" } });
    // 取第一个 team / 第一个 agent；task 缺省用 defaultTaskId（虚拟"不关联任务"）。
    expect(resolveAutoDefaultIdentity([teamA, teamB], cfg)).toEqual({
      agent_id: "agt-aaa11111",
      task_id: "default",
    });
  });

  it("honours explicit teamId + agentId + taskId", () => {
    const cfg = baseConfig({
      autoDefault: { enabled: true, onUnresolved: "skip", teamId: teamB.team_id, agentId: "agt-bbb22222", taskId: "task-real" },
    });
    expect(resolveAutoDefaultIdentity([teamA, teamB], cfg)).toEqual({
      agent_id: "agt-bbb22222",
      task_id: "task-real",
    });
  });

  it("falls back to defaultTaskId when taskId omitted", () => {
    const cfg = baseConfig({ autoDefault: { enabled: true, onUnresolved: "skip", teamId: teamB.team_id } });
    expect(resolveAutoDefaultIdentity([teamA, teamB], cfg)).toEqual({
      agent_id: "agt-bbb22222",
      task_id: "default",
    });
  });

  it("returns 'skip' when configured agent not in the team (onUnresolved=skip)", () => {
    const cfg = baseConfig({ autoDefault: { enabled: true, onUnresolved: "skip", agentId: "agt-bbb22222" } });
    // teamA 没有 agt-bbb22222 → 无法解析。
    expect(resolveAutoDefaultIdentity([teamA], cfg)).toBe("skip");
  });

  it("returns null when onUnresolved=form and agent missing", () => {
    const cfg = baseConfig({ autoDefault: { enabled: true, onUnresolved: "form", agentId: "agt-bbb22222" } });
    expect(resolveAutoDefaultIdentity([teamA], cfg)).toBeNull();
  });

  it("returns 'skip' when the team list is empty", () => {
    const cfg = baseConfig({ autoDefault: { enabled: true, onUnresolved: "skip" } });
    expect(resolveAutoDefaultIdentity([], cfg)).toBe("skip");
  });

  it("returns 'skip' when a team has no agents", () => {
    const emptyTeam: TeamOption = { team_id: "team-00000000", team_name: "Empty", agents: [], tasks: [] };
    const cfg = baseConfig({ autoDefault: { enabled: true, onUnresolved: "skip" } });
    expect(resolveAutoDefaultIdentity([emptyTeam], cfg)).toBe("skip");
  });
});

// ── handleSessionInit: autoDefault silent registration ───────────────────────

describe("handleSessionInit with autoDefault", () => {
  it("registers directly (no form) on a fresh session when autoDefault enabled", async () => {
    const store = new SessionStore();
    const cfg = baseConfig({ autoDefault: { enabled: true, onUnresolved: "skip" } });
    const result = await handleSessionInit(
      "session-1", "user-1", userMessages(), cfg, store, reqCtx,
      metadataClient, "user-key", "space-1", undefined, "dsh",
    );
    expect(result.intercepted).toBe(false);
    expect(result.justRegistered).toBe(true);
    expect(result.sessionInfo?.user_id).toBe("user-1");
    const state = store.get("dsh:session-1");
    expect(state?.status).toBe("initialized");
    expect(state?.agentDetail?.id).toBe("agt-aaa11111");
    // 默认未配 taskId → 记 defaultTaskId 虚拟项，task 段为空。
    expect(state?.taskDetail).toBeNull();
  });

  it("keeps the interactive form when autoDefault is disabled", async () => {
    const store = new SessionStore();
    const cfg = baseConfig({ autoDefault: { enabled: false, onUnresolved: "skip" } });
    const result = await handleSessionInit(
      "session-2", "user-1", userMessages(), cfg, store, reqCtx,
      metadataClient, "user-key", "space-1", undefined, "dsh",
    );
    expect(result.intercepted).toBe(true);
    expect(result.formData).toBeDefined();
    const state = store.get("dsh:session-2");
    expect(state?.status).toBe("pending_asset_confirm");
  });
});

// ── handleSessionInit: pending timeout convergence ───────────────────────────

describe("handleSessionInit pending timeout", () => {
  it("converges a stale pending session to autoDefault when past initTimeoutMs", async () => {
    const store = new SessionStore();
    const cfg = baseConfig({ autoDefault: { enabled: true, onUnresolved: "skip" }, initTimeoutMs: 15 * 60 * 1000 });
    // 种子：一个 20 分钟前开始的 pending_asset_confirm（< 30min 的 store TTL，
    // 但 > 15min 的 initTimeoutMs），用户一直没有答复。
    await store.set("dsh:session-3", {
      status: "pending_asset_confirm",
      keyId: "session-3",
      startedAt: Date.now() - 20 * 60 * 1000,
      attemptCount: 0,
      userId: "user-1",
      cachedTeams: [teamA],
    } as never);

    const result = await handleSessionInit(
      "session-3", "user-1", userMessages(), cfg, store, reqCtx,
      metadataClient, "user-key", "space-1", undefined, "dsh",
    );
    expect(result.intercepted).toBe(false);
    expect(result.justRegistered).toBe(true);
    const state = store.get("dsh:session-3");
    expect(state?.status).toBe("initialized");
    expect(state?.agentDetail?.id).toBe("agt-aaa11111");
  });

  it("does NOT converge when not yet past initTimeoutMs", async () => {
    const store = new SessionStore();
    const cfg = baseConfig({ autoDefault: { enabled: true, onUnresolved: "skip" }, initTimeoutMs: 15 * 60 * 1000 });
    await store.set("dsh:session-4", {
      status: "pending_asset_confirm",
      keyId: "session-4",
      startedAt: Date.now() - 5 * 60 * 1000, // 5 分钟前，未超时
      attemptCount: 0,
      userId: "user-1",
      cachedTeams: [teamA],
    } as never);

    const result = await handleSessionInit(
      "session-4", "user-1", userMessages(), cfg, store, reqCtx,
      metadataClient, "user-key", "space-1", undefined, "dsh",
    );
    // 未超时 → 走原状态机（pending_asset_confirm 分支尝试解析答复，未识别 → 重发表单）。
    expect(result.intercepted).toBe(true);
  });
});

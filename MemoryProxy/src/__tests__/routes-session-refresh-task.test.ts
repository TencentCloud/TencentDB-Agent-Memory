/**
 * session-refresh / session-task 路由核心用例（与 force-archive 同风格）：
 * 关键回归是 workbuddy 会话在 codex: 前缀下也能被这些入口找到。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { Hono } from "hono";
import { refreshSessionCache, createSessionRefreshHandler } from "../routes/session-refresh.js";
import {
  createTaskFromSession,
  updateTaskFromSession,
} from "../routes/session-task.js";
import { getSessionStore, __resetSessionStoreForTests } from "../session/store.js";

vi.mock("../meta/client.js", () => ({
  getMetadataClient: vi.fn(() => ({
    getAgent: vi.fn(async (id: string) => ({
      agent_id: id,
      name: "agent",
      description: "desc",
      prompt: "prompt",
    })),
    getTask: vi.fn(async (id: string) => ({
      task_id: id,
      title: "task",
      description: "desc",
    })),
  })),
}));

vi.mock("../injection/index.js", () => ({
  prewarmFromConfig: vi.fn().mockResolvedValue({ cachedHookIds: [], skipped: [] }),
}));

const refreshConfig = {
  coreSkill: { endpoint: "http://core", serviceToken: "t" },
} as never;

const taskConfig = {
  sessionInit: { defaultTaskId: "default" },
} as never;

async function seedWbSession(): Promise<void> {
  const store = getSessionStore();
  store.bind("codex:sk", {
    userId: "u1",
    agentSource: "codex",
    sessionId: "sk",
    spaceId: "sp1",
  });
  await store.set("codex:sk", {
    status: "initialized",
    keyId: "sk",
    startedAt: 1_000_000,
    attemptCount: 0,
    userId: "u1",
    sessionInfo: {
      session_id: "sk",
      user_id: "u1",
      team_id: "t1",
      agent_id: "a1",
      task_id: "t1",
      space_id: "sp1",
      user_key: "k1",
    },
  });
}

describe("refreshSessionCache（workbuddy codex 别名查找）", () => {
  beforeEach(() => {
    __resetSessionStoreForTests();
  });
  afterAll(() => {
    __resetSessionStoreForTests();
  });

  it("agentSource=workbuddy 能刷新 codex: 前缀下的会话缓存", async () => {
    await seedWbSession();
    const result = await refreshSessionCache({
      sessionKey: "sk",
      agentSource: "workbuddy",
      config: refreshConfig,
      spaceId: "sp1",
      callerUserKey: "k1",
    });
    expect(result.success).toBe(true);
    expect(result.agentRefreshed).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("找不到会话 → Session not found", async () => {
    const result = await refreshSessionCache({
      sessionKey: "missing",
      agentSource: "workbuddy",
      config: refreshConfig,
      spaceId: "sp1",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Session not found");
  });
});

describe("session-task 路由核心（查找语义）", () => {
  beforeEach(() => {
    __resetSessionStoreForTests();
  });
  afterAll(() => {
    __resetSessionStoreForTests();
  });

  it("缺少 session_key → 参数错误", async () => {
    const r = await createTaskFromSession({
      sessionKey: "",
      agentSource: "workbuddy",
      config: taskConfig,
      spaceId: "sp1",
      recentMessages: [],
    });
    expect(r.success).toBe(false);
    expect(r.error).toBe("session_key is required");
  });

  it("找不到会话（workbuddy 查询不存在 key）→ Session not found", async () => {
    const r = await createTaskFromSession({
      sessionKey: "missing",
      agentSource: "workbuddy",
      config: taskConfig,
      spaceId: "sp1",
      recentMessages: [],
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain("Session not found");
  });

  it("updateTaskFromSession 同样走统一查找语义", async () => {
    const r = await updateTaskFromSession({
      sessionKey: "missing",
      agentSource: "workbuddy",
      config: taskConfig,
      spaceId: "sp1",
      recentMessages: [],
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain("Session not found");
  });
});
describe("refresh-cache HTTP 端点鉴权", () => {
  it("admin.apiKey 已配置但 Bearer 缺失/错误 → 401", async () => {
    const app = new Hono();
    app.post("/x", createSessionRefreshHandler({ admin: { apiKey: "sek" } } as never));
    const res = await app.request("/x", {
      method: "POST",
      headers: { authorization: "Bearer wrong", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("admin.apiKey 为空 → 公开，未命中会话返回 404 而非 401", async () => {
    const app = new Hono();
    app.post(
      "/x",
      createSessionRefreshHandler({
        admin: { apiKey: "" },
      } as never),
    );
    const res = await app.request("/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_key: "no-such-session", agent_source: "claude-code" }),
    });
    expect(res.status).toBe(404);
  });
});

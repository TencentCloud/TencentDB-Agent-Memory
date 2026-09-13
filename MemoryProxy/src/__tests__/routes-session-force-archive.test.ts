/**
 * 路由核心用例：forceArchiveSkill 通过 buildStoreSessionKey 找到会话状态。
 * 关键回归：workbuddy 会话存在 codex: 前缀下，agentSource="workbuddy" 时
 * 也必须能找到（单点化修复前会静默 "Session not found"）。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { Hono } from "hono";
import { forceArchiveSkill, createSessionForceArchiveHandler } from "../routes/session-force-archive.js";
import { getSessionStore, __resetSessionStoreForTests } from "../session/store.js";

vi.mock("../skill/core-client.js", () => ({
  getCoreSkillClient: vi.fn(() => ({
    forceArchive: vi.fn().mockResolvedValue({ status: "archived" }),
  })),
}));

const config = {
  coreSkill: { endpoint: "http://core", serviceToken: "t" },
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
      space_id: "sp1",
    },
  });
}

describe("forceArchiveSkill（路由核心，workbuddy codex 别名查找）", () => {
  beforeEach(() => {
    __resetSessionStoreForTests();
  });
  afterAll(() => {
    __resetSessionStoreForTests();
  });

  it("agentSource=workbuddy 能找到 codex: 前缀下的会话并归档", async () => {
    await seedWbSession();
    const result = await forceArchiveSkill({
      sessionKey: "sk",
      agentSource: "workbuddy",
      config,
      spaceId: "sp1",
      reason: "test",
    });
    expect(result.success).toBe(true);
    expect(result.status).toBe("archived");
  });

  it("找不到会话 → Session not found", async () => {
    const result = await forceArchiveSkill({
      sessionKey: "missing",
      agentSource: "workbuddy",
      config,
      spaceId: "sp1",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Session not found");
  });
});
describe("force-archive HTTP 端点鉴权", () => {
  it("admin.apiKey 已配置但 Bearer 缺失/错误 → 401", async () => {
    const app = new Hono();
    app.post("/x", createSessionForceArchiveHandler({ admin: { apiKey: "sek" } } as never));
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
      createSessionForceArchiveHandler({
        admin: { apiKey: "" },
        coreSkill: { endpoint: "http://core", serviceToken: "t" },
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

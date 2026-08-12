import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import { createMemoryBridgeHandler } from "../memory/memory-bridge.js";
import { createSkillBridgeHandler } from "../skill/skill-bridge.js";
import { __resetSessionStoreForTests, getSessionStore } from "../session/store.js";

const SESSION_ID = "hermes-ops-test-001";

function testConfig() {
  const config = structuredClone(DEFAULT_CONFIG);
  config.coreSkill = {
    endpoint: "http://memory-core:8420",
    serviceToken: "local",
    serviceId: "default",
    timeoutMs: 1_000,
  };
  return config;
}

async function seedHermesSession(): Promise<void> {
  __resetSessionStoreForTests();
  const store = getSessionStore();
  const sessionInfo = {
    user_id: "user-1",
    team_id: "team-1",
    agent_id: "agent-1",
    session_id: SESSION_ID,
    task_id: "task-1",
    space_id: "default",
  };
  store.bind(`hermes:${SESSION_ID}`, {
    userId: "user-1",
    agentSource: "hermes",
    sessionId: SESSION_ID,
    spaceId: "default",
  });
  await store.set(`hermes:${SESSION_ID}`, {
    status: "initialized",
    keyId: `hermes:${SESSION_ID}`,
    startedAt: Date.now(),
    attemptCount: 1,
    bypassed: false,
    sessionInfo,
    agentDetail: null,
    taskDetail: null,
  });
}

describe("Hermes bridge session compatibility", () => {
  it("resolves a bare Hermes conversation ID in memory-bridge", async () => {
    await seedHermesSession();
    const fetcher = vi.fn(async (_url: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => new Response(
      JSON.stringify({ code: 0, message: "upstream-ok", data: { items: [] } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const app = new Hono();
    app.post(
      "/memory-bridge/v3/scenario/ls",
      createMemoryBridgeHandler(testConfig(), { fetcher }),
    );

    const response = await app.request("http://proxy/memory-bridge/v3/scenario/ls", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-conversation-id": SESSION_ID,
      },
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      user_id: "user-1",
      team_id: "team-1",
      agent_id: "agent-1",
      task_id: "task-1",
    });
  });

  it("resolves a bare Hermes conversation ID in skill-bridge", async () => {
    await seedHermesSession();
    const fetcher = vi.fn(async (_url: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => new Response(
      JSON.stringify({ code: 0, data: { items: [] } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const app = new Hono();
    app.post(
      "/skill-bridge/v3/skill/get",
      createSkillBridgeHandler(testConfig(), { fetcher }),
    );

    const response = await app.request("http://proxy/skill-bridge/v3/skill/get", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-conversation-id": SESSION_ID,
      },
      body: JSON.stringify({ skill_id: "skill-1" }),
    });

    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      user_id: "user-1",
      team_id: "team-1",
      agent_id: "agent-1",
    });
  });
});

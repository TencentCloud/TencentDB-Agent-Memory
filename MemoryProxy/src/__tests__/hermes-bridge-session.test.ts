import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import { createMemoryBridgeHandler } from "../memory/memory-bridge.js";
import { __resetSessionStoreForTests, getSessionStore } from "../session/store.js";
import { createSkillBridgeHandler } from "../skill/skill-bridge.js";

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
  const store = getSessionStore();
  const keyId = `hermes:${SESSION_ID}`;
  store.bind(keyId, {
    userId: "user-1",
    agentSource: "hermes",
    sessionId: SESSION_ID,
    spaceId: "default",
  });
  await store.set(keyId, {
    status: "initialized",
    keyId,
    startedAt: Date.now(),
    attemptCount: 1,
    bypassed: false,
    sessionInfo: {
      user_id: "user-1",
      team_id: "team-1",
      agent_id: "agent-1",
      session_id: SESSION_ID,
      task_id: "task-1",
      space_id: "default",
    },
    agentDetail: null,
    taskDetail: null,
  });
}

describe("Hermes bridge session compatibility", () => {
  beforeEach(() => {
    __resetSessionStoreForTests();
  });

  it("resolves a bare Hermes conversation ID in memory-bridge", async () => {
    await seedHermesSession();
    let outboundBody: Record<string, unknown> | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      outboundBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ code: 0, message: "upstream-ok", data: { items: [] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
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
    expect(await response.json()).toMatchObject({ code: 0, message: "upstream-ok" });
    expect(outboundBody).toMatchObject({
      user_id: "user-1",
      team_id: "team-1",
      agent_id: "agent-1",
      task_id: "task-1",
    });
  });

  it("resolves a bare Hermes conversation ID in skill-bridge", async () => {
    await seedHermesSession();
    let outboundBody: Record<string, unknown> | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      outboundBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ code: 0, message: "upstream-ok", data: { skill_id: "skill-1" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
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
    expect(await response.json()).toMatchObject({ code: 0, message: "upstream-ok" });
    expect(outboundBody).toMatchObject({
      user_id: "user-1",
      team_id: "team-1",
      agent_id: "agent-1",
      skill_id: "skill-1",
    });
  });
});

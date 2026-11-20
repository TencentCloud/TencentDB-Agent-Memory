import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { createMemoryBridgeHandler } from "../memory-bridge.js";
import { __resetSessionStoreForTests, getSessionStore } from "../../session/store.js";
import type { SessionInitState } from "../../session/types.js";
import type { ProxyConfig } from "../../types.js";
import { createSkillBridgeHandler } from "../../skill/skill-bridge.js";

vi.mock("../../db/sessionRepo.js", () => ({
  getSessionRepo: () => undefined,
}));

const CONVERSATION_ID = "codex-session-001";
const SESSION_KEY = `codex:${CONVERSATION_ID}`;

const config = {
  coreSkill: {
    endpoint: "http://memory-core.test:8420",
    serviceId: "space-test",
    serviceToken: "service-token",
    timeoutMs: 1_000,
  },
  tdai: {
    serviceId: "space-test",
  },
  redis: {
    enabled: false,
  },
  storage: {
    enabled: false,
  },
  skillRuntime: {
    allowLlmWrite: false,
  },
} as unknown as ProxyConfig;

function initializedCodexState(): SessionInitState {
  return {
    status: "initialized",
    keyId: SESSION_KEY,
    startedAt: Date.now(),
    attemptCount: 1,
    sessionInfo: {
      session_id: CONVERSATION_ID,
      team_id: "team-test",
      agent_id: "agent-test",
      user_id: "user-test",
      space_id: "space-test",
    },
  };
}

function okFetcher() {
  return vi.fn(async (
    _input: Parameters<typeof fetch>[0],
    _init?: Parameters<typeof fetch>[1],
  ) => new Response(
    JSON.stringify({ code: 0, message: "ok", data: { items: [] } }),
    { status: 200, headers: { "content-type": "application/json" } },
  ));
}

async function seedCodexSession(): Promise<void> {
  await getSessionStore().set(SESSION_KEY, initializedCodexState());
}

beforeEach(() => {
  __resetSessionStoreForTests();
});

afterEach(() => {
  __resetSessionStoreForTests();
});

describe("Codex-prefixed bridge sessions", () => {
  it("resolves a bare Codex conversation id for the memory bridge", async () => {
    await seedCodexSession();
    const fetcher = okFetcher();
    const app = new Hono();
    app.post(
      "/memory-bridge/v3/atomic/search",
      createMemoryBridgeHandler(config, { fetcher: fetcher as unknown as typeof fetch }),
    );

    const response = await app.request(
      "http://proxy.test/memory-bridge/v3/atomic/search",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-conversation-id": CONVERSATION_ID,
          "x-tdai-service-id": "space-test",
        },
        body: JSON.stringify({ query: "needle" }),
      },
    );

    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();
    const body = JSON.parse(String(await fetcher.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      user_id: "user-test",
      team_id: "team-test",
      agent_id: "agent-test",
    });
  });

  it("resolves a bare Codex conversation id for the skill bridge", async () => {
    await seedCodexSession();
    const fetcher = okFetcher();
    const app = new Hono();
    app.post(
      "/skill-bridge/v3/skill/get",
      createSkillBridgeHandler(config, { fetcher: fetcher as unknown as typeof fetch }),
    );

    const response = await app.request(
      "http://proxy.test/skill-bridge/v3/skill/get",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-conversation-id": CONVERSATION_ID,
          "x-tdai-service-id": "space-test",
        },
        body: JSON.stringify({ skill_id: "skill-test" }),
      },
    );

    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();
    const body = JSON.parse(String(await fetcher.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      skill_id: "skill-test",
      user_id: "user-test",
      team_id: "team-test",
      agent_id: "agent-test",
    });
  });
});

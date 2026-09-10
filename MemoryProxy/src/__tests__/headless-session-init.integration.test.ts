import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { initAuth } from "../auth.js";
import { DEFAULT_CONFIG } from "../config.js";
import type { SessionBinding } from "../db/binding-repo.js";
import { getSessionRepo } from "../db/sessionRepo.js";
import { handleChatCompletions } from "../handler.js";
import { registerSessionInitLinkRoutes } from "../routes/session-init-link.js";
import {
  __resetInitLinkStoreForTests,
} from "../session/init-link.js";
import {
  __resetSessionStoreForTests,
  getSessionStore,
} from "../session/store.js";
import type { TeamOption } from "../session/types.js";
import { TdaiClient } from "../tdai/client.js";
import type { ProxyConfig } from "../types.js";

const SESSION_ID = "sess-headless-integration";
const SPACE_ID = "space-headless-integration";
const USER_ID = "usr-headless-integration";
const BINDINGS = new Map<string, SessionBinding>();
const TEAMS: TeamOption[] = [{
  team_id: "team-1",
  team_name: "team-one",
  agents: [{ agent_id: "agt-1", agent_name: "agent-one" }],
  tasks: [{ task_id: "task-1", task_name: "task-one" }],
}];

function installBindingRepo(): void {
  getSessionStore().setBindingRepo({
    getBinding: async (spaceId, sessionId) =>
      BINDINGS.get(`${spaceId}:${sessionId}`) ?? null,
    putBinding: async (spaceId, sessionId, binding) => {
      BINDINGS.set(`${spaceId}:${sessionId}`, binding);
    },
    deleteBinding: async (spaceId, sessionId) => {
      BINDINGS.delete(`${spaceId}:${sessionId}`);
    },
    touchLastSeen: async () => {},
  });
}

function makeConfig(): ProxyConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.upstream.url = "https://upstream.test/v1/chat/completions";
  config.creditReport.url = "https://credit.test/report";
  config.auth = {
    enabled: true,
    url: "https://auth.test",
    timeoutMs: 1000,
  };
  config.coreSkill = {
    endpoint: "https://kernel.test",
    serviceToken: "service-token",
    serviceId: SPACE_ID,
    timeoutMs: 1000,
  };
  config.tdai = {
    enabled: true,
    endpoint: "https://memory.test",
    apiKey: "memory-key",
    serviceId: SPACE_ID,
    memory: {
      enabled: true,
      inject: false,
      writeL0: true,
      recallL1: false,
      injectL2L3: false,
      l1Limit: 5,
      l2Limit: 3,
      timeoutMs: 1000,
    },
  };
  config.sessionInit = {
    ...config.sessionInit,
    enabled: true,
    initLink: {
      hubOrigin: "https://hub.test",
      proxyOrigin: "https://proxy.test",
      ttlMinutes: 10,
    },
  };
  return config;
}

function makeApp(config: ProxyConfig): Hono {
  const app = new Hono();
  app.post("/hermes/:spaceId/v1/chat/completions", (c) =>
    handleChatCompletions(c, config));
  registerSessionInitLinkRoutes(app, config, {
    fetchTeams: async () => ({ teams: TEAMS }),
    createClient: () =>
      ({
        getAgent: async () => ({
          agent_id: "agt-1",
          name: "agent-one",
          description: "agent description",
          prompt: "agent prompt",
        }),
        getTask: async () => ({
          task_id: "task-1",
          title: "task-one",
          description: "task description",
        }),
        appendParticipationLog: async () => ({}),
      }) as never,
  });
  return app;
}

async function chatRequest(app: Hono): Promise<Response> {
  return await app.request(`/hermes/${SPACE_ID}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: "Bearer user-key",
      "content-type": "application/json",
      "x-conversation-id": SESSION_ID,
    },
    body: JSON.stringify({
      model: "test-model",
      stream: false,
      tools: [],
      messages: [{ role: "user", content: "hello" }],
    }),
  });
}

describe("headless session-init integration", () => {
  const upstreamBodies: Record<string, unknown>[] = [];
  const pipelineUrls: string[] = [];

  beforeEach(() => {
    getSessionRepo().deleteBySessionId(
      SPACE_ID,
      USER_ID,
      "hermes",
      SESSION_ID,
    );
    __resetInitLinkStoreForTests();
    __resetSessionStoreForTests();
    BINDINGS.clear();
    upstreamBodies.length = 0;
    pipelineUrls.length = 0;
    installBindingRepo();

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      if (url.startsWith("https://auth.test/")) {
        return Response.json({
          code: 0,
          data: { valid: true, user: { user_id: USER_ID } },
        });
      }
      if (url === "https://upstream.test/v1/chat/completions") {
        upstreamBodies.push(JSON.parse(String(init?.body)));
        return Response.json({
          id: "chatcmpl-test",
          object: "chat.completion",
          choices: [{
            index: 0,
            message: { role: "assistant", content: "upstream answer" },
            finish_reason: "stop",
          }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 2,
            total_tokens: 12,
          },
        });
      }
      if (url.startsWith("https://memory.test/")) {
        pipelineUrls.push(url);
        if (url.endsWith("/v3/meta/config/user/get")) {
          return Response.json({ code: 0, data: {} });
        }
        return Response.json({ code: 0, data: {} });
      }
      if (url === "https://kernel.test/v3/skill/conversation/add") {
        pipelineUrls.push(url);
        return Response.json({ code: 0, data: {} });
      }
      if (url === "https://credit.test/report") {
        return Response.json({ code: 0 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));
  });

  afterEach(() => {
    getSessionRepo().deleteBySessionId(
      SPACE_ID,
      USER_ID,
      "hermes",
      SESSION_ID,
    );
    initAuth({ enabled: false, url: "", timeoutMs: 0 });
    vi.unstubAllGlobals();
  });

  it("links, binds without login, recovers from L2, and resumes context, L0, and skill pipelines", async () => {
    const addConversation = vi.spyOn(TdaiClient.prototype, "addConversation");
    const config = makeConfig();
    initAuth(config.auth);
    const app = makeApp(config);

    const first = await chatRequest(app);
    expect(first.status).toBe(200);
    const firstBody = await first.json() as {
      choices: Array<{ message: { content: string } }>;
    };
    const link = firstBody.choices[0].message.content.match(
      /https:\/\/hub\.test\/#\/session-init\?[^\s)]+/,
    )?.[0];
    expect(link).toBeTruthy();
    const token = new URLSearchParams(new URL(link!).hash.split("?")[1]).get("token");
    expect(token).toBeTruthy();

    const register = await app.request(`/v3/session/init-link/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "agt-1", task_id: "task-1" }),
    });
    expect(register.status).toBe(200);

    __resetSessionStoreForTests();
    installBindingRepo();
    const second = await chatRequest(app);
    expect(second.status).toBe(200);
    expect(upstreamBodies).toHaveLength(2);

    const secondMessages = upstreamBodies[1].messages as Array<{
      role: string;
      content: string;
    }>;
    expect(secondMessages.some((message) =>
      message.role === "system" &&
      message.content.includes("<session_context>") &&
      message.content.includes("agent-one") &&
      message.content.includes("task-one"),
    )).toBe(true);

    const secondBody = await second.json() as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(secondBody.choices[0].message.content).toBe("upstream answer");
    expect(addConversation).toHaveBeenCalledTimes(1);
    expect(pipelineUrls).toContain("https://kernel.test/v3/skill/conversation/add");
  });
});

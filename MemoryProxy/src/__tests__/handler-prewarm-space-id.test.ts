import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initAuth } from "../auth.js";
import { DEFAULT_CONFIG } from "../config.js";
import {
  __resetHookCacheRepoForTests,
  setHookCacheRepo,
  type HookCacheEntry,
  type HookCacheRepo,
} from "../db/hookCacheRepo.js";
import {
  __resetSessionRepoForTests,
  setSessionRepo,
  type SessionRepo,
} from "../db/sessionRepo.js";
import { __resetInjectionPipelineForTests } from "../injection/index.js";
import type { ContextBlock } from "../injection/types.js";
import { createApp } from "../server.js";
import {
  __resetSessionStoreForTests,
  getSessionStore,
} from "../session/store.js";
import type { SessionInitState, SessionInfo } from "../session/types.js";
import { setCoreSkillClient } from "../skill/core-client.js";
import { _resetSystemUsersForTest } from "../systemUser.js";
import type { ProxyConfig } from "../types.js";

const SPACE_ID = "default";
const USER_ID = "usr-prewarm-test";
const SESSION_ID = "session-prewarm-test";

const servers: Server[] = [];
let logs: string[] = [];
let warnings: string[] = [];

beforeEach(() => {
  resetSingletons();
  initAuth({ enabled: false, url: "", timeoutMs: 500 });
  _resetSystemUsersForTest();
  logs = [];
  warnings = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetSingletons();
  await Promise.all(servers.splice(0).map(closeServer));
});

describe("first-turn Hook Cache prewarm", () => {
  it("uses the request spaceId in the OpenAI handler", async () => {
    await expectPrewarmUsesRequestSpaceId("openai");
  });

  it("uses the request spaceId in the Anthropic handler", async () => {
    await expectPrewarmUsesRequestSpaceId("anthropic");
  });
});

async function expectPrewarmUsesRequestSpaceId(protocol: "openai" | "anthropic"): Promise<void> {
  const agentSource = protocol === "openai" ? "codebuddy" : "claude-code";
  const upstreamBodies: Record<string, unknown>[] = [];
  const upstream = createTestUpstream(protocol, upstreamBodies);
  servers.push(upstream);
  const upstreamUrl = await listen(upstream);

  const hookCache = new RecordingHookCacheRepo();
  setHookCacheRepo(hookCache);
  setSessionRepo(noopSessionRepo());

  const sessionInfo: SessionInfo = {
    session_id: SESSION_ID,
    team_id: "team-prewarm-test",
    agent_id: "agent-prewarm-test",
    user_id: USER_ID,
    space_id: SPACE_ID,
  };
  const compositeKey = `${agentSource}:${SESSION_ID}`;
  const store = getSessionStore();
  store.bind(compositeKey, {
    spaceId: SPACE_ID,
    userId: USER_ID,
    agentSource,
    sessionId: SESSION_ID,
  });
  const state: SessionInitState = {
    status: "initialized",
    keyId: compositeKey,
    startedAt: Date.now(),
    attemptCount: 0,
    userId: USER_ID,
    sessionInfo,
    agentDetail: { id: sessionInfo.agent_id, name: "Prewarm Test Agent" },
    taskDetail: null,
  };
  await store.set(compositeKey, state);

  const app = createApp(testConfig(upstreamUrl));
  const response = await app.request(requestPath(protocol), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-conversation-id": SESSION_ID,
      "x-user-id": USER_ID,
    },
    body: JSON.stringify(requestBody(protocol)),
  });

  expect(response.status).toBe(200);
  expect(hookCache.prewarmWrites).toHaveLength(1);
  expect(hookCache.prewarmWrites[0]?.spaceId).toBe(SPACE_ID);
  expect(hookCache.liveReads.length).toBeGreaterThan(0);
  expect(hookCache.liveReads.every((read) => read.spaceId === SPACE_ID)).toBe(true);
  expect(hookCache.selfHealWrites).toHaveLength(0);
  expect(logs.some((line) => line.includes("hook=skill-tools-injector hit"))).toBe(true);
  expect(logs.some((line) => line.includes("hook=skill-tools-injector miss"))).toBe(false);
  expect(warnings.some((line) => line.includes("[hook-cache]") && line.includes("failed"))).toBe(false);
  expect(upstreamBodies.some((body) => JSON.stringify(body).includes("<skill_tools>"))).toBe(true);
}

function testConfig(upstreamUrl: string): ProxyConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.upstream.url = upstreamUrl;
  config.server.forwardTimeoutMs = 2_000;
  config.rateLimit = { tpm: 0, qpm: 0 };
  config.extraction = { enabled: false, extractors: [] };
  config.sessionInit.enabled = true;
  config.injection.enabled = true;
  config.injection.injectors = ["skill"];
  config.injection.externalGatewayUrl = upstreamUrl;
  config.coreSkill = {
    endpoint: upstreamUrl,
    serviceToken: "test-service-token",
    serviceId: SPACE_ID,
    timeoutMs: 500,
  };
  config.tdai.endpoint = upstreamUrl;
  config.tdai.memory.timeoutMs = 500;
  config.log.level = "info";
  return config;
}

function requestPath(protocol: "openai" | "anthropic"): string {
  return protocol === "openai"
    ? `/codebuddy/${SPACE_ID}/v1/chat/completions`
    : `/claude-code/${SPACE_ID}/v1/messages`;
}

function requestBody(protocol: "openai" | "anthropic"): Record<string, unknown> {
  if (protocol === "openai") {
    return {
      model: "test-model",
      stream: false,
      messages: [
        { role: "system", content: "<agent_skills>\n</agent_skills>" },
        { role: "user", content: "hello" },
      ],
    };
  }
  return {
    model: "test-model",
    max_tokens: 64,
    stream: false,
    system: "# Skills\n",
    messages: [{ role: "user", content: "hello" }],
  };
}

function createTestUpstream(
  protocol: "openai" | "anthropic",
  upstreamBodies: Record<string, unknown>[],
): Server {
  return createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};

    response.setHeader("content-type", "application/json");
    if (request.url === "/v3/meta/config/user/get") {
      response.end(JSON.stringify({ code: 0, data: { items: [] } }));
      return;
    }
    if (request.url === "/v3/skill/listing") {
      response.end(JSON.stringify({
        code: 0,
        data: { mode: "full", listing: "", hits: [] },
      }));
      return;
    }

    upstreamBodies.push(body);
    if (protocol === "openai") {
      response.end(JSON.stringify({
        id: "chatcmpl-prewarm-test",
        object: "chat.completion",
        model: "test-model",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        }],
      }));
      return;
    }
    response.end(JSON.stringify({
      id: "msg-prewarm-test",
      type: "message",
      role: "assistant",
      model: "test-model",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
    }));
  });
}

class RecordingHookCacheRepo implements HookCacheRepo {
  readonly prewarmWrites: Array<{ spaceId: string; entries: HookCacheEntry[] }> = [];
  readonly liveReads: Array<{ spaceId: string; hookId: string }> = [];
  readonly selfHealWrites: Array<{ spaceId: string; hookId: string }> = [];
  private readonly entries = new Map<string, ContextBlock[]>();

  put(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    hookId: string,
    blocks: ContextBlock[],
  ): void {
    this.selfHealWrites.push({ spaceId, hookId });
    this.entries.set(cacheKey(spaceId, userId, agentSource, sessionId, hookId), blocks);
  }

  putMany(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    entries: HookCacheEntry[],
  ): void {
    this.prewarmWrites.push({ spaceId, entries });
    for (const entry of entries) {
      this.entries.set(
        cacheKey(spaceId, userId, agentSource, sessionId, entry.hookId),
        entry.blocks,
      );
    }
  }

  async get(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    hookId: string,
  ): Promise<ContextBlock[] | null> {
    this.liveReads.push({ spaceId, hookId });
    return this.entries.get(cacheKey(spaceId, userId, agentSource, sessionId, hookId)) ?? null;
  }

  async getAllForSession(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): Promise<HookCacheEntry[]> {
    const prefix = `${spaceId}:${userId}:${agentSource}:${sessionId}:`;
    return Array.from(this.entries.entries())
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, blocks]) => ({ hookId: key.slice(prefix.length), blocks }));
  }

  clearBySession(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): void {
    const prefix = `${spaceId}:${userId}:${agentSource}:${sessionId}:`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }
}

function noopSessionRepo(): SessionRepo {
  return {
    async upsert() {},
    async getBySessionId() { return null; },
    deleteBySessionId() {},
    async loadAllInitialized() { return []; },
  };
}

function cacheKey(
  spaceId: string,
  userId: string,
  agentSource: string,
  sessionId: string,
  hookId: string,
): string {
  return `${spaceId}:${userId}:${agentSource}:${sessionId}:${hookId}`;
}

function resetSingletons(): void {
  __resetInjectionPipelineForTests();
  __resetSessionStoreForTests();
  __resetHookCacheRepoForTests();
  __resetSessionRepoForTests();
  setCoreSkillClient(null);
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

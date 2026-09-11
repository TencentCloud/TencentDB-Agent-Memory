/**
 * Fresh-context spec tests — memory-bridge identity resolution.
 *
 * Written against the endpoint SPEC (not the implementation) by a fresh
 * subagent (Corolario C, ronda 2026-09-09); caso (d) de colisión proviene
 * del hallazgo HIGH del crítico codex.
 *
 * The session store singleton keys state as `${agentSource}:${sessionId}`
 * (e.g. `opencode:ses_abc`, `claude-code:ses_abc`). The handler must resolve
 * the caller's identity from a seeded session under either prefix when the
 * bare sid arrives, reject with 40101 when it exists under no key, and
 * REJECT (40901) when a bare id matches several distinct identities.
 *
 * Deliberately does NOT go through createApp() (server.ts) so the route layer
 * is out of scope; the handler is mounted exactly as server.ts registers it.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { Hono } from "hono";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMemoryBridgeHandler } from "../memory/memory-bridge.js";
import { __resetSessionStoreForTests, getSessionStore } from "../session/store.js";
import type { SessionInfo, SessionInitState } from "../session/types.js";
import { __resetSessionRepoForTests } from "../db/sessionRepo.js";
import type { ProxyConfig } from "../types.js";

// Keep the lazily-created sqlite SessionRepo out of the developer's real
// ~/.tdai-memory-proxy. The store resolves its repo on first getSessionStore().
process.env.PROXY_DB_PATH = join(
  tmpdir(),
  `memory-bridge-identity-test-${process.pid}.sqlite`,
);

const SPACE_ID = "mem-example001";

/** All sections disabled except tdai (the bridge's forward target). Cast per test convention. */
function minimalConfig(): ProxyConfig {
  return {
    server: { host: "127.0.0.1", port: 0 },
    upstream: { url: "http://upstream.test", apiKey: "", agents: {} },
    log: {
      file: "",
      verbose: false,
      level: "info",
      backend: "noop",
      rotate: { maxSizeBytes: 0, backupLimit: 0 },
    },
    opik: { enabled: false, url: "", apiKey: "", stripRequestLogContent: false },
    langfuse: {
      enabled: false,
      host: "",
      publicKey: "",
      secretKey: "",
      maxQueueSize: 0,
      flushAt: 0,
      flushInterval: 0,
    },
    clickhouse: {
      enabled: false,
      url: "",
      database: "",
      table: "",
      rawTable: "",
      user: "",
      password: "",
      flushIntervalMs: 0,
      flushThreshold: 0,
      ttlDays: 0,
    },
    redis: {
      enabled: false,
      url: "",
      host: "127.0.0.1",
      port: 6379,
      password: "",
      db: 0,
      keyPrefix: "cg:sess:",
      ttlSeconds: 1800,
    },
    rateLimit: { tpm: 0, qpm: 0 },
    storage: {
      enabled: false,
      backend: "memory",
      ttlDays: 7,
      cos: {
        rootPrefix: "",
        shark: {
          baseUrl: "",
          timeoutMs: 0,
          retryCount: 0,
          refreshBufferMs: 0,
          maxSpaces: 0,
          graceCloseDelayMs: 0,
        },
      },
      sqlite: { dbPath: "" },
      fs: { fsRoot: "" },
    },
    costGuard: { enabled: false, options: {} },
    creditReport: { url: "", timeoutMs: 0 },
    creditPricing: { models: [] },
    injection: { enabled: false, injectors: [] },
    extraction: { enabled: false, extractors: [] },
    sessionInit: { enabled: false, maxRetries: 0 },
    tdai: {
      enabled: true,
      endpoint: "http://tdai-kernel.test",
      apiKey: "test-api-key",
      serviceId: SPACE_ID,
      memory: {
        enabled: true,
        inject: true,
        writeL0: false,
        recallL1: true,
        injectL2L3: false,
        l1Limit: 5,
        l2Limit: 3,
        timeoutMs: 2000,
      },
    },
    coreSkill: { endpoint: "", serviceToken: "", serviceId: "context-proxy", timeoutMs: 100 },
    knowledge: { enabled: false, endpoint: "", serviceToken: "", serviceId: "context-proxy", timeoutMs: 100 },
    skillRuntime: { allowLlmWrite: false },
    auth: { enabled: false, url: "", serviceToken: "", timeoutMs: 0 },
    systemUsers: [],
    admin: { apiKey: "" },
    memCommand: {},
    ccRequestRouting: { enabled: false },
    workbuddyRequestRouting: { enabled: false },
    traceArchive: { enabled: false, dir: "" },
  } as unknown as ProxyConfig;
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Seed the singleton store the same way the session-init state machine does:
 * status=initialized with a fully-qualified sessionInfo so the derived
 * identity has user_id/team_id/agent_id/session_id defined. No bind() →
 * L1-only (the store skips repo/binding writes when no identity is bound).
 */
async function seedInitializedSession(
  agentSource: string,
  sessionId: string,
  identity = { userId: "usr-test", teamId: "team-alpha", agentId: "agent-alpha" },
): Promise<void> {
  const keyId = `${agentSource}:${sessionId}`;
  const state: SessionInitState = {
    status: "initialized",
    keyId,
    startedAt: Date.now(),
    attemptCount: 0,
    bypassed: false,
    userId: identity.userId,
    agentDetail: null,
    taskDetail: null,
    sessionInfo: {
      session_id: sessionId,
      user_id: identity.userId,
      team_id: identity.teamId,
      agent_id: identity.agentId,
      space_id: SPACE_ID,
    } satisfies SessionInfo,
  };
  await getSessionStore().set(keyId, state);
}

/** Mount the bridge handler exactly as server.ts does (POST /memory-bridge/*). */
function buildApp(): Hono {
  const app = new Hono();
  const handler = createMemoryBridgeHandler(minimalConfig());
  app.post("/memory-bridge/*", (c) => handler(c));
  return app;
}

interface ParsedEnvelope {
  code?: number | string;
  message?: string;
}

async function postSearch(
  app: Hono,
  bareSid: string,
): Promise<{ text: string; parsed: ParsedEnvelope }> {
  const res = await app.request("/memory-bridge/v3/atomic/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-conversation-id": bareSid,
      "x-tdai-service-id": SPACE_ID,
    },
    body: JSON.stringify({ query: "pending deployment steps", limit: 5 }),
  });
  const text = await res.text();
  let parsed: ParsedEnvelope = {};
  try {
    parsed = JSON.parse(text) as ParsedEnvelope;
  } catch {
    // non-JSON body — assertions on parsed.code will fail loudly, text still asserted
  }
  return { text, parsed };
}

let fetchMock: Mock;

beforeEach(() => {
  __resetSessionStoreForTests();
  __resetSessionRepoForTests();
  // Kernel stub: ACL checks allowed, every other endpoint answers code 0.
  fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/v3/meta/acl/check")) {
        return jsonResponse({ code: 0, message: "ok", data: { allowed: true } });
      }
      return jsonResponse({ code: 0, message: "ok", data: { items: [] } });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("memory-bridge identity resolution (POST /memory-bridge/v3/atomic/search)", () => {
  it("(a) resolves a bare conversation id against a seeded opencode:<sid> session", async () => {
    const sid = "ses_opencode_bare";
    await seedInitializedSession("opencode", sid);
    const app = buildApp();

    const { text, parsed } = await postSearch(app, sid);

    // Spec: identity must resolve → NOT the 40101 session-not-initialized rejection.
    expect(Number(parsed.code)).not.toBe(40101);
    expect(text).not.toContain("session not initialized");
    // The request must have proceeded past identity gating to the kernel call.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
  });

  it("(b) still resolves claude-code:<sid> (regression: opencode support must not break CC)", async () => {
    const sid = "ses_claude_bare";
    await seedInitializedSession("claude-code", sid);
    const app = buildApp();

    const { text, parsed } = await postSearch(app, sid);

    expect(Number(parsed.code)).not.toBe(40101);
    expect(text).not.toContain("session not initialized");
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
  });

  it("(c) rejects with 40101 'session not initialized' when the sid exists under no key", async () => {
    const app = buildApp();

    const { text, parsed } = await postSearch(app, "ses_never_seeded");

    expect(Number(parsed.code)).toBe(40101);
    expect(text).toContain("session not initialized");
  });

  it("(d) codex-HIGH: bare id colliding across sources with DISTINCT identities must not silently pick one", async () => {
    const sid = "ses_collision";
    await seedInitializedSession("claude-code", sid, {
      userId: "usr-cc",
      teamId: "team-alpha",
      agentId: "agent-cc",
    });
    await seedInitializedSession("opencode", sid, {
      userId: "usr-oc",
      teamId: "team-beta",
      agentId: "agent-oc",
    });
    const app = buildApp();

    const { text, parsed } = await postSearch(app, sid);

    // Neither identity may win silently: expect explicit ambiguity rejection.
    expect(Number(parsed.code)).toBe(40901);
    expect(text).toContain("multiple agent sources");
    expect(text).not.toContain("usr-cc");
    expect(text).not.toContain("usr-oc");
  });
});

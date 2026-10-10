import { describe, expect, it, beforeEach } from "vitest";
import { Hono } from "hono";
import { SessionStore, getSessionStore, __resetSessionStoreForTests } from "../session/store.js";
import { createMemoryBridgeHandler } from "../memory/memory-bridge.js";
import type { SessionInitState } from "../session/types.js";
import type { ProxyConfig } from "../types.js";

function makeInitializedState(
  agentId: string,
  teamId: string,
  sessionId: string,
): SessionInitState {
  return {
    status: "initialized",
    keyId: "",
    startedAt: Date.now(),
    attemptCount: 0,
    sessionInfo: {
      session_id: sessionId,
      team_id: teamId,
      agent_id: agentId,
      user_id: "usr-test",
      user_key: "key-test",
      space_id: "default",
    },
    userId: "usr-test",
    agentDetail: null,
    taskDetail: null,
  };
}

/** Minimal config — memory-bridge only needs coreSkill.endpoint (+ optional tdai). */
function makeBridgeConfig(): ProxyConfig {
  return {
    coreSkill: {
      endpoint: "http://upstream.test",
      serviceToken: "tok",
      serviceId: "default",
      timeoutMs: 5_000,
    },
    tdai: { enabled: false, apiKey: "", serviceId: "default" },
  } as unknown as ProxyConfig;
}

describe("SessionStore.keysWithSuffix", () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(30 * 60 * 1000);
  });

  it("finds a key by bare sessionId match", () => {
    store.set("pi:abc-123", makeInitializedState("agt-1", "team-1", "abc-123"));
    expect(store.keysWithSuffix("abc-123")).toEqual(["pi:abc-123"]);
  });

  it("finds keys by `:${sessionId}` suffix across multiple agent sources", () => {
    store.set("pi:abc-123", makeInitializedState("agt-1", "team-1", "abc-123"));
    store.set("dsh:abc-123", makeInitializedState("agt-2", "team-2", "abc-123"));
    store.set("claude-code:abc-123", makeInitializedState("agt-3", "team-3", "abc-123"));
    store.set("codex:def-456", makeInitializedState("agt-4", "team-4", "def-456"));
    const found = store.keysWithSuffix("abc-123");
    expect(found.sort()).toEqual(["claude-code:abc-123", "dsh:abc-123", "pi:abc-123"]);
  });

  it("returns empty array when no key matches", () => {
    store.set("pi:abc-123", makeInitializedState("agt-1", "team-1", "abc-123"));
    expect(store.keysWithSuffix("zzz-000")).toEqual([]);
  });

  it("does not match a sessionId that is a substring but not a suffix", () => {
    store.set("pi:abc-123-extra", makeInitializedState("agt-1", "team-1", "abc-123-extra"));
    expect(store.keysWithSuffix("abc-123")).toEqual([]);
  });
});

describe("memory-bridge L1 resolution via keysWithSuffix", () => {
  beforeEach(() => {
    __resetSessionStoreForTests();
  });

  async function postBridge(
    conversationId: string,
    fetcher: typeof fetch,
  ): Promise<Response> {
    const app = new Hono();
    const handler = createMemoryBridgeHandler(makeBridgeConfig(), { fetcher });
    app.post("/memory-bridge/*", (c) => handler(c));
    return app.request("http://localhost/memory-bridge/v3/atomic/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-conversation-id": conversationId,
        "x-tdai-service-id": "default",
      },
      body: "{}",
    });
  }

  it("resolves a pi-prefixed L1 session from a bare x-conversation-id", async () => {
    const store = getSessionStore();
    store.set("pi:pi-01abc", makeInitializedState("agt-ea0b0wybln", "team-azqo3jvm25", "pi-01abc"));

    let upstreamBody: unknown;
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const res = await postBridge("pi-01abc", fetcher);
    expect(res.status).toBe(200);
    // session_id is only forwarded when the caller sets it; identity inject is team/user/agent.
    expect(upstreamBody).toMatchObject({
      agent_id: "agt-ea0b0wybln",
      team_id: "team-azqo3jvm25",
      user_id: "usr-test",
    });
  });

  it("resolves a dsh-prefixed L1 session from a bare x-conversation-id", async () => {
    const store = getSessionStore();
    store.set("dsh:dsh-02def", makeInitializedState("agt-dsh", "team-dsh", "dsh-02def"));

    const fetcher = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const res = await postBridge("dsh-02def", fetcher);
    expect(res.status).toBe(200);
  });

  it("still returns 40101 when no L1 key matches the bare conversation id", async () => {
    const store = getSessionStore();
    store.set("pi:other-session", makeInitializedState("agt-1", "team-1", "other-session"));

    const fetcher = (async () => {
      throw new Error("upstream must not be called on L1 miss");
    }) as typeof fetch;

    const res = await postBridge("missing-session", fetcher);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ code: 40101 });
  });
});

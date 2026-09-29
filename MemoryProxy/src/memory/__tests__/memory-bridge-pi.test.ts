import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { DEFAULT_CONFIG } from "../../config.js";
import type { BindingRepo } from "../../db/binding-repo.js";
import {
  __resetSessionStoreForTests,
  getSessionStore,
} from "../../session/store.js";
import { createMemoryBridgeHandler } from "../memory-bridge.js";

describe("memory bridge Pi session resolution", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    __resetSessionStoreForTests();
  });

  it("resolves a bare Pi session from L1 without falling back to L2", async () => {
    __resetSessionStoreForTests();
    const store = getSessionStore();
    const sessionId = "pi-http-regression";
    await store.set(`pi:${sessionId}`, {
      status: "initialized",
      keyId: `pi:${sessionId}`,
      startedAt: Date.now(),
      attemptCount: 0,
      sessionInfo: {
        session_id: sessionId,
        user_id: "user-pi",
        team_id: "team-pi",
        agent_id: "agent-pi",
        task_id: "task-pi",
        space_id: "space-pi",
      },
    });

    const getBinding = vi.fn();
    vi.spyOn(store, "getBindingRepo").mockReturnValue({
      getBinding,
    } as unknown as BindingRepo);

    const upstreamFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
        JSON.stringify({ code: 0, message: "ok", data: { items: [] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const config = {
      ...DEFAULT_CONFIG,
      tdai: { ...DEFAULT_CONFIG.tdai, apiKey: "test-api-key" },
      coreSkill: {
        ...DEFAULT_CONFIG.coreSkill,
        endpoint: "http://core.example",
        serviceToken: "test-service-token",
      },
    };
    const handler = createMemoryBridgeHandler(config, {
      fetcher: upstreamFetch as unknown as typeof fetch,
    });
    const app = new Hono();
    app.post("/memory-bridge/*", (c) => handler(c));

    const response = await app.request("/memory-bridge/v3/atomic/query", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-conversation-id": sessionId,
        "x-tdai-service-id": "space-pi",
      },
      body: JSON.stringify({ type: "fact" }),
    });

    expect(response.status).toBe(200);
    expect(getBinding).not.toHaveBeenCalled();
    expect(upstreamFetch).toHaveBeenCalledOnce();

    const [url, init] = upstreamFetch.mock.calls[0];
    expect(url).toBe("http://core.example/v3/atomic/query");
    expect(JSON.parse(String(init?.body))).toEqual({
      type: "fact",
      user_id: "user-pi",
      team_id: "team-pi",
      agent_id: "agent-pi",
      task_id: "task-pi",
    });
  });
});

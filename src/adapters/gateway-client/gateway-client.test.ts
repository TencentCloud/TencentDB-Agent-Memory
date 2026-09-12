import { describe, expect, it } from "vitest";
import {
  GatewayMemoryClient,
  GatewayMemoryClientError,
  createGatewayPlatformAdapter,
} from "./index.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GatewayMemoryClient", () => {
  it("sends authenticated recall requests to the gateway", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new GatewayMemoryClient({
      baseUrl: "http://127.0.0.1:8420/",
      apiKey: "secret",
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return jsonResponse({ context: "memory", strategy: "bm25", memory_count: 1 });
      },
    });

    const result = await client.recall({
      query: "what did we decide?",
      session_key: "session-a",
      user_id: "user-a",
    });

    expect(result).toEqual({ context: "memory", strategy: "bm25", memory_count: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:8420/recall");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer secret",
    });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      query: "what did we decide?",
      session_key: "session-a",
      user_id: "user-a",
    });
  });

  it("surfaces gateway error status and body", async () => {
    const client = new GatewayMemoryClient({
      baseUrl: "http://127.0.0.1:8420",
      fetchImpl: async () => new Response("bad query", { status: 400 }),
    });

    await expect(client.searchMemories({ query: "" })).rejects.toMatchObject({
      name: "GatewayMemoryClientError",
      status: 400,
      path: "/search/memories",
      responseBody: "bad query",
    } satisfies Partial<GatewayMemoryClientError>);
  });
});

describe("createGatewayPlatformAdapter", () => {
  it("maps host lifecycle calls to gateway recall/capture/session APIs", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const client = new GatewayMemoryClient({
      baseUrl: "http://127.0.0.1:8420",
      fetchImpl: async (url, init) => {
        calls.push({
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        if (String(url).endsWith("/capture")) {
          return jsonResponse({ l0_recorded: 2, scheduler_notified: true });
        }
        if (String(url).endsWith("/session/end")) {
          return jsonResponse({ flushed: true });
        }
        return jsonResponse({ context: "remember this", strategy: "hybrid", memory_count: 3 });
      },
    });
    const adapter = createGatewayPlatformAdapter({
      client,
      platform: "codex",
      resolveContext: () => ({
        sessionKey: "codex-session",
        sessionId: "run-1",
        userId: "developer",
      }),
    });

    await adapter.prefetch("next task");
    await adapter.captureTurn({
      userText: "fix the bug",
      assistantText: "patched it",
      messages: [{ role: "user", content: "fix the bug" }],
    });
    await adapter.endSession();

    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:8420/recall",
        body: {
          query: "next task",
          session_key: "codex-session",
          user_id: "developer",
        },
      },
      {
        url: "http://127.0.0.1:8420/capture",
        body: {
          user_content: "fix the bug",
          assistant_content: "patched it",
          messages: [{ role: "user", content: "fix the bug" }],
          session_key: "codex-session",
          session_id: "run-1",
          user_id: "developer",
        },
      },
      {
        url: "http://127.0.0.1:8420/session/end",
        body: {
          session_key: "codex-session",
          user_id: "developer",
        },
      },
    ]);
  });
});

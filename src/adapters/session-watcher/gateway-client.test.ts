import { describe, expect, it } from "vitest";
import {
  GatewayMemoryClient,
  GatewayMemoryClientError,
  createGatewayPlatformAdapter,
} from "./gateway-client.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GatewayMemoryClient", () => {
  it("health returns status", async () => {
    const client = new GatewayMemoryClient({
      baseUrl: "http://127.0.0.1:18420",
      fetchImpl: async () => json({ status: "ok", version: "1", uptime: 1, stores: { vectorStore: true, embeddingService: true } }),
    });
    const res = await client.health();
    expect(res.status).toBe("ok");
  });

  it("recall sends structured body with auth", async () => {
    let captured: { url: string; method: string; headers: Record<string, string>; body: unknown } | undefined;
    const client = new GatewayMemoryClient({
      baseUrl: "http://127.0.0.1:18420",
      apiKey: "secret",
      fetchImpl: async (url, init) => {
        captured = {
          url: String(url),
          method: init?.method ?? "",
          headers: (init?.headers ?? {}) as Record<string, string>,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        };
        return json({ context: "memory", strategy: "bm25", memory_count: 1 });
      },
    });

    const res = await client.recall({ query: "what", session_key: "s1" });
    expect(res.context).toBe("memory");
    expect(res.strategy).toBe("bm25");
    expect(res.memory_count).toBe(1);
    expect(captured!.url).toContain("/recall");
    expect(captured!.method).toBe("POST");
    expect(captured!.headers["Authorization"]).toBe("Bearer secret");
    expect(captured!.body).toEqual({ query: "what", session_key: "s1" });
  });

  it("capture sends full body with optional fields", async () => {
    let body: unknown;
    const client = new GatewayMemoryClient({
      baseUrl: "http://127.0.0.1:18420",
      fetchImpl: async (_url, init) => {
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
        return json({ l0_recorded: 3, scheduler_notified: true });
      },
    });

    const res = await client.capture({
      user_content: "fix bug",
      assistant_content: "done",
      session_key: "s1",
      session_id: "sid1",
      messages: [{ role: "user", content: "fix bug" }],
    });
    expect(res.l0_recorded).toBe(3);
    expect(body).toEqual({
      user_content: "fix bug",
      assistant_content: "done",
      session_key: "s1",
      session_id: "sid1",
      messages: [{ role: "user", content: "fix bug" }],
    });
  });

  it("searchMemories sends typed request", async () => {
    let body: unknown;
    const client = new GatewayMemoryClient({
      baseUrl: "http://127.0.0.1:18420",
      fetchImpl: async (_url, init) => {
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
        return json({ results: "found", total: 2, strategy: "hybrid" });
      },
    });

    const res = await client.searchMemories({ query: "docker", limit: 3, type: "episodic", scene: "auth" });
    expect(res.total).toBe(2);
    expect(body).toEqual({ query: "docker", limit: 3, type: "episodic", scene: "auth" });
  });

  it("searchConversations sends typed request", async () => {
    let body: unknown;
    const client = new GatewayMemoryClient({
      baseUrl: "http://127.0.0.1:18420",
      fetchImpl: async (_url, init) => {
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
        return json({ results: "msgs", total: 1 });
      },
    });

    const res = await client.searchConversations({ query: "login", limit: 3, session_key: "s1" });
    expect(res.total).toBe(1);
    expect(body).toEqual({ query: "login", limit: 3, session_key: "s1" });
  });

  it("throws GatewayMemoryClientError on non-ok response", async () => {
    const client = new GatewayMemoryClient({
      baseUrl: "http://127.0.0.1:18420",
      fetchImpl: async () => new Response("bad request", { status: 400 }),
    });

    await expect(client.searchMemories({ query: "" })).rejects.toMatchObject({
      name: "GatewayMemoryClientError",
      status: 400,
      path: "/search/memories",
      responseBody: "bad request",
    });
  });
});

describe("createGatewayPlatformAdapter", () => {
  it("maps lifecycle calls to gateway endpoints", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const client = new GatewayMemoryClient({
      baseUrl: "http://127.0.0.1:18420",
      fetchImpl: async (url, init) => {
        calls.push({
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        if (String(url).endsWith("/capture")) return json({ l0_recorded: 2, scheduler_notified: true });
        if (String(url).endsWith("/session/end")) return json({ flushed: true });
        return json({ context: "remember", strategy: "hybrid", memory_count: 3 });
      },
    });

    const adapter = createGatewayPlatformAdapter({
      client,
      platform: "codex",
      resolveContext: () => ({ sessionKey: "s1", sessionId: "run-1", userId: "dev" }),
    });

    await adapter.prefetch("next task");
    await adapter.captureTurn({ userText: "fix", assistantText: "done", messages: [{ role: "user", content: "fix" }] });
    await adapter.endSession();

    expect(calls).toEqual([
      { url: "http://127.0.0.1:18420/recall", body: { query: "next task", session_key: "s1", user_id: "dev" } },
      { url: "http://127.0.0.1:18420/capture", body: { user_content: "fix", assistant_content: "done", messages: [{ role: "user", content: "fix" }], session_key: "s1", session_id: "run-1", user_id: "dev" } },
      { url: "http://127.0.0.1:18420/session/end", body: { session_key: "s1", user_id: "dev" } },
    ]);
  });
});

import { describe, expect, it, vi } from "vitest";
import { CodingAgentGatewayClient } from "./gateway-client";

function createJsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function captureFetch(responseBody: unknown = {}): {
  calls: Array<{ input: string; init: RequestInit }>;
  fetchImpl: typeof fetch;
} {
  const calls: Array<{ input: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input: String(input), init: init ?? {} });
    return createJsonResponse(responseBody);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("CodingAgentGatewayClient", () => {
  it("posts recall requests with session and bearer auth", async () => {
    const { calls, fetchImpl } = captureFetch({ context: "remembered", strategy: "hybrid", memory_count: 1 });
    const client = new CodingAgentGatewayClient({
      baseUrl: "http://127.0.0.1:3818/",
      apiKey: "secret",
      fetchImpl,
    });

    const result = await client.recall("what did we decide?", {
      sessionKey: "workspace-a:task-1",
      userId: "user-1",
      platform: "codex",
    });

    expect(result.context).toBe("remembered");
    expect(calls[0].input).toBe("http://127.0.0.1:3818/recall");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toMatchObject({
      Authorization: "Bearer secret",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      query: "what did we decide?",
      session_key: "workspace-a:task-1",
      user_id: "user-1",
    });
  });

  it("maps coding-agent turns to capture payloads", async () => {
    const { calls, fetchImpl } = captureFetch({ l0_recorded: 2, scheduler_notified: true });
    const client = new CodingAgentGatewayClient({ baseUrl: "http://gateway", fetchImpl });

    const result = await client.capture({
      session: { sessionKey: "session-1" },
      sessionId: "thread-1",
      userContent: "implement the adapter",
      assistantContent: "done",
      messages: [{ role: "user", content: "implement the adapter" }],
    });

    expect(result).toEqual({ l0_recorded: 2, scheduler_notified: true });
    expect(calls[0].input).toBe("http://gateway/capture");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      user_content: "implement the adapter",
      assistant_content: "done",
      session_key: "session-1",
      session_id: "thread-1",
      messages: [{ role: "user", content: "implement the adapter" }],
    });
  });

  it("calls memory and conversation search endpoints", async () => {
    const { calls, fetchImpl } = captureFetch({ results: "match", total: 1, strategy: "bm25" });
    const client = new CodingAgentGatewayClient({ baseUrl: "http://gateway", fetchImpl });

    await client.searchMemories({ query: "adapter", limit: 3, type: "instruction", scene: "coding" });
    await client.searchConversations({ query: "gateway", limit: 2, sessionKey: "session-1" });

    expect(calls[0].input).toBe("http://gateway/search/memories");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      query: "adapter",
      limit: 3,
      type: "instruction",
      scene: "coding",
    });
    expect(calls[1].input).toBe("http://gateway/search/conversations");
    expect(JSON.parse(calls[1].init.body as string)).toEqual({
      query: "gateway",
      limit: 2,
      session_key: "session-1",
    });
  });

  it("calls health and session end endpoints", async () => {
    const { calls, fetchImpl } = captureFetch({ flushed: true });
    const client = new CodingAgentGatewayClient({ baseUrl: "http://gateway", fetchImpl });

    await client.health();
    await client.endSession({ sessionKey: "session-1", userId: "user-1" });

    expect(calls[0].input).toBe("http://gateway/health");
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.body).toBeUndefined();
    expect(calls[1].input).toBe("http://gateway/session/end");
    expect(JSON.parse(calls[1].init.body as string)).toEqual({
      session_key: "session-1",
      user_id: "user-1",
    });
  });

  it("throws GatewayClientError for non-2xx responses", async () => {
    const fetchImpl = vi.fn(async () => createJsonResponse({ error: "bad request" }, { status: 400, statusText: "Bad Request" })) as unknown as typeof fetch;
    const client = new CodingAgentGatewayClient({ baseUrl: "http://gateway", fetchImpl });

    await expect(client.recall("x", { sessionKey: "s" })).rejects.toMatchObject({
      name: "GatewayClientError",
      status: 400,
      body: '{"error":"bad request"}',
    });
  });
});

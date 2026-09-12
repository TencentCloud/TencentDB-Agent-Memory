import { afterEach, describe, expect, it, vi } from "vitest";

import { GatewayMemoryClient, GatewayMemoryClientError } from "./client.js";

describe("GatewayMemoryClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps recall to the Gateway API and attaches bearer authentication", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        context: "prefers TypeScript",
        strategy: "hybrid",
        memory_count: 1,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = new GatewayMemoryClient({
      baseUrl: "http://127.0.0.1:8420/",
      apiKey: "gateway-secret",
      fetch: fetchMock,
    });

    const result = await client.recall({
      query: "What language does the user prefer?",
      sessionKey: "session-1",
      userId: "user-1",
    });

    expect(result.context).toBe("prefers TypeScript");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8420/recall");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer gateway-secret",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      query: "What language does the user prefer?",
      session_key: "session-1",
      user_id: "user-1",
    });
  });

  it("maps capture and search operations to their host-neutral contracts", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ l0_recorded: 2, scheduler_notified: true }))
      .mockResolvedValueOnce(Response.json({ results: "memory result", total: 1, strategy: "keyword" }))
      .mockResolvedValueOnce(Response.json({ results: "conversation result", total: 1 }))
      .mockResolvedValueOnce(Response.json({ flushed: true }));
    const client = new GatewayMemoryClient({
      baseUrl: "http://localhost:8420",
      fetch: fetchMock,
    });

    await expect(client.capture({
      userContent: "Remember this",
      assistantContent: "I will",
      sessionKey: "session-2",
      sessionId: "turn-2",
      messages: [{ role: "user", content: "Remember this" }],
    })).resolves.toEqual({ l0Recorded: 2, schedulerNotified: true });
    await expect(client.searchMemories({
      query: "TypeScript",
      limit: 3,
      type: "instruction",
      scene: "coding",
    })).resolves.toEqual({ results: "memory result", total: 1, strategy: "keyword" });
    await expect(client.searchConversations({
      query: "Remember",
      limit: 4,
      sessionKey: "session-2",
    })).resolves.toEqual({ results: "conversation result", total: 1 });
    await expect(client.endSession({ sessionKey: "session-2" })).resolves.toEqual({ flushed: true });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:8420/capture",
      "http://localhost:8420/search/memories",
      "http://localhost:8420/search/conversations",
      "http://localhost:8420/session/end",
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      user_content: "Remember this",
      assistant_content: "I will",
      session_key: "session-2",
      session_id: "turn-2",
      messages: [{ role: "user", content: "Remember this" }],
    });
  });

  it("surfaces structured Gateway failures without leaking the API key", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ error: "invalid request", code: "BAD_REQUEST" }, { status: 400 }),
    );
    const client = new GatewayMemoryClient({
      baseUrl: "http://localhost:8420",
      apiKey: "must-not-leak",
      fetch: fetchMock,
    });

    const error = await client.searchMemories({ query: "test" }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GatewayMemoryClientError);
    expect(error).toMatchObject({
      status: 400,
      code: "BAD_REQUEST",
      message: "Gateway request failed (400): invalid request",
    });
    expect(String(error)).not.toContain("must-not-leak");
  });

  it("rejects invalid transport configuration at construction time", () => {
    expect(() => new GatewayMemoryClient({
      baseUrl: "file:///tmp/gateway.sock",
    })).toThrow("baseUrl must use http or https");
    expect(() => new GatewayMemoryClient({
      baseUrl: "http://localhost:8420?token=unsafe",
    })).toThrow("baseUrl must not contain a query or fragment");
    expect(() => new GatewayMemoryClient({
      baseUrl: "http://localhost:8420",
      timeoutMs: 0,
    })).toThrow("timeoutMs must be a positive integer");
  });
});

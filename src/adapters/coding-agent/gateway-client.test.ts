import { describe, expect, it, vi } from "vitest";
import { CodingAgentGatewayClient, CodingAgentGatewayError } from "./gateway-client.js";

function mockFetch(responseBody: unknown, init: ResponseInit = {}) {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      ...init,
      headers: { "Content-Type": "application/json", ...init.headers },
    });
  }) as unknown as typeof globalThis.fetch;

  return { fetchImpl, calls };
}

describe("CodingAgentGatewayClient", () => {
  it("sends recall requests using Gateway field names", async () => {
    const { fetchImpl, calls } = mockFetch({ context: "memory", memory_count: 1 });
    const client = new CodingAgentGatewayClient({
      baseUrl: "http://127.0.0.1:8420/",
      apiKey: " secret ",
      fetch: fetchImpl,
    });

    const response = await client.recall({
      query: "what did we decide?",
      sessionKey: "repo:thread-1",
      userId: "alice",
    });

    expect(response.context).toBe("memory");
    expect(calls[0].input).toBe("http://127.0.0.1:8420/recall");
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer secret",
    });
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      query: "what did we decide?",
      session_key: "repo:thread-1",
      user_id: "alice",
    });
  });

  it("captures a coding-agent turn with optional raw messages", async () => {
    const { fetchImpl, calls } = mockFetch({ l0_recorded: 2, scheduler_notified: true });
    const client = new CodingAgentGatewayClient({ fetch: fetchImpl });

    await client.capture({
      userContent: "fix the failing test",
      assistantContent: "patched the assertion",
      sessionKey: "workspace:/tmp/project",
      sessionId: "thread-42",
      messages: [{ role: "user", content: "fix the failing test" }],
      startedAt: 1_720_000_000_000,
    });

    expect(calls[0].input).toBe("http://127.0.0.1:8420/capture");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      user_content: "fix the failing test",
      assistant_content: "patched the assertion",
      session_key: "workspace:/tmp/project",
      session_id: "thread-42",
      messages: [{ role: "user", content: "fix the failing test" }],
      started_at: 1_720_000_000_000,
    });
  });

  it("uses GET for health and omits auth when no api key is configured", async () => {
    const { fetchImpl, calls } = mockFetch({
      status: "ok",
      version: "0.1.0",
      uptime: 1,
      stores: { vectorStore: true, embeddingService: true },
    });
    const client = new CodingAgentGatewayClient({ fetch: fetchImpl });

    await client.health();

    expect(calls[0].input).toBe("http://127.0.0.1:8420/health");
    expect(calls[0].init?.method).toBe("GET");
    expect(calls[0].init?.headers).toEqual({});
    expect(calls[0].init?.body).toBeUndefined();
  });

  it("throws a typed error for non-2xx responses", async () => {
    const fetchImpl = vi.fn(async () => new Response("unauthorized", { status: 401 })) as unknown as typeof globalThis.fetch;
    const client = new CodingAgentGatewayClient({ fetch: fetchImpl });

    await expect(client.searchMemories({ query: "secret" })).rejects.toMatchObject({
      name: "CodingAgentGatewayError",
      status: 401,
      responseBody: "unauthorized",
    } satisfies Partial<CodingAgentGatewayError>);
  });

  it("maps search and session lifecycle requests to Gateway fields", async () => {
    const { fetchImpl, calls } = mockFetch({ results: "ok", total: 1 });
    const client = new CodingAgentGatewayClient({ fetch: fetchImpl });

    await client.searchMemories({
      query: "package manager",
      limit: 3,
      type: "preference",
      scene: "workspace",
    });
    await client.searchConversations({
      query: "pnpm",
      limit: 2,
      sessionKey: "repo:thread-1",
    });
    await client.endSession("repo:thread-1", "alice");

    expect(calls.map((call) => call.input)).toEqual([
      "http://127.0.0.1:8420/search/memories",
      "http://127.0.0.1:8420/search/conversations",
      "http://127.0.0.1:8420/session/end",
    ]);
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      query: "package manager",
      limit: 3,
      type: "preference",
      scene: "workspace",
    });
    expect(JSON.parse(calls[1].init?.body as string)).toEqual({
      query: "pnpm",
      limit: 2,
      session_key: "repo:thread-1",
    });
    expect(JSON.parse(calls[2].init?.body as string)).toEqual({
      session_key: "repo:thread-1",
      user_id: "alice",
    });
  });

  it("aborts requests after the configured timeout", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => (
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        })
      )) as unknown as typeof globalThis.fetch;
      const client = new CodingAgentGatewayClient({ timeoutMs: 25, fetch: fetchImpl });

      const assertion = expect(client.health()).rejects.toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

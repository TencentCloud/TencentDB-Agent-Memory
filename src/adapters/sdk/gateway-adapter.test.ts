import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GatewayMemoryAdapter,
  createMemoryAdapter,
  createPlatformMemoryAdapter,
  registerMemoryPlatformAdapter,
} from "./gateway-adapter.js";

function mockFetch(responseBody: unknown, status = 200) {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch);
  return calls;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GatewayMemoryAdapter", () => {
  it("creates adapters from a provider config registry", async () => {
    registerMemoryPlatformAdapter({
      platform: "registry-agent",
      fromConfig(config) {
        return {
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          sessionKey: config.sessionKey,
          userId: config.userId,
        };
      },
    });
    const calls = mockFetch({ context: "registry memory" });

    const adapter = createMemoryAdapter({
      provider: "registry-agent",
      config: {
        baseUrl: "http://registry-gateway/",
        apiKey: "registry-secret",
        sessionKey: "workspace:/repo",
        userId: "leo",
      },
    });

    await adapter.recall({ query: "q" });

    expect(String(calls[0].input)).toBe("http://registry-gateway/recall");
    expect(calls[0].init?.headers).toMatchObject({ Authorization: "Bearer registry-secret" });
    expect(JSON.parse(calls[0].init?.body as string)).toMatchObject({
      session_key: "registry-agent:workspace:/repo",
      user_id: "leo",
    });
  });

  it("raises a clear error for unknown adapter providers", () => {
    expect(() => createMemoryAdapter({ provider: "missing-agent" })).toThrow(
      "Unknown memory adapter provider: missing-agent",
    );
  });

  it("creates a full adapter from a single platform definition interface", async () => {
    const calls = mockFetch({ context: "new platform memory" });
    const adapter = createPlatformMemoryAdapter(
      {
        platform: "my-agent",
        fromEnv(env) {
          return {
            baseUrl: env.MY_AGENT_GATEWAY_URL,
            apiKey: env.MY_AGENT_API_KEY,
            sessionKey: env.MY_AGENT_SESSION_ID ?? env.MY_AGENT_WORKSPACE,
            userId: env.MY_AGENT_USER_ID,
          };
        },
      },
      {
        MY_AGENT_GATEWAY_URL: "http://my-agent-gateway/",
        MY_AGENT_API_KEY: "agent-secret",
        MY_AGENT_WORKSPACE: "/repo",
        MY_AGENT_USER_ID: "leo",
      },
    );

    await adapter.recall({ query: "q" });

    expect(String(calls[0].input)).toBe("http://my-agent-gateway/recall");
    expect(calls[0].init?.headers).toMatchObject({ Authorization: "Bearer agent-secret" });
    expect(JSON.parse(calls[0].init?.body as string)).toMatchObject({
      session_key: "my-agent:/repo",
      user_id: "leo",
    });
  });

  it("maps recall and capture to the Gateway contract with platform session keys", async () => {
    const calls = mockFetch({ context: "<memory>repo prefers vitest</memory>", strategy: "hybrid", memory_count: 1 });
    const adapter = new GatewayMemoryAdapter({
      platform: "codebuddy",
      baseUrl: "http://127.0.0.1:8420/",
      apiKey: "secret",
      sessionKey: "workspace:/repo",
      userId: "drive888",
    });

    const recall = await adapter.recall({ query: "test style?" });
    await adapter.capture({
      userContent: "test style?",
      assistantContent: "Use Vitest.",
      sessionId: "turn-1",
    });

    expect(recall.context).toBe("<memory>repo prefers vitest</memory>");
    expect(calls.map((call) => String(call.input))).toEqual([
      "http://127.0.0.1:8420/recall",
      "http://127.0.0.1:8420/capture",
    ]);
    expect(calls[0].init?.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer secret",
    });
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      query: "test style?",
      session_key: "codebuddy:workspace:/repo",
      user_id: "drive888",
    });
    expect(JSON.parse(calls[1].init?.body as string)).toEqual({
      user_content: "test style?",
      assistant_content: "Use Vitest.",
      session_key: "codebuddy:workspace:/repo",
      session_id: "turn-1",
      user_id: "drive888",
    });
  });

  it("supports search and session lifecycle through the same SDK surface", async () => {
    const calls = mockFetch({ results: "[]", total: 0, strategy: "hybrid", flushed: true });
    const adapter = new GatewayMemoryAdapter({
      platform: "claude-code",
      sessionKey: "thread:abc",
    });

    await adapter.searchMemories({ query: "preference", limit: 3, type: "preference", scene: "repo" });
    await adapter.searchConversations({ query: "previous", limit: 2 });
    await adapter.endSession();

    expect(calls.map((call) => String(call.input))).toEqual([
      "http://127.0.0.1:8420/search/memories",
      "http://127.0.0.1:8420/search/conversations",
      "http://127.0.0.1:8420/session/end",
    ]);
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      query: "preference",
      limit: 3,
      type: "preference",
      scene: "repo",
    });
    expect(JSON.parse(calls[1].init?.body as string)).toEqual({
      query: "previous",
      limit: 2,
      session_key: "claude-code:thread:abc",
    });
    expect(JSON.parse(calls[2].init?.body as string)).toEqual({
      session_key: "claude-code:thread:abc",
    });
  });

  it("uses a longer timeout for session flushes than ordinary requests", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          reject(new DOMException("This operation was aborted", "AbortError"));
        });
        setTimeout(() => {
          resolve(new Response(JSON.stringify({ flushed: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }));
        }, 25);
      });
    }) as typeof fetch);
    const adapter = new GatewayMemoryAdapter({
      platform: "codex",
      sessionKey: "s",
      timeoutMs: 10,
      sessionEndTimeoutMs: 50,
      fetchImpl,
    });

    const result = adapter.endSession();
    await vi.advanceTimersByTimeAsync(30);

    await expect(result).resolves.toEqual({ flushed: true });
  });

  it("raises Gateway errors with response body details", async () => {
    mockFetch({ error: "no auth" }, 401);
    const adapter = new GatewayMemoryAdapter({ platform: "codex", sessionKey: "s" });

    await expect(adapter.recall({ query: "q" })).rejects.toThrow(
      "Gateway /recall failed: HTTP 401",
    );
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  CodexMemoryAdapter,
  createCodexMemoryAdapterFromEnv,
} from "./client";

type FetchCall = {
  input: string | URL | Request;
  init?: RequestInit;
};

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

function createFetchMock(responses: Response[]) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch call");
    return next;
  });
  return { calls, fetchMock };
}

describe("CodexMemoryAdapter", () => {
  it("posts recall requests to the Gateway with auth and snake_case fields", async () => {
    const { calls, fetchMock } = createFetchMock([
      jsonResponse({ context: "<memory-context>remember repo rules</memory-context>", strategy: "hybrid", memory_count: 1 }),
    ]);
    const adapter = new CodexMemoryAdapter({
      baseUrl: "http://127.0.0.1:8420/",
      apiKey: "secret",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await adapter.recall({
      query: "How should I run tests?",
      sessionKey: "codex-thread-235",
      userId: "ceilf6",
    });

    expect(result.context).toContain("remember repo rules");
    expect(calls).toHaveLength(1);
    expect(String(calls[0].input)).toBe("http://127.0.0.1:8420/recall");
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer secret",
    });
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      query: "How should I run tests?",
      session_key: "codex-thread-235",
      user_id: "ceilf6",
    });
  });

  it("captures a completed Codex turn through the Gateway capture endpoint", async () => {
    const { calls, fetchMock } = createFetchMock([
      jsonResponse({ l0_recorded: 2, scheduler_notified: true }),
    ]);
    const adapter = new CodexMemoryAdapter({
      baseUrl: "http://localhost:8420",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await adapter.captureTurn({
      userContent: "implement issue 235",
      assistantContent: "implemented the adapter",
      sessionKey: "codex-thread-235",
      sessionId: "turn-1",
      messages: [
        { role: "user", content: "implement issue 235" },
        { role: "assistant", content: "implemented the adapter" },
      ],
    });

    expect(result).toEqual({ l0_recorded: 2, scheduler_notified: true });
    expect(String(calls[0].input)).toBe("http://localhost:8420/capture");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      user_content: "implement issue 235",
      assistant_content: "implemented the adapter",
      session_key: "codex-thread-235",
      session_id: "turn-1",
      messages: [
        { role: "user", content: "implement issue 235" },
        { role: "assistant", content: "implemented the adapter" },
      ],
    });
  });

  it("checks Gateway health without a request body", async () => {
    const { calls, fetchMock } = createFetchMock([
      jsonResponse({
        status: "ok",
        version: "0.3.6",
        uptime: 42,
        stores: { vectorStore: true, embeddingService: true },
      }),
    ]);
    const adapter = new CodexMemoryAdapter({
      baseUrl: "http://localhost:8420",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await adapter.health();

    expect(result.status).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(String(calls[0].input)).toBe("http://localhost:8420/health");
    expect(calls[0].init?.method).toBe("GET");
    expect(calls[0].init?.body).toBeUndefined();
    expect(calls[0].init?.headers).toEqual({});
  });

  it("posts memory search requests with optional filters", async () => {
    const { calls, fetchMock } = createFetchMock([
      jsonResponse({ results: "memory result", total: 1, strategy: "hybrid" }),
    ]);
    const adapter = new CodexMemoryAdapter({
      baseUrl: "http://localhost:8420",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await adapter.searchMemories({
      query: "repo rules",
      limit: 5,
      type: "fact",
      scene: "coding",
    });

    expect(result).toEqual({ results: "memory result", total: 1, strategy: "hybrid" });
    expect(String(calls[0].input)).toBe("http://localhost:8420/search/memories");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      query: "repo rules",
      limit: 5,
      type: "fact",
      scene: "coding",
    });
  });

  it("posts conversation search requests with snake_case session filters", async () => {
    const { calls, fetchMock } = createFetchMock([
      jsonResponse({ results: "conversation result", total: 2 }),
    ]);
    const adapter = new CodexMemoryAdapter({
      baseUrl: "http://localhost:8420",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await adapter.searchConversations({
      query: "issue 235",
      limit: 3,
      sessionKey: "codex-thread-235",
    });

    expect(result).toEqual({ results: "conversation result", total: 2 });
    expect(String(calls[0].input)).toBe("http://localhost:8420/search/conversations");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      query: "issue 235",
      limit: 3,
      session_key: "codex-thread-235",
    });
  });

  it("flushes a Codex session through the Gateway session end endpoint", async () => {
    const { calls, fetchMock } = createFetchMock([
      jsonResponse({ flushed: true }),
    ]);
    const adapter = new CodexMemoryAdapter({
      baseUrl: "http://localhost:8420",
      defaultSessionKey: "codex-thread-235",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await adapter.endSession({ userId: "ceilf6" });

    expect(result).toEqual({ flushed: true });
    expect(String(calls[0].input)).toBe("http://localhost:8420/session/end");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      session_key: "codex-thread-235",
      user_id: "ceilf6",
    });
  });

  it("fails fast when a session-scoped operation has no session key", async () => {
    const { fetchMock } = createFetchMock([]);
    const adapter = new CodexMemoryAdapter({
      baseUrl: "http://localhost:8420",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(adapter.recall({ query: "missing session" })).rejects.toThrow("sessionKey is required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces Gateway HTTP errors with route and status", async () => {
    const { fetchMock } = createFetchMock([
      jsonResponse({ error: "Unauthorized: invalid token" }, { status: 401 }),
    ]);
    const adapter = new CodexMemoryAdapter({
      baseUrl: "http://localhost:8420",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(adapter.recall({ query: "hello", sessionKey: "s1" })).rejects.toThrow(
      "TDAI Gateway POST /recall failed with 401: Unauthorized: invalid token",
    );
  });

  it("surfaces nested Gateway error messages", async () => {
    const { fetchMock } = createFetchMock([
      jsonResponse({ error: { message: "adapter route unavailable", code: "not_found" } }, { status: 404 }),
    ]);
    const adapter = new CodexMemoryAdapter({
      baseUrl: "http://localhost:8420",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(adapter.recall({ query: "hello", sessionKey: "s1" })).rejects.toThrow(
      "TDAI Gateway POST /recall failed with 404: adapter route unavailable",
    );
  });

  it("stringifies nested Gateway error objects without a message field", async () => {
    const { fetchMock } = createFetchMock([
      jsonResponse({ error: { code: "invalid_body", fields: ["session_key"] } }, { status: 400 }),
    ]);
    const adapter = new CodexMemoryAdapter({
      baseUrl: "http://localhost:8420",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(adapter.recall({ query: "hello", sessionKey: "s1" })).rejects.toThrow(
      'TDAI Gateway POST /recall failed with 400: {"code":"invalid_body","fields":["session_key"]}',
    );
  });

  it("creates an adapter from Codex-oriented environment variables", () => {
    const adapter = createCodexMemoryAdapterFromEnv({
      MEMORY_TENCENTDB_GATEWAY_URL: "http://gateway:8420",
      MEMORY_TENCENTDB_GATEWAY_API_KEY: "adapter-secret",
      CODEX_SESSION_ID: "thread-abc",
    });

    expect(adapter.baseUrl).toBe("http://gateway:8420");
    expect(adapter.defaultSessionKey).toBe("thread-abc");
  });

  it("falls back to the default Gateway URL when env base URL is blank", () => {
    const adapter = createCodexMemoryAdapterFromEnv({
      MEMORY_TENCENTDB_GATEWAY_URL: "",
      TDAI_GATEWAY_URL: "",
    });

    expect(adapter.baseUrl).toBe("http://127.0.0.1:8420");
  });
});

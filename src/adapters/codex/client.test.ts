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

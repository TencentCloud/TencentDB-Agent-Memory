import { describe, it, expect, vi, afterEach } from "vitest";
import {
  KimiCodeGatewayClient,
  GatewayClientError,
  DEFAULT_GATEWAY_URL,
} from "./gateway-client.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function createMockFetch(
  response: { status: number; body: unknown; headers?: Record<string, string> },
) {
  const calls: Array<{ input: unknown; init: RequestInit | undefined }> = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(
    (async (input: unknown, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response(response.body ? JSON.stringify(response.body) : "", {
        status: response.status,
        headers: response.headers,
      });
    }) as typeof globalThis.fetch,
  );
  return { spy, calls };
}

describe("KimiCodeGatewayClient", () => {
  it("defaults to the standalone gateway URL", async () => {
    const { calls } = createMockFetch({
      status: 200,
      body: { context: "", memory_count: 0 },
    });

    const client = new KimiCodeGatewayClient();
    await client.recall({ query: "hello", session_key: "session-1" });

    expect(calls[0].input).toBe(`${DEFAULT_GATEWAY_URL}/recall`);
  });

  it("normalizes trailing slashes in the base URL", async () => {
    const { calls } = createMockFetch({
      status: 200,
      body: { context: "", memory_count: 0 },
    });

    const client = new KimiCodeGatewayClient({ baseUrl: "http://127.0.0.1:8420/" });
    await client.recall({ query: "hello", session_key: "session-1" });

    expect(calls[0].input).toBe("http://127.0.0.1:8420/recall");
  });

  it("recall includes the Bearer token when apiKey is provided", async () => {
    const { calls } = createMockFetch({
      status: 200,
      body: { context: "some context", strategy: "bm25", memory_count: 2 },
    });

    const client = new KimiCodeGatewayClient({
      baseUrl: "http://127.0.0.1:8420",
      apiKey: "secret-token",
    });

    const result = await client.recall({
      query: "how do I connect?",
      session_key: "session-1",
    });

    expect(result).toEqual({
      context: "some context",
      strategy: "bm25",
      memory_count: 2,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe("http://127.0.0.1:8420/recall");
    expect(calls[0].init?.headers).toMatchObject({
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body).toEqual({
      query: "how do I connect?",
      session_key: "session-1",
    });
  });

  it("recall omits the Authorization header when no apiKey is provided", async () => {
    const { calls } = createMockFetch({
      status: 200,
      body: { context: "", memory_count: 0 },
    });

    const client = new KimiCodeGatewayClient({ baseUrl: "http://127.0.0.1:8420" });
    await client.recall({ query: "hello", session_key: "session-2" });

    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("throws GatewayClientError with parsed error body on non-2xx response", async () => {
    createMockFetch({
      status: 401,
      body: { error: "Unauthorized: invalid token" },
    });

    const client = new KimiCodeGatewayClient({
      baseUrl: "http://127.0.0.1:8420",
      apiKey: "wrong-token",
    });

    await expect(
      client.recall({ query: "hello", session_key: "session-3" }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(GatewayClientError);
      const clientErr = err as GatewayClientError;
      expect(clientErr.status).toBe(401);
      expect(clientErr.message).toBe("Unauthorized: invalid token");
      expect(clientErr.response).toEqual({ error: "Unauthorized: invalid token" });
      return true;
    });
  });

  it("capture forwards messages when provided", async () => {
    const { calls } = createMockFetch({
      status: 200,
      body: { l0_recorded: 1, scheduler_notified: true },
    });

    const client = new KimiCodeGatewayClient({ baseUrl: "http://127.0.0.1:8420" });

    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];

    const result = await client.capture({
      user_content: "hi",
      assistant_content: "hello",
      session_key: "session-4",
      session_id: "id-4",
      user_id: "user-4",
      messages,
    });

    expect(result).toEqual({ l0_recorded: 1, scheduler_notified: true });
    expect(calls[0].input).toBe("http://127.0.0.1:8420/capture");
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body).toEqual({
      user_content: "hi",
      assistant_content: "hello",
      session_key: "session-4",
      session_id: "id-4",
      user_id: "user-4",
      messages,
    });
  });

  it("calls all five gateway endpoints", async () => {
    const { calls } = createMockFetch({ status: 200, body: {} });
    const client = new KimiCodeGatewayClient({ baseUrl: "http://127.0.0.1:8420" });

    await client.recall({ query: "q", session_key: "s" });
    await client.capture({
      user_content: "u",
      assistant_content: "a",
      session_key: "s",
    });
    await client.searchMemories({ query: "q" });
    await client.searchConversations({ query: "q" });
    await client.endSession({ session_key: "s" });

    const paths = calls.map((c) => c.input);
    expect(paths).toEqual([
      "http://127.0.0.1:8420/recall",
      "http://127.0.0.1:8420/capture",
      "http://127.0.0.1:8420/search/memories",
      "http://127.0.0.1:8420/search/conversations",
      "http://127.0.0.1:8420/session/end",
    ]);
  });

  it("throws a timeout error when the request exceeds timeoutMs", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_input, init?: RequestInit) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (init?.signal?.aborted) {
          const err = new Error("AbortError");
          err.name = "AbortError";
          throw err;
        }
        return new Response("{}", { status: 200 });
      },
    );

    const client = new KimiCodeGatewayClient({
      baseUrl: "http://127.0.0.1:8420",
      timeoutMs: 1,
    });

    const promise = client.recall({ query: "hello", session_key: "session-5" });
    await vi.advanceTimersByTimeAsync(10);

    await expect(promise).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(GatewayClientError);
      expect((err as GatewayClientError).status).toBe(0);
      expect((err as GatewayClientError).message).toContain("timed out");
      return true;
    });

    vi.useRealTimers();
  });
});

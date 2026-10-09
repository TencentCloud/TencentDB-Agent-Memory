import { describe, it, expect, vi, afterEach } from "vitest";
import {
  CodexGatewayClient,
  GatewayClientError,
  type CodexGatewayClientOptions,
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

describe("CodexGatewayClient", () => {
  it("recall includes the Bearer token when apiKey is provided", async () => {
    const { calls } = createMockFetch({
      status: 200,
      body: { context: "some context", strategy: "bm25", memory_count: 2 },
    });

    const client = new CodexGatewayClient({
      baseUrl: "http://127.0.0.1:3000/",
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
    expect(calls[0].input).toBe("http://127.0.0.1:3000/recall");
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

    const client = new CodexGatewayClient({
      baseUrl: "http://127.0.0.1:3000",
    });

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

    const client = new CodexGatewayClient({
      baseUrl: "http://127.0.0.1:3000",
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

    const client = new CodexGatewayClient({
      baseUrl: "http://127.0.0.1:3000/",
    });

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
    expect(calls[0].input).toBe("http://127.0.0.1:3000/capture");
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
});

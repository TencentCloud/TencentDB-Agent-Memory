import { describe, expect, it } from "vitest";
import { GatewayMemoryClient, GatewayMemoryClientError } from "./gateway-client.js";

describe("GatewayMemoryClient", () => {
  it("posts recall requests with bearer auth", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new GatewayMemoryClient({
      baseUrl: "http://127.0.0.1:8765/",
      apiKey: "secret",
      fetchFn: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify({ context: "memory", strategy: "hybrid", memory_count: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    const result = await client.recall("hello", "session-a", "user-a");

    expect(result.context).toBe("memory");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:8765/recall");
    expect(calls[0].init?.method).toBe("POST");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer secret");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      query: "hello",
      session_key: "session-a",
      user_id: "user-a",
    });
  });

  it("surfaces gateway errors with status and parsed body", async () => {
    const client = new GatewayMemoryClient({
      fetchFn: async () => new Response(JSON.stringify({ error: "Missing required field: query" }), { status: 400 }),
    });

    await expect(client.searchMemories({ query: "" })).rejects.toMatchObject({
      name: "GatewayMemoryClientError",
      status: 400,
      message: "Missing required field: query",
    } satisfies Partial<GatewayMemoryClientError>);
  });
});

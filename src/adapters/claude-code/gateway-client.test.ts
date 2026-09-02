import { describe, expect, it } from "vitest";
import { TdaiGatewayClient } from "./gateway-client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("TdaiGatewayClient", () => {
  it("posts recall requests to the existing Gateway endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new TdaiGatewayClient({
      baseUrl: "http://127.0.0.1:8420/",
      apiKey: "secret",
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return jsonResponse({ context: "remember this", strategy: "hybrid", memory_count: 1 });
      },
    });

    const result = await client.recall({
      query: "what do I prefer?",
      session_key: "agent:claude-code-x:s",
    });

    expect(result.context).toBe("remember this");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:8420/recall");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      query: "what do I prefer?",
      session_key: "agent:claude-code-x:s",
    });
  });

  it("maps memory and conversation search endpoints", async () => {
    const urls: string[] = [];
    const client = new TdaiGatewayClient({
      baseUrl: "http://gateway",
      fetchImpl: async (url) => {
        urls.push(String(url));
        return jsonResponse({ results: "ok", total: 1, strategy: "hybrid" });
      },
    });

    await client.searchMemories({ query: "memory" });
    await client.searchConversations({ query: "conversation" });

    expect(urls).toEqual([
      "http://gateway/search/memories",
      "http://gateway/search/conversations",
    ]);
  });
});


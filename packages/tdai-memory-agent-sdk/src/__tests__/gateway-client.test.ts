import { describe, expect, it } from "vitest";
import { GatewayClient, GatewayHttpError } from "../gateway/client.js";

describe("GatewayClient", () => {
  it("maps Gateway request and response shapes", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      const path = new URL(String(input)).pathname;

      if (path === "/health") return jsonResponse({ status: "ok" });
      if (path === "/recall") return jsonResponse({ context: "remembered", strategy: "hybrid", memory_count: 1 });
      if (path === "/capture") return jsonResponse({ l0_recorded: 2, scheduler_notified: true });
      if (path === "/session/end") return jsonResponse({ flushed: true });
      if (path === "/search/memories") return jsonResponse({ results: "m1", total: 1, strategy: "keyword" });
      if (path === "/search/conversations") return jsonResponse({ results: "c1", total: 1 });
      return jsonResponse({ error: "missing" }, 404);
    }) as typeof fetch;

    const client = new GatewayClient({
      gatewayUrl: "http://127.0.0.1:8420",
      apiKey: "secret",
      fetchImpl,
    });

    expect(await client.health()).toMatchObject({ status: "ok" });
    expect(await client.recall({ query: "q", sessionKey: "s", userId: "u" })).toEqual({
      context: "remembered",
      strategy: "hybrid",
      memoryCount: 1,
    });
    expect(await client.capture({ userContent: "u", assistantContent: "a", sessionKey: "s", startedAt: 123 })).toEqual({
      l0Recorded: 2,
      schedulerNotified: true,
    });
    expect(await client.endSession({ sessionKey: "s" })).toEqual({ flushed: true });
    expect(await client.searchMemories({ query: "q" })).toEqual({ results: "m1", total: 1, strategy: "keyword" });
    expect(await client.searchConversations({ query: "q" })).toEqual({ results: "c1", total: 1 });

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/health",
      "/recall",
      "/capture",
      "/session/end",
      "/search/memories",
      "/search/conversations",
    ]);
    expect(calls.every((call) => (call.init.headers as Record<string, string>).Authorization === "Bearer secret")).toBe(true);
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ query: "q", session_key: "s", user_id: "u" });
    expect(JSON.parse(calls[2].init.body as string)).toMatchObject({ started_at: 123 });
  });

  it("throws GatewayHttpError for non-2xx responses", async () => {
    const fetchImpl = (async () => jsonResponse({ error: "bad request" }, 400)) as typeof fetch;
    const client = new GatewayClient({ gatewayUrl: "http://127.0.0.1:8420", fetchImpl });

    await expect(client.recall({ query: "q", sessionKey: "s" })).rejects.toMatchObject({
      name: "GatewayHttpError",
      status: 400,
      path: "/recall",
      message: "bad request",
    } satisfies Partial<GatewayHttpError>);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

import { describe, expect, it } from "vitest";
import { compactContext, createMemoryAdapter, MemoryGatewayClient, type MemoryPlatformAdapter } from "./index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("adapter SDK", () => {
  it("maps platform turns to Gateway recall and capture requests", async () => {
    const calls: Array<{ url: string; body?: any; auth?: string | null }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const headers = new Headers(init?.headers);
      calls.push({ url, body, auth: headers.get("authorization") });

      if (url.endsWith("/recall")) {
        return jsonResponse({
          context: "combined recall",
          prepend_context: "dynamic recall",
          system_context: "stable recall",
          strategy: "fts",
          memory_count: 1,
        });
      }
      if (url.endsWith("/capture")) {
        return jsonResponse({ l0_recorded: 2, scheduler_notified: true });
      }
      return jsonResponse({ error: "unexpected" }, 404);
    };

    interface Turn { user: string; assistant: string; messages?: unknown[] }
    const platform: MemoryPlatformAdapter<Turn> = {
      getSession: () => ({
        platform: "unit-test",
        sessionKey: "unit:session",
        sessionId: "session-1",
        userId: "user-1",
      }),
      getUserText: (turn) => turn.user,
      getAssistantText: (turn) => turn.assistant,
      getMessages: (turn) => turn.messages,
    };

    const memory = createMemoryAdapter(platform, {
      gatewayUrl: "http://gateway.local/",
      apiKey: "secret",
      fetchImpl,
    });

    const recall = await memory.recallForTurn({ user: "remember format", assistant: "" });
    expect(recall).toMatchObject({
      context: "combined recall",
      prependContext: "dynamic recall",
      systemContext: "stable recall",
      strategy: "fts",
      memoryCount: 1,
    });

    const capture = await memory.captureTurn({
      user: "remember format",
      assistant: "use bullets",
      messages: [{ role: "user", content: "remember format" }],
    });
    expect(capture).toEqual({ l0Recorded: 2, schedulerNotified: true });

    expect(calls[0]).toMatchObject({
      url: "http://gateway.local/recall",
      auth: "Bearer secret",
      body: {
        query: "remember format",
        session_key: "unit:session",
        session_id: "session-1",
        user_id: "user-1",
      },
    });
    expect(calls[1]).toMatchObject({
      url: "http://gateway.local/capture",
      body: {
        user_content: "remember format",
        assistant_content: "use bullets",
        session_key: "unit:session",
        session_id: "session-1",
        user_id: "user-1",
        messages: [{ role: "user", content: "remember format" }],
      },
    });
  });

  it("supports direct memory and conversation searches", async () => {
    const calls: Array<{ url: string; body?: any }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body });
      if (url.endsWith("/search/memories")) return jsonResponse({ results: "memory hit", total: 1, strategy: "fts" });
      if (url.endsWith("/search/conversations")) return jsonResponse({ results: "conversation hit", total: 2 });
      return jsonResponse({ error: "unexpected" }, 404);
    };

    const client = new MemoryGatewayClient({ gatewayUrl: "http://gateway.local", fetchImpl });
    const memory = await client.searchMemories({ query: "style", limit: 3, type: "instruction" });
    const conversations = await client.searchConversations(
      { query: "style", limit: 2 },
      { sessionKey: "unit:session" },
    );

    expect(memory).toEqual({ results: "memory hit", total: 1, strategy: "fts" });
    expect(conversations).toEqual({ results: "conversation hit", total: 2 });
    expect(calls).toMatchObject([
      { url: "http://gateway.local/search/memories", body: { query: "style", limit: 3, type: "instruction" } },
      { url: "http://gateway.local/search/conversations", body: { query: "style", limit: 2, session_key: "unit:session" } },
    ]);
  });



  it("compacts short-term context for platforms without a native context engine", () => {
    const messages = [
      { role: "user", content: "start task" },
      ...Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 === 0 ? "assistant" : "tool",
        content: `large intermediate payload ${index} ${"x".repeat(1200)}`,
        toolCallId: `tool-${index}`,
      })),
      { role: "user", content: "final request must stay visible" },
    ];

    const result = compactContext({
      messages,
      targetTokens: 600,
      systemPrompt: "You are a coding agent.",
      prompt: "final request must stay visible",
    });

    expect(result.compacted).toBe(true);
    expect(result.deletedCount).toBeGreaterThan(0);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
    expect(JSON.stringify(result.messages)).toContain("final request must stay visible");
    expect(messages.length).toBe(14);
  });

  it("throws clear Gateway errors", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ error: "bad session" }, 400);
    const client = new MemoryGatewayClient({ fetchImpl });

    await expect(client.recall("hello", { sessionKey: "unit:session" })).rejects.toThrow("bad session");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryTools } from "./tools.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createMemoryTools", () => {
  it("recalls memory through the Gateway", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ context: "Remember concise answers.", strategy: "hybrid", memory_count: 1 }), { status: 200 }),
    );
    const tools = createMemoryTools({ fetch: fetchMock });

    const result = await tools.recall({ query: "response style", sessionKey: "codex:session-1" });

    expect(result).toEqual({ context: "Remember concise answers.", strategy: "hybrid", memoryCount: 1 });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      query: "response style",
      session_key: "codex:session-1",
    });
  });

  it("captures a completed turn through the Gateway", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ l0_recorded: 2, scheduler_notified: true }), { status: 200 }),
    );
    const tools = createMemoryTools({ fetch: fetchMock });

    const result = await tools.capture({
      userContent: "Implement it",
      assistantContent: "Implemented it",
      sessionKey: "codex:session-1",
      sessionId: "session-1",
    });

    expect(result).toEqual({ l0Recorded: 2, schedulerNotified: true });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      user_content: "Implement it",
      assistant_content: "Implemented it",
      session_key: "codex:session-1",
      session_id: "session-1",
      messages: [
        { role: "user", content: "Implement it" },
        { role: "assistant", content: "Implemented it" },
      ],
    });
  });

  it("ends sessions and searches both memory layers", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ flushed: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: "L1 result", total: 1, strategy: "vector" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: "L0 result", total: 2 }), { status: 200 }));
    const tools = createMemoryTools({ fetch: fetchMock });

    await expect(tools.endSession({ sessionKey: "codex:session-1" })).resolves.toEqual({ flushed: true });
    await expect(tools.searchMemories({ query: "preference", limit: 3 })).resolves.toEqual({
      results: "L1 result",
      total: 1,
      strategy: "vector",
    });
    await expect(tools.searchConversations({ query: "exact phrase", limit: 4, sessionKey: "codex:session-1" })).resolves.toEqual({
      results: "L0 result",
      total: 2,
    });
  });

  it("adds auth and user identity to Gateway requests", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ context: "" }), { status: 200 }),
    );
    const tools = createMemoryTools({ fetch: fetchMock, apiKey: "secret", userId: "user-1" });

    await tools.recall({ query: "anything", sessionKey: "codex:session-1" });

    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer secret",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      query: "anything",
      session_key: "codex:session-1",
      user_id: "user-1",
    });
  });

  it("rejects non-success Gateway responses", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }),
    );
    const tools = createMemoryTools({ fetch: fetchMock });

    await expect(tools.recall({ query: "anything", sessionKey: "codex:session-1" }))
      .rejects.toThrow("Gateway /recall returned HTTP 503");
  });
});
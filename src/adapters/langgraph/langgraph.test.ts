import { describe, expect, it, vi } from "vitest";

import { GatewayMemoryClient } from "../gateway-client/index.js";
import {
  createLangGraphMemoryAdapter,
  normalizeLangGraphMessages,
  resolveLangGraphPlatformContext,
  selectLangGraphCompletedTurn,
} from "./index.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function createHarness(
  fetchImpl: typeof fetch,
  options: {
    failClosed?: boolean;
    logger?: Pick<Console, "warn">;
  } = {},
) {
  const client = new GatewayMemoryClient({
    baseUrl: "http://127.0.0.1:8420",
    fetchImpl,
  });
  return createLangGraphMemoryAdapter({
    client,
    failClosed: options.failClosed,
    logger: options.logger,
  });
}

describe("LangGraph message helpers", () => {
  it("normalizes LangChain-style message objects without serializing methods", () => {
    expect(normalizeLangGraphMessages([
      { _getType: () => "human", content: [{ type: "text", text: "question" }] },
      { type: "ai", content: "answer" },
      { role: "tool", content: { type: "text", text: "tool result" } },
    ])).toEqual([
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" },
      { role: "tool", content: "tool result" },
    ]);
  });

  it("selects the latest completed user and assistant turn", () => {
    expect(selectLangGraphCompletedTurn({
      messages: [
        { role: "user", content: "old question" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "new question" },
        { role: "assistant", content: "new answer" },
        { role: "tool", content: "ignored after completion" },
      ],
    })).toEqual({
      userText: "new question",
      assistantText: "new answer",
      messages: [
        { role: "user", content: "old question" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "new question" },
        { role: "assistant", content: "new answer" },
      ],
    });
  });

  it("does not recapture an older turn while a newer user message is pending", () => {
    expect(selectLangGraphCompletedTurn({
      messages: [
        { role: "user", content: "completed question" },
        { role: "assistant", content: "completed answer" },
        { role: "user", content: "pending question" },
      ],
    })).toBeUndefined();
  });
});

describe("resolveLangGraphPlatformContext", () => {
  it("maps thread, run, and user identities from LangGraph runtime fields", () => {
    expect(resolveLangGraphPlatformContext(
      {},
      {
        configurable: {
          thread_id: "thread-42",
          user_id: "developer",
        },
        metadata: {
          run_id: "run-9",
        },
      },
    )).toEqual({
      sessionKey: "thread-42",
      sessionId: "run-9",
      userId: "developer",
    });
  });

  it("rejects missing stable thread identity", () => {
    expect(() => resolveLangGraphPlatformContext({}, {}))
      .toThrow("requires a stable thread_id or sessionKey");
  });
});

describe("createLangGraphMemoryAdapter", () => {
  it("recalls from the latest user message and writes the configured state field", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const adapter = createHarness(async (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
      });
      return jsonResponse({
        context: "User prefers concise TypeScript.",
        memory_count: 1,
      });
    });

    await expect(adapter.recallNode(
      {
        messages: [
          { role: "user", content: "old request" },
          { role: "assistant", content: "old answer" },
          { role: "user", content: "continue the adapter" },
        ],
      },
      {
        configurable: {
          thread_id: "thread-42",
          user_id: "developer",
        },
      },
    )).resolves.toEqual({
      memoryContext: "User prefers concise TypeScript.",
    });
    expect(calls).toEqual([{
      url: "http://127.0.0.1:8420/recall",
      body: {
        query: "continue the adapter",
        session_key: "thread-42",
        user_id: "developer",
      },
    }]);
  });

  it("captures the latest completed turn through the shared adapter boundary", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const adapter = createHarness(async (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
      });
      return jsonResponse({ l0_recorded: 2, scheduler_notified: true });
    });

    await expect(adapter.captureNode(
      {
        messages: [
          { _getType: () => "human", content: "question" },
          { _getType: () => "ai", content: [{ type: "text", text: "answer" }] },
        ],
      },
      {
        configurable: {
          thread_id: "thread-42",
          run_id: "run-9",
        },
        context: {
          userId: "developer",
        },
      },
    )).resolves.toEqual({});
    expect(calls).toEqual([{
      url: "http://127.0.0.1:8420/capture",
      body: {
        user_content: "question",
        assistant_content: "answer",
        messages: [
          { role: "user", content: "question" },
          { role: "assistant", content: "answer" },
        ],
        session_key: "thread-42",
        session_id: "run-9",
        user_id: "developer",
      },
    }]);
  });

  it("skips capture when the graph has no completed assistant turn", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const adapter = createHarness(fetchImpl);

    await expect(adapter.captureNode(
      { messages: [{ role: "user", content: "unfinished" }] },
      { configurable: { thread_id: "thread-42" } },
    )).resolves.toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("flushes the stable thread when the host closes the session", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const adapter = createHarness(async (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
      });
      return jsonResponse({ flushed: true });
    });

    await expect(adapter.endSessionNode(
      {},
      {
        configurable: {
          thread_id: "thread-42",
          user_id: "developer",
        },
      },
    )).resolves.toEqual({});
    expect(calls).toEqual([{
      url: "http://127.0.0.1:8420/session/end",
      body: {
        session_key: "thread-42",
        user_id: "developer",
      },
    }]);
  });

  it("exposes memory and conversation search without another client SDK", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const adapter = createHarness(async (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
      });
      if (String(url).endsWith("/search/memories")) {
        return jsonResponse({ results: "memory", total: 1, strategy: "hybrid" });
      }
      return jsonResponse({ results: "conversation", total: 1 });
    });

    await expect(adapter.searchMemories({
      query: "adapter",
      limit: 3,
      scene: "langgraph",
    })).resolves.toEqual({
      results: "memory",
      total: 1,
      strategy: "hybrid",
    });
    await expect(adapter.searchConversations(
      { query: "previous decision", limit: 2 },
      {},
      { configurable: { thread_id: "thread-42" } },
    )).resolves.toEqual({
      results: "conversation",
      total: 1,
    });

    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:8420/search/memories",
        body: {
          query: "adapter",
          limit: 3,
          scene: "langgraph",
        },
      },
      {
        url: "http://127.0.0.1:8420/search/conversations",
        body: {
          query: "previous decision",
          limit: 2,
          session_key: "thread-42",
        },
      },
    ]);
  });

  it("fails open and clears stale recall state when the Gateway is unavailable", async () => {
    const logger = { warn: vi.fn() };
    const adapter = createHarness(
      async () => {
        throw new Error("offline");
      },
      { logger },
    );

    await expect(adapter.recallNode(
      { messages: [{ role: "user", content: "hello" }] },
      { configurable: { thread_id: "thread-42" } },
    )).resolves.toEqual({ memoryContext: "" });
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("supports fail-closed graphs when memory is mandatory", async () => {
    const adapter = createHarness(
      async () => {
        throw new Error("offline");
      },
      { failClosed: true },
    );

    await expect(adapter.recallNode(
      { messages: [{ role: "user", content: "hello" }] },
      { configurable: { thread_id: "thread-42" } },
    )).rejects.toThrow("offline");
  });
});

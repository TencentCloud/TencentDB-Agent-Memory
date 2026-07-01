import { describe, expect, it } from "vitest";

import {
  createMemoryTencentDbSearchTool,
  resolveLangGraphMemoryContext,
  runMemoryWrappedTurn,
} from "../../integrations/langgraph/adapter.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("LangGraph adapter", () => {
  it("uses thread_id as the Gateway session identity", () => {
    expect(resolveLangGraphMemoryContext({
      context: {
        thread_id: "thread-a",
        userId: "user-a",
      },
    })).toEqual({
      sessionKey: "thread-a",
      sessionId: "thread-a",
      userId: "user-a",
    });
  });

  it("runs recall, model, and capture in order", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const prompts: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (String(input).endsWith("/recall")) {
        return jsonResponse({ context: "Remember: use Gateway." });
      }
      return jsonResponse({ ok: true });
    };

    const result = await runMemoryWrappedTurn({
      input: "Build the adapter",
      runtime: {
        configurable: {
          thread_id: "thread-b",
          user_id: "user-b",
        },
      },
      gateway: {
        baseUrl: "http://127.0.0.1:8420",
        fetchImpl: fetchImpl as typeof fetch,
      },
      model: async (prompt) => {
        prompts.push(prompt);
        return "Adapter built.";
      },
    });

    expect(result).toEqual({
      answer: "Adapter built.",
      memoryContext: "Remember: use Gateway.",
    });
    expect(prompts).toEqual(["Remember: use Gateway.\n\nBuild the adapter"]);
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:8420/recall",
        body: {
          query: "Build the adapter",
          session_key: "thread-b",
          user_id: "user-b",
        },
      },
      {
        url: "http://127.0.0.1:8420/capture",
        body: {
          user_content: "Build the adapter",
          assistant_content: "Adapter built.",
          session_key: "thread-b",
          session_id: "thread-b",
          user_id: "user-b",
          messages: [
            { role: "user", content: "Build the adapter" },
            { role: "assistant", content: "Adapter built." },
          ],
        },
      },
    ]);
  });

  it("forwards memory search tool calls to the Gateway", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const tool = createMemoryTencentDbSearchTool({
      baseUrl: "http://127.0.0.1:8420",
      fetchImpl: (async (input, init) => {
        calls.push({
          url: String(input),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return jsonResponse({ results: "memory", total: 1, strategy: "vector" });
      }) as typeof fetch,
    });

    await expect(tool.invoke({
      query: "adapter",
      limit: 3,
      scene: "langgraph",
    })).resolves.toEqual({ results: "memory", total: 1, strategy: "vector" });
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:8420/search/memories",
        body: {
          query: "adapter",
          limit: 3,
          scene: "langgraph",
        },
      },
    ]);
  });
});


import { describe, expect, it, vi } from "vitest";

import { GatewayMemoryClient } from "../gateway-client/index.js";
import {
  createTdaiLangChainMiddleware,
  type LangChainMemoryMiddlewareDefinition,
} from "./index.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function createHarness(fetchImpl: typeof fetch, failClosed = false) {
  const client = new GatewayMemoryClient({
    baseUrl: "http://127.0.0.1:8420",
    fetchImpl,
  });
  let definition: LangChainMemoryMiddlewareDefinition | undefined;
  const middleware = createTdaiLangChainMiddleware(
    (value) => {
      definition = value;
      return value;
    },
    {
      client,
      failClosed,
      resolveContext: (_state, runtime) => ({
        sessionKey: String((runtime.context as { threadId: string }).threadId),
        sessionId: "run-1",
        userId: "user-1",
      }),
    },
  );
  return { definition: definition ?? middleware, middleware };
}

describe("createTdaiLangChainMiddleware", () => {
  it("recalls memory once before an agent run and injects system context", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const { middleware } = createHarness(async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return jsonResponse({ context: "User prefers concise TypeScript.", memory_count: 1 });
    });

    const result = await middleware.beforeAgent(
      { messages: [{ role: "user", content: "Help with this API" }] },
      { context: { threadId: "thread-42" } },
    );

    expect(result).toEqual({
      messages: [{
        role: "system",
        content: "Relevant long-term memory:\nUser prefers concise TypeScript.",
      }],
    });
    expect(calls).toEqual([{
      url: "http://127.0.0.1:8420/recall",
      body: {
        query: "Help with this API",
        session_key: "thread-42",
        user_id: "user-1",
      },
    }]);
  });

  it("captures the final completed user and assistant turn", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const { middleware } = createHarness(async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return jsonResponse({ l0_recorded: 2, scheduler_notified: true });
    });
    const messages = [
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
      { type: "human", content: [{ type: "text", text: "new question" }] },
      { _getType: () => "ai", content: "new answer" },
    ];

    await middleware.afterAgent(
      { messages },
      { context: { threadId: "thread-42" } },
    );

    expect(calls).toEqual([{
      url: "http://127.0.0.1:8420/capture",
      body: {
        user_content: "new question",
        assistant_content: "new answer",
        messages: [
          { role: "user", content: "old question" },
          { role: "assistant", content: "old answer" },
          { role: "user", content: "new question" },
          { role: "assistant", content: "new answer" },
        ],
        session_key: "thread-42",
        session_id: "run-1",
        user_id: "user-1",
      },
    }]);
  });

  it("skips recall or capture when a completed turn is unavailable", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { middleware } = createHarness(fetchImpl);

    await expect(middleware.beforeAgent({ messages: [] }, { context: { threadId: "t" } }))
      .resolves.toBeUndefined();
    await expect(middleware.afterAgent(
      { messages: [{ role: "user", content: "unfinished" }] },
      { context: { threadId: "t" } },
    )).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails open by default when the Gateway is unavailable", async () => {
    const logger = { warn: vi.fn() };
    const client = new GatewayMemoryClient({
      baseUrl: "http://127.0.0.1:8420",
      fetchImpl: async () => { throw new Error("offline"); },
    });
    const middleware = createTdaiLangChainMiddleware((value) => value, {
      client,
      logger,
      resolveContext: () => ({ sessionKey: "thread-1" }),
    });

    await expect(middleware.beforeAgent(
      { messages: [{ role: "user", content: "hello" }] },
      {},
    )).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("supports fail-closed mode for deployments that require memory", async () => {
    const { middleware } = createHarness(async () => { throw new Error("offline"); }, true);

    await expect(middleware.beforeAgent(
      { messages: [{ role: "user", content: "hello" }] },
      { context: { threadId: "thread-42" } },
    )).rejects.toThrow("offline");
  });
});

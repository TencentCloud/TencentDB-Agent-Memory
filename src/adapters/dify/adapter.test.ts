import { describe, expect, it, vi } from "vitest";
import { DifyMemoryAdapter } from "./adapter.js";

describe("DifyMemoryAdapter", () => {
  it("derives a platform-scoped session key from Dify context", () => {
    const adapter = new DifyMemoryAdapter({
      fetchImpl: vi.fn(),
      baseUrl: "http://127.0.0.1:8420",
      appId: "support-bot",
      userId: "alice",
      conversationId: "conv-1",
      workflowRunId: "run-1",
      workspaceDir: "C:/work/dify",
    });

    expect(adapter.getRuntime()).toMatchObject({
      platform: "dify",
      userId: "alice",
      sessionId: "conv-1",
      sessionKey: "dify:support-bot:alice:conv-1",
      workspaceDir: "C:/work/dify",
    });
    expect(adapter.getDifyContext()).toMatchObject({
      appId: "support-bot",
      userId: "alice",
      conversationId: "conv-1",
      workflowRunId: "run-1",
    });
  });

  it("maps recall context into Dify prompt sections", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      context: "stable",
      prepend_context: "dynamic",
      append_system_context: "system",
      strategy: "hybrid",
      memory_count: 1,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const adapter = new DifyMemoryAdapter({
      fetchImpl,
      baseUrl: "http://127.0.0.1:8420",
      appId: "support-bot",
      userId: "alice",
      conversationId: "conv-1",
      query: "where is my order?",
    });

    await expect(adapter.buildPromptContext()).resolves.toEqual({
      prependUserContext: "dynamic",
      appendSystemContext: "system",
    });
  });

  it("captures a Dify turn through the unified gateway payload", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toBe("http://127.0.0.1:8420/capture");
      const payload = JSON.parse(String(init?.body));
      expect(payload).toMatchObject({
        user_content: "hello",
        assistant_content: "world",
        session_key: "dify:support-bot:alice:conv-1",
        session_id: "conv-1",
        user_id: "alice",
      });
      expect(payload.messages).toHaveLength(2);
      expect(payload.messages[0].metadata.platform).toBe("dify");
      return new Response(JSON.stringify({ l0_recorded: 2, scheduler_notified: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const adapter = new DifyMemoryAdapter({
      fetchImpl,
      baseUrl: "http://127.0.0.1:8420",
      appId: "support-bot",
      userId: "alice",
      conversationId: "conv-1",
    });

    await expect(adapter.recordDifyTurn({
      query: "hello",
      answer: "world",
      inputs: { locale: "zh-CN" },
    })).resolves.toEqual({ l0Recorded: 2, schedulerNotified: true });
  });
});

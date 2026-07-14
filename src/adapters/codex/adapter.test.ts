import { describe, expect, it, vi } from "vitest";
import { CodexMemoryAdapter } from "./adapter.js";

describe("CodexMemoryAdapter", () => {
  it("derives a stable codex session key", () => {
    vi.stubEnv("CODEX_USER_ID", "alice");
    vi.stubEnv("CODEX_SESSION_ID", "thread-42");
    vi.stubEnv("CODEX_WORKSPACE_DIR", "C:/work/project");

    const adapter = new CodexMemoryAdapter({
      fetchImpl: vi.fn(),
      baseUrl: "http://127.0.0.1:8420",
    });

    expect(adapter.getRuntime()).toMatchObject({
      platform: "codex",
      userId: "alice",
      sessionId: "thread-42",
      sessionKey: "codex:alice:thread-42",
      workspaceDir: "C:/work/project",
    });
  });

  it("maps recall context into prompt sections", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        context: "stable",
        prepend_context: "dynamic",
        append_system_context: "system",
        strategy: "hybrid",
        memory_count: 2,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const adapter = new CodexMemoryAdapter({
      fetchImpl,
      baseUrl: "http://127.0.0.1:8420",
      userId: "alice",
      sessionId: "thread-42",
      workspaceDir: "C:/work/project",
    });

    const promptContext = await adapter.buildPromptContext("remember this");
    expect(promptContext).toEqual({
      prependUserContext: "dynamic",
      appendSystemContext: "system",
    });
    expect(calls[0]?.url).toBe("http://127.0.0.1:8420/recall");
    expect(calls[0]?.init?.method).toBe("POST");
  });

  it("records turns through the gateway client", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/capture")) {
        const payload = JSON.parse(String(init?.body));
        expect(payload).toMatchObject({
          user_content: "hello",
          assistant_content: "world",
          session_key: "codex:alice:thread-42",
          session_id: "thread-42",
          user_id: "alice",
        });
        return new Response(JSON.stringify({ l0_recorded: 1, scheduler_notified: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const adapter = new CodexMemoryAdapter({
      fetchImpl,
      baseUrl: "http://127.0.0.1:8420",
      userId: "alice",
      sessionId: "thread-42",
      workspaceDir: "C:/work/project",
    });

    const result = await adapter.recordTurn({
      userContent: "hello",
      assistantContent: "world",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(result).toEqual({ l0Recorded: 1, schedulerNotified: true });
  });
});

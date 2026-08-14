import { describe, expect, it, vi } from "vitest";
import { handleGeminiCliHook } from "./hook-handler.js";
import type { TdaiGatewayClientLike } from "./gateway-client.js";

function createClient(overrides: Partial<TdaiGatewayClientLike> = {}): TdaiGatewayClientLike {
  return {
    recall: vi.fn(async () => ({ context: "", strategy: "none", memory_count: 0 })),
    capture: vi.fn(async () => ({ l0_recorded: 1, scheduler_notified: true })),
    endSession: vi.fn(async () => ({ flushed: true })),
    ...overrides,
  };
}

describe("handleGeminiCliHook", () => {
  it("injects recalled context before an agent turn", async () => {
    const client = createClient({
      recall: vi.fn(async () => ({
        context: "<relevant-memories>remembered fact</relevant-memories>",
        strategy: "hybrid",
        memory_count: 1,
      })),
    });

    const output = await handleGeminiCliHook({
      hook_event_name: "BeforeAgent",
      session_id: "session-1",
      prompt: "What should I do next?",
    }, client);

    expect(client.recall).toHaveBeenCalledWith({
      query: "What should I do next?",
      sessionKey: "session-1",
    });
    expect(output).toEqual({
      hookSpecificOutput: { additionalContext: "<relevant-memories>remembered fact</relevant-memories>" },
    });
  });

  it("stays silent when recall returns no context", async () => {
    const client = createClient();
    const output = await handleGeminiCliHook({
      hook_event_name: "BeforeAgent",
      session_id: "session-1",
      prompt: "hello",
    }, client);
    expect(output).toEqual({});
  });

  it("captures a completed turn after the agent responds", async () => {
    const client = createClient();
    const output = await handleGeminiCliHook({
      hook_event_name: "AfterAgent",
      session_id: "session-1",
      prompt: "Remember this project",
      prompt_response: "I will remember it.",
    }, client);

    expect(client.capture).toHaveBeenCalledWith({
      userContent: "Remember this project",
      assistantContent: "I will remember it.",
      sessionKey: "session-1",
      sessionId: "session-1",
    });
    expect(output).toEqual({});
  });

  it("flushes the session on SessionEnd", async () => {
    const client = createClient();
    const output = await handleGeminiCliHook({
      hook_event_name: "SessionEnd",
      session_id: "session-1",
      reason: "exit",
    }, client);
    expect(client.endSession).toHaveBeenCalledWith({ sessionKey: "session-1" });
    expect(output).toEqual({});
  });

  it("is fail-open when the gateway is unavailable", async () => {
    const client = createClient({
      recall: vi.fn(async () => { throw new Error("connection refused"); }),
    });
    const logger = { error: vi.fn() };

    const output = await handleGeminiCliHook({
      hook_event_name: "BeforeAgent",
      session_id: "session-1",
      prompt: "hello",
    }, client, logger);

    expect(output).toEqual({});
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("fail-open"));
  });

  it("ignores unknown hook events", async () => {
    const client = createClient();
    const output = await handleGeminiCliHook({ hook_event_name: "BeforeTool" }, client);
    expect(output).toEqual({});
    expect(client.recall).not.toHaveBeenCalled();
  });
});

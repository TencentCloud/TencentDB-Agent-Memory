import { describe, expect, it, vi } from "vitest";

import {
  runCaptureHook,
  runHealthHook,
  runRecallHook,
  runSessionEndHook,
} from "./hook-runner.js";
import { BasePlatformAdapter, defineAdapter } from "./platform-adapter.js";

const adapter = new BasePlatformAdapter({ name: "test" });

/** Minimal fake TdaiGatewayClient. */
function fakeClient(overrides: Record<string, any> = {}): any {
  return {
    health: vi.fn().mockResolvedValue({ status: "ok" }),
    recall: vi.fn().mockResolvedValue({ context: "ctx" }),
    capture: vi.fn().mockResolvedValue({ l0_recorded: true }),
    endSession: vi.fn().mockResolvedValue({ flushed: true }),
    ...overrides,
  };
}

describe("runHealthHook", () => {
  it("returns true when the Gateway answers", async () => {
    const client = fakeClient();
    await expect(runHealthHook(client)).resolves.toBe(true);
    expect(client.health).toHaveBeenCalledWith(5000);
  });

  it("returns false (never throws) when the Gateway is down", async () => {
    const client = fakeClient({ health: vi.fn().mockRejectedValue(new Error("down")) });
    await expect(runHealthHook(client)).resolves.toBe(false);
  });
});

describe("runRecallHook", () => {
  it("recalls context and writes the adapter-formatted output", async () => {
    const client = fakeClient();
    const writes: string[] = [];
    const out = await runRecallHook(adapter, client, {
      payload: { prompt: "hello", session_id: "s1" },
      write: (s) => writes.push(s),
    });
    expect(client.recall).toHaveBeenCalledWith({ query: "hello", sessionKey: "s1" });
    expect(out).not.toBeNull();
    expect(JSON.parse(out!)).toEqual({
      decision: "pass",
      additional_context: "## Memory Context\nctx",
    });
    expect(writes).toEqual([out + "\n"]);
  });

  it("supports host-specific output formats (Codex shape)", async () => {
    const codexLike = defineAdapter({
      name: "codex",
      formatRecallOutput: (context) =>
        JSON.stringify({
          hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
        }),
    });
    const out = await runRecallHook(codexLike, fakeClient(), {
      payload: { prompt: "q", session_id: "s" },
      write: () => {},
    });
    expect(JSON.parse(out!)).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "ctx" },
    });
  });

  it("remaps in-process tool names to the MCP bridge tool names", async () => {
    const client = fakeClient({
      recall: vi.fn().mockResolvedValue({
        context:
          "可调用 tdai_memory_search 或 tdai_conversation_search；tdai_memory_search 适用于 L1。",
      }),
    });
    const out = await runRecallHook(adapter, client, {
      payload: { prompt: "q", session_id: "s" },
      write: () => {},
    });
    const ctx = JSON.parse(out!).additional_context as string;
    expect(ctx).toContain("search_memories");
    expect(ctx).toContain("search_conversations");
    expect(ctx).not.toContain("tdai_memory_search");
    expect(ctx).not.toContain("tdai_conversation_search");
  });

  it("stays silent when there is no prompt", async () => {
    const client = fakeClient();
    const writes: string[] = [];
    const out = await runRecallHook(adapter, client, {
      payload: {},
      write: (s) => writes.push(s),
    });
    expect(out).toBeNull();
    expect(writes).toEqual([]);
    expect(client.recall).not.toHaveBeenCalled();
  });

  it("stays silent when the Gateway returns empty context", async () => {
    const client = fakeClient({ recall: vi.fn().mockResolvedValue({ context: "" }) });
    const writes: string[] = [];
    const out = await runRecallHook(adapter, client, {
      payload: { prompt: "q" },
      write: (s) => writes.push(s),
    });
    expect(out).toBeNull();
    expect(writes).toEqual([]);
  });

  it("stays silent (never throws) when the Gateway fails", async () => {
    const client = fakeClient({ recall: vi.fn().mockRejectedValue(new Error("boom")) });
    const writes: string[] = [];
    const out = await runRecallHook(adapter, client, {
      payload: { prompt: "q" },
      write: (s) => writes.push(s),
    });
    expect(out).toBeNull();
    expect(writes).toEqual([]);
  });

  it("stays silent on malformed stdin payloads", async () => {
    const { Readable } = await import("node:stream");
    const stdin = Readable.from(["not json"]);
    const out = await runRecallHook(adapter, fakeClient(), {
      stdin: stdin as any,
      write: () => {},
    });
    expect(out).toBeNull();
  });
});

describe("runCaptureHook", () => {
  it("sends the finished turn to the Gateway", async () => {
    const client = fakeClient();
    const ok = await runCaptureHook(adapter, client, {
      payload: { prompt: "u", last_assistant_text: "a", session_id: "s1" },
    });
    expect(ok).toBe(true);
    expect(client.capture).toHaveBeenCalledWith({
      userContent: "u",
      assistantContent: "a",
      sessionKey: "s1",
    });
  });

  it("supports async parseCapturePayload (transcript-style hosts)", async () => {
    const transcriptAdapter = defineAdapter({
      name: "async",
      parseCapturePayload: async () => ({
        userContent: "from-transcript-u",
        assistantContent: "from-transcript-a",
        sessionKey: "s",
      }),
    });
    const client = fakeClient();
    await expect(runCaptureHook(transcriptAdapter, client, { payload: {} })).resolves.toBe(true);
    expect(client.capture).toHaveBeenCalledWith({
      userContent: "from-transcript-u",
      assistantContent: "from-transcript-a",
      sessionKey: "s",
    });
  });

  it("skips empty turns without calling the Gateway", async () => {
    const client = fakeClient();
    await expect(runCaptureHook(adapter, client, { payload: {} })).resolves.toBe(false);
    expect(client.capture).not.toHaveBeenCalled();
  });

  it("returns false (never throws) when the Gateway fails", async () => {
    const client = fakeClient({ capture: vi.fn().mockRejectedValue(new Error("boom")) });
    await expect(
      runCaptureHook(adapter, client, { payload: { prompt: "u", last_assistant_text: "a" } }),
    ).resolves.toBe(false);
  });
});

describe("runSessionEndHook", () => {
  it("flushes the session via /session/end", async () => {
    const client = fakeClient();
    const ok = await runSessionEndHook(adapter, client, { payload: { session_id: "s1" } });
    expect(ok).toBe(true);
    expect(client.endSession).toHaveBeenCalledWith({ sessionKey: "s1" });
  });

  it("skips when the payload has no session key", async () => {
    const client = fakeClient();
    await expect(runSessionEndHook(adapter, client, { payload: {} })).resolves.toBe(false);
    expect(client.endSession).not.toHaveBeenCalled();
  });

  it("returns false (never throws) when the Gateway fails", async () => {
    const client = fakeClient({ endSession: vi.fn().mockRejectedValue(new Error("boom")) });
    await expect(
      runSessionEndHook(adapter, client, { payload: { session_id: "s" } }),
    ).resolves.toBe(false);
  });
});

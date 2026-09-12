import { describe, expect, it, vi } from "vitest";
import { PiAgentLifecycleAdapter } from "./lifecycle.js";
import type { PiAgentAdapterConfig } from "./types.js";

const config: PiAgentAdapterConfig = {
  gatewayUrl: "http://127.0.0.1:8420",
  autoRecall: true,
  autoCapture: true,
  recallMaxChars: 1000,
  defaultUserId: "default_user",
};

describe("PiAgentLifecycleAdapter", () => {
  it("recalls and injects context on session_start", async () => {
    const client = {
      recall: vi.fn(async () => ({ context: "persona: use architecture-first design", strategy: "keyword", memory_count: 1 })),
      seed: vi.fn(),
      sessionEnd: vi.fn(),
    };
    const injected: unknown[] = [];
    const adapter = new PiAgentLifecycleAdapter(client, config, async (ctx) => injected.push(ctx));

    const result = await adapter.onSessionStart({ sessionId: "s1", workspace: "D:/repo", prompt: "continue adapter work" });

    expect(client.recall).toHaveBeenCalledWith(expect.objectContaining({ query: "continue adapter work" }));
    expect(result?.message?.content).toContain("architecture-first");
    expect(injected).toHaveLength(1);
  });

  it("imports complete user/assistant turns on session_end", async () => {
    const client = {
      recall: vi.fn(),
      seed: vi.fn(async () => ({ l0_recorded: 2 })),
      sessionEnd: vi.fn(async () => ({ flushed: true })),
    };
    const adapter = new PiAgentLifecycleAdapter(client, config);

    const result = await adapter.onSessionEnd({
      sessionId: "s1",
      workspace: "D:/repo",
      messages: [
        { role: "user", content: "build pi adapter", timestamp: 1 },
        { role: "assistant", content: "done", timestamp: 2 },
      ],
    });

    expect(result).toEqual({ captured: true, l0Recorded: 2 });
    expect(client.seed).toHaveBeenCalledWith(expect.objectContaining({
      strict_round_role: false,
      auto_fill_timestamps: true,
      data: expect.objectContaining({ sessions: expect.any(Array) }),
    }));
    expect(client.sessionEnd).toHaveBeenCalledWith(expect.objectContaining({ session_key: expect.stringMatching(/^pi-agent:/) }));
  });

  it("skips session_end when there are no complete turns", async () => {
    const client = { recall: vi.fn(), seed: vi.fn(), sessionEnd: vi.fn() };
    const adapter = new PiAgentLifecycleAdapter(client, config);

    await expect(adapter.onSessionEnd({ messages: [{ role: "user", content: "only user" }] })).resolves.toEqual({
      captured: false,
      skippedReason: "no complete user/assistant turns",
    });
    expect(client.seed).not.toHaveBeenCalled();
  });
});
import type { PluginInput, ToolContext } from "@opencode-ai/plugin";
import { describe, expect, it, vi } from "vitest";

import type { MemoryClientLike } from "../src/client.js";
import type { OpenCodeMemoryConfig } from "../src/config.js";
import { createOpenCodeMemoryHooks } from "../src/plugin.js";

const config: OpenCodeMemoryConfig = {
  endpoint: "http://127.0.0.1:8420",
  apiKey: "key",
  serviceId: "service",
  teamId: "team",
  agentId: "opencode",
  userId: "user",
  timeoutMs: 5_000,
  recallLimit: 5,
  maxContextChars: 8_000,
  recallEnabled: true,
  captureEnabled: true,
  allowInsecureHttp: false,
};

function setup() {
  const memory: MemoryClientLike = {
    recall: vi.fn().mockResolvedValue({
      atomic: [{ id: "1", type: "preference", content: "Prefer tests" }],
      core: null,
      warnings: [],
    }),
    captureTurn: vi.fn().mockResolvedValue(undefined),
    searchAtomic: vi.fn().mockResolvedValue([]),
    searchConversation: vi.fn().mockResolvedValue([]),
    check: vi.fn().mockResolvedValue(3),
  };
  const client = {
    session: {
      messages: vi.fn().mockResolvedValue({
        data: [
          {
            info: { id: "u1", role: "user", sessionID: "s1" },
            parts: [{ type: "text", text: "question" }],
          },
          {
            info: {
              id: "a1",
              role: "assistant",
              parentID: "u1",
              sessionID: "s1",
              time: { completed: 1000 },
            },
            parts: [{ type: "text", text: "answer" }],
          },
        ],
      }),
    },
  } as unknown as PluginInput["client"];
  const hooks = createOpenCodeMemoryHooks({
    client,
    directory: "C:/workspace",
    config,
    memory,
    log: vi.fn().mockResolvedValue(undefined),
  });
  return { hooks, memory, client };
}

describe("OpenCode memory hooks", () => {
  it("recalls from the user message and injects bounded system context", async () => {
    const { hooks, memory } = setup();
    await hooks["chat.message"]!(
      { sessionID: "s1" },
      { message: {} as never, parts: [{ type: "text", text: "How should I test this?" }] as never },
    );
    const output = { system: [] as string[] };

    await hooks["experimental.chat.system.transform"]!(
      { sessionID: "s1", model: {} as never },
      output,
    );

    expect(memory.recall).toHaveBeenCalledWith("How should I test this?");
    expect(output.system[0]).toContain("Prefer tests");
  });

  it("captures a completed turn only once across repeated idle events", async () => {
    const { hooks, memory } = setup();
    const idle = { type: "session.idle", properties: { sessionID: "s1" } } as never;

    await hooks.event!({ event: idle });
    await hooks.event!({ event: idle });

    expect(memory.captureTurn).toHaveBeenCalledTimes(1);
    expect(memory.captureTurn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s1", user: "question", assistant: "answer" }),
    );
  });

  it("exposes a status tool backed by the memory service", async () => {
    const { hooks } = setup();
    const context = { abort: new AbortController().signal } as ToolContext;

    const result = await hooks.tool!.tdai_memory_status!.execute({}, context);

    expect(result).toContain("Atomic memories: 3");
  });
});

import { describe, expect, it, vi } from "vitest";
import { createMemoryTools } from "../src/tools.js";
import type { MemoryService } from "../src/memory-service.js";
import type { OpenCodeMemoryRuntime } from "../src/plugin-runtime.js";
import { formatRecallInjection } from "../src/message-codec.js";

const context = {
  sessionID: "session",
  messageID: "message",
  agent: "build",
  directory: process.cwd(),
  worktree: process.cwd(),
  abort: new AbortController().signal,
  metadata: vi.fn(),
  ask: vi.fn(),
};

describe("OpenCode memory tools", () => {
  it("registers the complete seven-tool surface", () => {
    const tools = createMemoryTools(
      {} as OpenCodeMemoryRuntime,
      {} as MemoryService,
    );
    expect(Object.keys(tools).sort()).toEqual([
      "agent_conversation_search",
      "agent_memory_capture",
      "agent_memory_health",
      "agent_memory_recall",
      "agent_memory_search",
      "agent_memory_seed",
      "agent_memory_session_end",
    ]);
  });

  it("routes recall with OpenCode session identity", async () => {
    const recall = vi.fn(async () => ({ context: "memory" }));
    const runtime = {
      resolveSession: vi.fn(() => "resolved"),
      userId: vi.fn(() => "user"),
      formatter: {
        recall: vi.fn(() => "formatted"),
        unavailable: vi.fn(),
      },
    } as unknown as OpenCodeMemoryRuntime;
    const service = {
      client: { recall },
      run: async <T>(operation: () => Promise<T>) => operation(),
    } as unknown as MemoryService;

    const result = await createMemoryTools(
      runtime,
      service,
    ).agent_memory_recall!.execute({ query: "query" }, context);
    expect(result).toBe("formatted");
    expect(recall).toHaveBeenCalledWith({
      query: "query",
      session_key: "resolved",
      user_id: "user",
    });
  });

  it("strips recalled blocks and source timestamps from explicit capture", async () => {
    const capture = vi.fn(async () => ({
      l0_recorded: 2,
      scheduler_notified: true,
    }));
    const runtime = {
      resolveSession: vi.fn(() => "resolved"),
      userId: vi.fn(() => "user"),
      formatter: {
        capture: vi.fn(() => "captured"),
        unavailable: vi.fn(),
      },
    } as unknown as OpenCodeMemoryRuntime;
    const service = {
      client: { capture },
      run: async <T>(operation: () => Promise<T>) => operation(),
    } as unknown as MemoryService;
    const recalled = formatRecallInjection("old memory");

    await createMemoryTools(runtime, service).agent_memory_capture!.execute(
      {
        user_content: `request\n${recalled}`,
        assistant_content: "answer",
        messages: [
          { role: "user", content: `request\n${recalled}`, timestamp: 1 },
        ],
      },
      context,
    );

    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        user_content: "request",
        messages: [{ role: "user", content: "request" }],
      }),
    );
  });
});

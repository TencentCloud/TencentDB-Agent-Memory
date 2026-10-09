import { describe, it, expect, vi } from "vitest";
import {
  registerCodexMemoryTools,
  type CodexMemoryClient,
  type ToolConfig,
  type ToolRegistrationTarget,
} from "./mcp-server.js";

interface CapturedTool {
  name: string;
  config: ToolConfig;
  handler: (args: unknown, extra?: unknown) => unknown;
}

function createFakeTarget(): ToolRegistrationTarget & { tools: CapturedTool[] } {
  const tools: CapturedTool[] = [];
  return {
    tools,
    registerTool(name, config, handler) {
      tools.push({ name, config, handler });
    },
  };
}

function createFakeClient(): CodexMemoryClient & {
  calls: Array<{ method: string; args: unknown }>;
} {
  const calls: Array<{ method: string; args: unknown }> = [];
  return {
    calls,
    recall: vi.fn(async (args) => {
      calls.push({ method: "recall", args });
      return { context: "context", strategy: "bm25", memory_count: 1 };
    }),
    capture: vi.fn(async (args) => {
      calls.push({ method: "capture", args });
      return { l0_recorded: 1, scheduler_notified: true };
    }),
    searchMemories: vi.fn(async (args) => {
      calls.push({ method: "searchMemories", args });
      return { results: [] };
    }),
    searchConversations: vi.fn(async (args) => {
      calls.push({ method: "searchConversations", args });
      return { results: [] };
    }),
    endSession: vi.fn(async (args) => {
      calls.push({ method: "endSession", args });
      return { ok: true };
    }),
  };
}

describe("registerCodexMemoryTools", () => {
  it("registers all five expected tools", () => {
    const target = createFakeTarget();
    const client = createFakeClient();
    registerCodexMemoryTools(target, client);

    const names = target.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "tdai_capture",
      "tdai_conversation_search",
      "tdai_memory_search",
      "tdai_recall",
      "tdai_session_end",
    ]);
  });

  it("recall handler forwards parsed input and serializes the result", async () => {
    const target = createFakeTarget();
    const client = createFakeClient();
    registerCodexMemoryTools(target, client);

    const recallTool = target.tools.find((t) => t.name === "tdai_recall")!;
    const result = await recallTool.handler({
      query: "how do I connect?",
      session_key: "session-1",
    });

    expect(client.calls).toEqual([
      {
        method: "recall",
        args: { query: "how do I connect?", session_key: "session-1" },
      },
    ]);
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { context: "context", strategy: "bm25", memory_count: 1 },
            null,
            2,
          ),
        },
      ],
    });
  });

  it("tdai_memory_search normalizes limit before forwarding", async () => {
    const target = createFakeTarget();
    const client = createFakeClient();
    registerCodexMemoryTools(target, client);

    const tool = target.tools.find((t) => t.name === "tdai_memory_search")!;
    await tool.handler({ query: "test", limit: 99 });

    expect(client.calls).toEqual([
      { method: "searchMemories", args: { query: "test", limit: 20 } },
    ]);
  });

  it("tdai_conversation_search normalizes limit before forwarding", async () => {
    const target = createFakeTarget();
    const client = createFakeClient();
    registerCodexMemoryTools(target, client);

    const tool = target.tools.find(
      (t) => t.name === "tdai_conversation_search",
    )!;
    await tool.handler({ query: "test", limit: 0 });

    expect(client.calls).toEqual([
      { method: "searchConversations", args: { query: "test", limit: 1 } },
    ]);
  });
});

import { describe, expect, it, vi } from "vitest";
import { executeTdaiMcpTool, TDAI_MCP_TOOLS } from "./tool-registry.js";
import type { TdaiMcpCore } from "./tool-registry.js";

function createCore(): TdaiMcpCore {
  return {
    handleBeforeRecall: vi.fn(async () => ({
      appendSystemContext: "persona: prefers Chinese docs",
      prependContext: "memory: issue 235",
      recallStrategy: "keyword",
      recalledL1Memories: [{ content: "prefers Chinese docs", score: 0.9, type: "instruction" }],
      recalledL3Persona: null,
    })),
    handleTurnCommitted: vi.fn(async () => ({
      l0RecordedCount: 2,
      schedulerNotified: true,
      l0VectorsWritten: 0,
      filteredMessages: [],
    })),
    searchMemories: vi.fn(async () => ({
      text: "memory result",
      total: 1,
      strategy: "keyword",
    })),
    searchConversations: vi.fn(async () => ({
      text: "conversation result",
      total: 1,
    })),
    handleSessionEnd: vi.fn(async () => undefined),
  };
}

describe("TDAI MCP tool registry", () => {
  it("exposes deterministic memory tools", () => {
    expect(TDAI_MCP_TOOLS.map((tool) => tool.name)).toEqual([
      "tdai_recall",
      "tdai_capture",
      "tdai_memory_search",
      "tdai_conversation_search",
      "tdai_session_end",
    ]);
  });

  it("executes recall through TdaiCore", async () => {
    const core = createCore();
    const result = await executeTdaiMcpTool(core, "tdai_recall", {
      query: "What should I remember?",
      session_key: "session-1",
    });

    expect(core.handleBeforeRecall).toHaveBeenCalledWith("What should I remember?", "session-1");
    expect(result.content[0].text).toContain("prefers Chinese docs");
    expect(result.structuredContent).toMatchObject({
      strategy: "keyword",
      memory_count: 1,
    });
  });

  it("executes capture through TdaiCore", async () => {
    const core = createCore();
    const result = await executeTdaiMcpTool(core, "tdai_capture", {
      user_content: "remember this",
      assistant_content: "stored",
      session_key: "session-1",
    });

    expect(core.handleTurnCommitted).toHaveBeenCalledWith(expect.objectContaining({
      userText: "remember this",
      assistantText: "stored",
      sessionKey: "session-1",
    }));
    expect(result.structuredContent).toMatchObject({
      l0_recorded: 2,
      scheduler_notified: true,
    });
  });

  it("rejects missing required arguments", async () => {
    const core = createCore();
    await expect(executeTdaiMcpTool(core, "tdai_memory_search", {}))
      .rejects.toThrow("Missing required string argument: query");
  });
});

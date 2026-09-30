import { describe, expect, it } from "vitest";
import { callClaudeCodeMcpTool, CLAUDE_CODE_MCP_TOOLS } from "./tools.js";

describe("Claude Code MCP tools", () => {
  it("declares the expected search tools", () => {
    expect(CLAUDE_CODE_MCP_TOOLS.map((tool) => tool.name)).toEqual([
      "memory_tencentdb_memory_search",
      "memory_tencentdb_conversation_search",
    ]);
  });

  it("calls memory search with normalized args", async () => {
    const calls: unknown[] = [];
    const result = await callClaudeCodeMcpTool(
      {
        searchMemories: async (args) => {
          calls.push(args);
          return { results: "memory result", total: 1, strategy: "hybrid" };
        },
        searchConversations: async () => {
          throw new Error("wrong endpoint");
        },
      },
      "memory_tencentdb_memory_search",
      { query: "  q  ", limit: 3, type: "preference", scene: "coding" },
    );

    expect(calls).toEqual([{ query: "q", limit: 3, type: "preference", scene: "coding" }]);
    expect(result.content[0].text).toContain("memory result");
  });

  it("calls conversation search with normalized args", async () => {
    const calls: unknown[] = [];
    const result = await callClaudeCodeMcpTool(
      {
        searchMemories: async () => {
          throw new Error("wrong endpoint");
        },
        searchConversations: async (args) => {
          calls.push(args);
          return { results: "conversation result", total: 2 };
        },
      },
      "memory_tencentdb_conversation_search",
      { query: "history", limit: 2, session_key: "agent:claude-code-x:s" },
    );

    expect(calls).toEqual([{ query: "history", limit: 2, session_key: "agent:claude-code-x:s" }]);
    expect(result.content[0].text).toContain("conversation result");
  });
});


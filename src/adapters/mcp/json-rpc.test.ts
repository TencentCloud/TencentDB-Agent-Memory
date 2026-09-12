import { describe, expect, it, vi } from "vitest";
import { TdaiMcpJsonRpcServer } from "./json-rpc.js";
import type { TdaiMcpCore } from "./tool-registry.js";

function createCore(): TdaiMcpCore {
  return {
    handleBeforeRecall: vi.fn(async () => ({
      appendSystemContext: "remembered context",
      recallStrategy: "keyword",
      recalledL1Memories: [],
    })),
    handleTurnCommitted: vi.fn(async () => ({
      l0RecordedCount: 2,
      schedulerNotified: true,
      l0VectorsWritten: 0,
      filteredMessages: [],
    })),
    searchMemories: vi.fn(async () => ({ text: "memory result", total: 1, strategy: "keyword" })),
    searchConversations: vi.fn(async () => ({ text: "conversation result", total: 1 })),
    handleSessionEnd: vi.fn(async () => undefined),
  };
}

describe("TDAI MCP JSON-RPC server", () => {
  it("responds to legacy initialize", async () => {
    const server = new TdaiMcpJsonRpcServer(createCore());
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    });

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-11-25",
        serverInfo: { name: "memory-tencentdb" },
        capabilities: { tools: { listChanged: false } },
      },
    });
  });

  it("responds to modern server discovery", async () => {
    const server = new TdaiMcpJsonRpcServer(createCore());
    const response = await server.handle({
      jsonrpc: "2.0",
      id: "discover",
      method: "server/discover",
    });

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: "discover",
      result: {
        supportedVersions: ["2026-07-28", "2025-11-25"],
        serverInfo: { name: "memory-tencentdb" },
        capabilities: { tools: { listChanged: false } },
      },
    });
  });

  it("responds to JSON-RPC requests with null id", async () => {
    const server = new TdaiMcpJsonRpcServer(createCore());
    const response = await server.handle({
      jsonrpc: "2.0",
      id: null,
      method: "tools/list",
    });

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      result: {
        resultType: "complete",
      },
    });
  });

  it("lists tools", async () => {
    const server = new TdaiMcpJsonRpcServer(createCore());
    const response = await server.handle({
      jsonrpc: "2.0",
      id: "tools",
      method: "tools/list",
    });

    const result = response?.result as { tools: Array<{ name: string }> };
    expect(result.tools.map((tool) => tool.name)).toContain("tdai_capture");
    expect(result.tools.map((tool) => tool.name)).toContain("tdai_memory_search");
  });

  it("calls tools and wraps the result", async () => {
    const core = createCore();
    const server = new TdaiMcpJsonRpcServer(core);
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "tdai_capture",
        arguments: {
          user_content: "u",
          assistant_content: "a",
          session_key: "s",
        },
      },
    });

    expect(core.handleTurnCommitted).toHaveBeenCalledOnce();
    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      result: {
        resultType: "complete",
        isError: false,
      },
    });
  });

  it("returns MCP tool errors as tool results", async () => {
    const server = new TdaiMcpJsonRpcServer(createCore());
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "tdai_memory_search",
        arguments: {},
      },
    });

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 3,
      result: {
        resultType: "complete",
        isError: true,
      },
    });
  });
});

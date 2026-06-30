import { describe, expect, it } from "vitest";

import { McpServer } from "../scripts/mcp-adapter/mcp-adapter.js";

describe("MCP adapter", () => {
  it("initializes with the client-requested protocol version", async () => {
    const server = new McpServer({
      gatewayUrl: "http://127.0.0.1:8420",
      timeoutMs: 1000,
      defaultSessionKey: "test-session",
    });

    const result = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });

    expect(result).toMatchObject({
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "memory-tencentdb-mcp" },
    });
  });

  it("lists the memory read/write tools exposed to MCP clients", async () => {
    const server = new McpServer({
      gatewayUrl: "http://127.0.0.1:8420",
      timeoutMs: 1000,
      defaultSessionKey: "test-session",
    });

    const result = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    const tools = (result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    expect(tools).toEqual([
      "memory_tencentdb_health",
      "memory_tencentdb_recall",
      "memory_tencentdb_capture",
      "memory_tencentdb_memory_search",
      "memory_tencentdb_conversation_search",
      "memory_tencentdb_session_end",
    ]);
  });
});

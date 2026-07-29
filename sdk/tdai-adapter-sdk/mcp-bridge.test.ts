import { describe, expect, it, vi } from "vitest";

import { createMcpBridge } from "./mcp-bridge.js";

function fakeClient(overrides: Record<string, any> = {}): any {
  return {
    searchMemories: vi.fn().mockResolvedValue({ results: "mem-results", total: 1 }),
    searchConversations: vi.fn().mockResolvedValue({ results: [{ id: 1 }], total: 1 }),
    ...overrides,
  };
}

function collector() {
  const lines: any[] = [];
  return {
    lines,
    write: (s: string) => lines.push(JSON.parse(s)),
  };
}

describe("createMcpBridge", () => {
  it("answers initialize with the original protocol version and serverInfo", async () => {
    const { lines, write } = collector();
    const bridge = createMcpBridge({ client: fakeClient(), write });
    await bridge.handle({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(lines[0]).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "tdai-memory", version: "1.0.0" },
      },
    });
  });

  it("lists the two search tools with unchanged names/schemas", async () => {
    const { lines, write } = collector();
    const bridge = createMcpBridge({ client: fakeClient(), write });
    await bridge.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = lines[0].result.tools;
    expect(tools.map((t: any) => t.name)).toEqual(["search_memories", "search_conversations"]);
    expect(tools[0].inputSchema.required).toEqual(["query"]);
    expect(tools[1].inputSchema.properties.session_key).toBeDefined();
  });

  it("proxies search_memories to the client (string results pass through)", async () => {
    const client = fakeClient();
    const { lines, write } = collector();
    const bridge = createMcpBridge({ client, write });
    await bridge.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "search_memories", arguments: { query: "q", limit: "5", type: "record" } },
    });
    // limit is coerced to a number, matching the original bridge.
    expect(client.searchMemories).toHaveBeenCalledWith({
      query: "q",
      limit: 5,
      type: "record",
      scene: undefined,
    });
    expect(lines[0].result).toEqual({
      content: [{ type: "text", text: "mem-results" }],
      isError: false,
    });
  });

  it("proxies search_conversations and JSON-stringifies non-string results", async () => {
    const client = fakeClient();
    const { lines, write } = collector();
    const bridge = createMcpBridge({ client, write });
    await bridge.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "search_conversations", arguments: { query: "q", session_key: "s" } },
    });
    expect(client.searchConversations).toHaveBeenCalledWith({
      query: "q",
      limit: undefined,
      sessionKey: "s",
    });
    expect(lines[0].result.isError).toBe(false);
    expect(JSON.parse(lines[0].result.content[0].text)).toEqual({
      results: [{ id: 1 }],
      total: 1,
    });
  });

  it("reports unknown tools and client failures as isError results", async () => {
    const failing = fakeClient({
      searchMemories: vi.fn().mockRejectedValue(new Error("gateway down")),
    });
    const { lines, write } = collector();
    const bridge = createMcpBridge({ client: failing, write });

    await bridge.handle({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "nope", arguments: {} },
    });
    expect(lines[0].result.isError).toBe(true);
    expect(lines[0].result.content[0].text).toContain("Unknown tool");

    await bridge.handle({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "search_memories", arguments: { query: "q" } },
    });
    expect(lines[1].result.isError).toBe(true);
    expect(lines[1].result.content[0].text).toContain("gateway down");
  });

  it("returns -32601 for unknown methods and ignores notifications", async () => {
    const { lines, write } = collector();
    const bridge = createMcpBridge({ client: fakeClient(), write });

    await bridge.handle({ jsonrpc: "2.0", id: 7, method: "bogus/method" });
    expect(lines[0].error).toEqual({ code: -32601, message: "Method not found" });

    await bridge.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
    await bridge.handle({ jsonrpc: "1.0", id: 8, method: "tools/list" });
    expect(lines).toHaveLength(1);
  });

  it("start() reads newline-delimited JSON-RPC from the input stream", async () => {
    const { Readable } = await import("node:stream");
    const input = new Readable({ read() {} });
    const { lines, write } = collector();
    const bridge = createMcpBridge({ client: fakeClient(), input: input as any, write });
    bridge.start();

    input.push('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\nnot-json\n');
    input.push(null);
    await new Promise((r) => setTimeout(r, 20));

    expect(lines).toHaveLength(1);
    expect(lines[0].id).toBe(1);
  });
});

/**
 * Tests for the MCP JSON-RPC dispatcher — protocol conformance for
 * initialize / tools/list / tools/call / notifications / error paths.
 */

import { describe, it, expect, vi } from "vitest";
import { McpDispatcher, RpcErr, SUPPORTED_PROTOCOL_VERSIONS } from "./protocol.js";
import { buildMemoryTools } from "../../sdk/tools.js";
import type { MemoryAdapter } from "../../sdk/memory-adapter.js";

function fakeAdapter(overrides: Partial<MemoryAdapter> = {}): MemoryAdapter {
  return {
    platform: "fake",
    health: vi.fn(async () => ({ ok: true, status: "ok", degraded: false })),
    recall: vi.fn(async () => ({ context: "ctx", memoryCount: 1 })),
    searchMemories: vi.fn(async () => ({ text: "mem-results", total: 2, strategy: "vector" })),
    searchConversations: vi.fn(async () => ({ text: "conv-results", total: 1 })),
    capture: vi.fn(async () => ({ l0Recorded: 2, schedulerNotified: true })),
    endSession: vi.fn(async () => {}),
    ...overrides,
  };
}

function makeDispatcher(adapter = fakeAdapter()) {
  return new McpDispatcher({
    tools: buildMemoryTools(adapter),
    serverInfo: { name: "tdai-memory", version: "0.1.0" },
    instructions: "test instructions",
  });
}

describe("McpDispatcher", () => {
  it("negotiates the requested protocol version on initialize", async () => {
    const d = makeDispatcher();
    const res = await d.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
    expect(res).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "tdai-memory", version: "0.1.0" },
        instructions: "test instructions",
      },
    });
  });

  it("falls back to the latest version when the requested one is unknown", async () => {
    const d = makeDispatcher();
    const res = await d.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    expect((res!.result as { protocolVersion: string }).protocolVersion).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
  });

  it("lists the memory tools with JSON Schema", async () => {
    const d = makeDispatcher();
    const res = await d.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (res!.result as { tools: Array<{ name: string; inputSchema: unknown }> }).tools;
    expect(tools.map((t) => t.name)).toContain("tdai_memory_search");
    expect(tools.every((t) => typeof t.inputSchema === "object")).toBe(true);
  });

  it("answers ping with an empty object", async () => {
    const d = makeDispatcher();
    const res = await d.handle({ jsonrpc: "2.0", id: 9, method: "ping" });
    expect(res).toEqual({ jsonrpc: "2.0", id: 9, result: {} });
  });

  it("invokes a tool and returns MCP content", async () => {
    const adapter = fakeAdapter();
    const d = makeDispatcher(adapter);
    const res = await d.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "tdai_memory_search", arguments: { query: "cats", limit: 3 } },
    });
    expect(res!.result).toEqual({
      content: [{ type: "text", text: "mem-results" }],
      isError: false,
    });
    expect(adapter.searchMemories).toHaveBeenCalledWith(expect.objectContaining({ query: "cats", limit: 3 }));
  });

  it("surfaces tool execution failures as isError result (not JSON-RPC error)", async () => {
    const adapter = fakeAdapter({
      searchMemories: vi.fn(async () => {
        throw new Error("gateway unreachable");
      }),
    });
    const d = makeDispatcher(adapter);
    const res = await d.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "tdai_memory_search", arguments: { query: "x" } },
    });
    expect(res!.error).toBeUndefined();
    expect(res!.result).toMatchObject({ isError: true });
    expect((res!.result as { content: Array<{ text: string }> }).content[0].text).toContain("gateway unreachable");
  });

  it("returns InvalidParams for an unknown tool name", async () => {
    const d = makeDispatcher();
    const res = await d.handle({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "does_not_exist", arguments: {} },
    });
    expect(res!.error).toMatchObject({ code: RpcErr.InvalidParams });
    expect(res!.error!.message).toContain("Unknown tool");
  });

  it("returns InvalidParams when tools/call omits a name", async () => {
    const d = makeDispatcher();
    const res = await d.handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: {} });
    expect(res!.error).toMatchObject({ code: RpcErr.InvalidParams });
  });

  it("returns MethodNotFound for unknown methods", async () => {
    const d = makeDispatcher();
    const res = await d.handle({ jsonrpc: "2.0", id: 7, method: "resources/list" });
    expect(res!.error).toMatchObject({ code: RpcErr.MethodNotFound });
  });

  it("does not answer notifications (no id)", async () => {
    const d = makeDispatcher();
    const res = await d.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res).toBeNull();
  });

  it("rejects a malformed envelope with InvalidRequest", async () => {
    const d = makeDispatcher();
    const res = await d.handle({ jsonrpc: "1.0", id: 8, method: "initialize" } as never);
    expect(res!.error).toMatchObject({ code: RpcErr.InvalidRequest });
  });
});

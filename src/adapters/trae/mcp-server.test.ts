// Task 3: Trae MCP server 测试 - TDD Step 1: 写失败测试
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TraeMcpServer, runStdioTraeMcp } from "./mcp-server.js";
import type { TdaiBridge } from "../tdai-bridge/tdai-bridge.js";

function fakeBridge(): TdaiBridge {
  return {
    recall: vi.fn().mockResolvedValue({ context: "C" }),
    capture: vi.fn().mockResolvedValue({ ok: true }),
    searchMemory: vi.fn().mockResolvedValue([{ id: 1 }]),
    searchConversation: vi.fn().mockResolvedValue([]),
    endSession: vi.fn().mockResolvedValue(undefined),
  } as unknown as TdaiBridge;
}

describe("TraeMcpServer tools/call", () => {
  it("tdai_recall calls bridge.recall", async () => {
    const s = new TraeMcpServer(fakeBridge());
    const out = await s.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "tdai_recall", arguments: { query: "q", session_key: "s" } },
    });
    expect(out?.result?.content?.[0]?.text).toContain("C");
  });

  it("tdai_capture calls bridge.capture", async () => {
    const s = new TraeMcpServer(fakeBridge());
    const out = await s.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "tdai_capture",
        arguments: { user_content: "u", assistant_content: "a", session_key: "s" },
      },
    });
    expect(out?.result?.content?.[0]?.text).toContain("true");
  });

  it("tdai_memory_search calls bridge.searchMemory", async () => {
    const s = new TraeMcpServer(fakeBridge());
    const out = await s.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "tdai_memory_search", arguments: { query: "q", limit: 5 } },
    });
    expect(out?.result?.content?.[0]?.text).toContain("1");
  });

  it("tdai_conversation_search calls bridge.searchConversation", async () => {
    const s = new TraeMcpServer(fakeBridge());
    const out = await s.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "tdai_conversation_search", arguments: { query: "q", limit: 10 } },
    });
    const result = JSON.parse(out?.result?.content?.[0]?.text || "[]");
    expect(result).toEqual([]);
  });

  it("tdai_session_end calls bridge.endSession", async () => {
    const s = new TraeMcpServer(fakeBridge());
    const out = await s.handle({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "tdai_session_end", arguments: { session_key: "s" } },
    });
    expect(out?.result?.content?.[0]?.text).toContain("true");
  });

  it("unknown tool → JSON-RPC -32601", async () => {
    const s = new TraeMcpServer(fakeBridge());
    const out = await s.handle({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "nope", arguments: {} },
    });
    expect(out?.error?.code).toBe(-32601);
  });
});

describe("TraeMcpServer initialize and tools/list", () => {
  it("initialize returns protocol version and capabilities", async () => {
    const s = new TraeMcpServer(fakeBridge());
    const out = await s.handle({
      jsonrpc: "2.0",
      id: 7,
      method: "initialize",
      params: {},
    });
    expect(out?.result?.protocolVersion).toBe("2025-11-25");
    expect(out?.result?.serverInfo?.name).toBe("tdai-trae");
  });

  it("tools/list returns 5 tools with closed inputSchema", async () => {
    const s = new TraeMcpServer(fakeBridge());
    const out = await s.handle({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/list",
      params: {},
    });
    const tools = out?.result?.tools;
    expect(tools).toHaveLength(5);
    expect(tools?.map((t: any) => t.name)).toEqual([
      "tdai_recall",
      "tdai_capture",
      "tdai_memory_search",
      "tdai_conversation_search",
      "tdai_session_end",
    ]);
    // 检查每个工具都有 inputSchema
    for (const tool of tools || []) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("unknown method → JSON-RPC -32601", async () => {
    const s = new TraeMcpServer(fakeBridge());
    const out = await s.handle({
      jsonrpc: "2.0",
      id: 9,
      method: "unknown_method",
      params: {},
    });
    expect(out?.error?.code).toBe(-32601);
  });

  it("closed schema: tdai_recall rejects extra fields → -32602", async () => {
    const s = new TraeMcpServer(fakeBridge());
    const out = await s.handle({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "tdai_recall",
        arguments: { query: "q", session_key: "s", extra_field: "x" },
      },
    });
    expect(out?.error?.code).toBe(-32602);
    expect(out?.error?.message).toContain("extra_field");
  });

  it("closed schema: tdai_capture rejects extra fields → -32602", async () => {
    const s = new TraeMcpServer(fakeBridge());
    const out = await s.handle({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "tdai_capture",
        arguments: {
          user_content: "u",
          assistant_content: "a",
          session_key: "s",
          malicious_field: "hack",
        },
      },
    });
    expect(out?.error?.code).toBe(-32602);
    expect(out?.error?.message).toContain("malicious_field");
  });
});

describe("TraeMcpServer stdio entry point", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  it("runStdioTraeMcp throws when TDAI_GATEWAY_URL is missing", async () => {
    delete process.env.TDAI_GATEWAY_URL;
    delete process.env.TDAI_GATEWAY_API_KEY;

    await expect(runStdioTraeMcp()).rejects.toThrow("missing env var: TDAI_GATEWAY_URL");
  });

  it("runStdioTraeMcp throws when TDAI_GATEWAY_API_KEY is missing", async () => {
    process.env.TDAI_GATEWAY_URL = "http://localhost:8080";
    delete process.env.TDAI_GATEWAY_API_KEY;

    await expect(runStdioTraeMcp()).rejects.toThrow("missing env var: TDAI_GATEWAY_API_KEY");
  });

  it("runStdioTraeMcp has correct export signature", async () => {
    // ponytail: 只验证函数存在性，不执行（需要真实 Gateway）
    expect(typeof runStdioTraeMcp).toBe("function");
    expect(runStdioTraeMcp.name).toBe("runStdioTraeMcp");
  });
});

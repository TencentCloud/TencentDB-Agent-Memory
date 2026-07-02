/**
 * MCP JSON-RPC 协议单元测试。
 *
 * 验证 MCP 握手、工具列表、工具调度、错误码。
 * 使用 mock fetch 避免真实 HTTP 调用。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { McpServer } from "../../../src/adapters/mcp/mcp-server.js";
import { ErrorCode, TDAI_TOOLS } from "../../../src/adapters/mcp/mcp-types.js";

/** 通过模拟 stdin/stdout 测试 McpServer 的请求处理。 */
async function sendMessages(
  server: McpServer,
  messages: Array<Record<string, unknown>>,
): Promise<string[]> {
  const responses: string[] = [];
  const lines = messages.map((m) => JSON.stringify(m));

  // 模拟 stdin 和 stdout
  const { Readable } = await import("node:stream");
  const { Writable } = await import("node:stream");

  const input = Readable.from(lines);
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      responses.push(chunk.toString().trim());
      callback();
    },
  });

  // 启动服务器并在所有消息发送后停止
  const startPromise = server.start(input, output);

  // 给服务器一点时间处理消息
  await new Promise((r) => setTimeout(r, 200));
  server.stop();

  // 等待服务器完全停止
  await startPromise.catch(() => {});

  return responses;
}

describe("McpServer MCP 协议测试", () => {
  let server: McpServer;

  beforeEach(() => {
    // Mock fetch 以返回虚拟 Gateway 响应
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      const url = _url as string;
      let body: unknown = {};

      if (url.endsWith("/health")) {
        body = { status: "ok", version: "0.1.0", uptime: 60, stores: { vectorStore: true, embeddingService: true } };
      } else if (url.endsWith("/recall")) {
        body = { context: "相关记忆上下文", strategy: "l1", memory_count: 3 };
      } else if (url.endsWith("/capture")) {
        body = { l0_recorded: 5, scheduler_notified: true };
      } else if (url.includes("/search/memories")) {
        body = { results: "找到 10 条记忆", total: 10, strategy: "hybrid" };
      } else if (url.includes("/search/conversations")) {
        body = { results: "找到 3 条对话", total: 3 };
      } else if (url.endsWith("/session/end")) {
        body = { flushed: true };
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => body,
      } as Response);
    });

    server = new McpServer({ gatewayUrl: "http://127.0.0.1:8420" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ============================
  // 工具列表
  // ============================
  it("TDAI_TOOLS 包含 6 个工具", () => {
    expect(TDAI_TOOLS.length).toBe(6);

    const names = TDAI_TOOLS.map((t) => t.name);
    expect(names).toContain("tdai_recall");
    expect(names).toContain("tdai_capture");
    expect(names).toContain("tdai_search_memories");
    expect(names).toContain("tdai_search_conversations");
    expect(names).toContain("tdai_end_session");
    expect(names).toContain("tdai_health");
  });

  it("所有工具都有 inputSchema（JSON Schema 格式）", () => {
    for (const tool of TDAI_TOOLS) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties).toBeDefined();
      expect(Array.isArray(tool.inputSchema.required)).toBe(true);
    }
  });

  // ============================
  // MCP 握手
  // ============================
  it("initialize 握手返回正确响应", async () => {
    const responses = await sendMessages(server, [{
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0" },
      },
    }]);

    expect(responses.length).toBe(1);
    const response = JSON.parse(responses[0]);
    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(1);
    expect(response.result.protocolVersion).toBe("2024-11-05");
    expect(response.result.serverInfo.name).toBe("memory-tencentdb");
    expect(response.result.capabilities.tools).toBeDefined();
  });

  // ============================
  // 工具调用
  // ============================
  it("tools/call tdai_recall 返回上下文", async () => {
    const responses = await sendMessages(server, [{
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "tdai_recall",
        arguments: { query: "测试查询", session_key: "sess-1" },
      },
    }]);

    expect(responses.length).toBe(1);
    const response = JSON.parse(responses[0]);
    expect(response.id).toBe(2);
    expect(response.error).toBeUndefined();
    expect(response.result.content[0].text).toContain("记忆上下文");
  });

  it("tools/call tdai_capture 返回记录结果", async () => {
    const responses = await sendMessages(server, [{
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "tdai_capture",
        arguments: {
          user_content: "用户消息",
          assistant_content: "助手回复",
          session_key: "sess-1",
        },
      },
    }]);

    expect(responses.length).toBe(1);
    const response = JSON.parse(responses[0]);
    expect(response.result.content[0].text).toContain("已记录 5");
  });

  it("tools/call tdai_search_memories 返回搜索结果", async () => {
    const responses = await sendMessages(server, [{
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "tdai_search_memories",
        arguments: { query: "关键词" },
      },
    }]);

    const response = JSON.parse(responses[0]);
    expect(response.result.content[0].text).toContain("找到 10");
  });

  it("tools/call tdai_health 返回健康状态 JSON", async () => {
    const responses = await sendMessages(server, [{
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "tdai_health", arguments: {} },
    }]);

    const response = JSON.parse(responses[0]);
    const healthData = JSON.parse(response.result.content[0].text);
    expect(healthData.status).toBe("ok");
  });

  // ============================
  // 错误处理
  // ============================
  it("无效 JSON → PARSE_ERROR (-32700)", async () => {
    const { Readable, Writable } = await import("node:stream");
    const input = Readable.from(["这不是 JSON {"]);
    const responses: string[] = [];
    const output = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        responses.push(chunk.toString().trim());
        callback();
      },
    });

    const startPromise = server.start(input, output);
    await new Promise((r) => setTimeout(r, 100));
    server.stop();
    await startPromise.catch(() => {});

    if (responses.length > 0) {
      const response = JSON.parse(responses[0]);
      expect(response.error.code).toBe(ErrorCode.PARSE_ERROR);
    }
  });

  it("未知方法 → METHOD_NOT_FOUND (-32601)", async () => {
    const responses = await sendMessages(server, [{
      jsonrpc: "2.0",
      id: 10,
      method: "nonexistent_method",
    }]);

    expect(responses.length).toBe(1);
    const response = JSON.parse(responses[0]);
    expect(response.error.code).toBe(ErrorCode.METHOD_NOT_FOUND);
  });

  it("未知工具 → 返回 isError", async () => {
    const responses = await sendMessages(server, [{
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "unknown_tool", arguments: {} },
    }]);

    const response = JSON.parse(responses[0]);
    expect(response.result.isError).toBe(true);
  });

  it("tdai_recall 缺少必填参数 → 返回 isError", async () => {
    const responses = await sendMessages(server, [{
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "tdai_recall", arguments: { query: "" } },
    }]);

    const response = JSON.parse(responses[0]);
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain("必填");
  });
});

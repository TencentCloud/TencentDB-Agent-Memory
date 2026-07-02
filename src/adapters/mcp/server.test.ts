import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { GatewayRequestError } from "./gateway-client.js";
import {
  createMcpServerFromEnvironment,
  runStdioMcpServer,
  TdaiMcpServer,
} from "./server.js";

function gateway() {
  return {
    recall: vi.fn().mockResolvedValue({ prepend_context: "dynamic", append_system_context: "stable" }),
    capture: vi.fn().mockResolvedValue({ l0_recorded: 2, scheduler_notified: true }),
    searchMemories: vi.fn().mockResolvedValue({ results: "memory", total: 1, strategy: "hybrid" }),
    searchConversations: vi.fn().mockResolvedValue({ results: "conversation", total: 1 }),
    endSession: vi.fn().mockResolvedValue({ flushed: true }),
  };
}

async function initialize(server: TdaiMcpServer, protocolVersion = "2025-11-25") {
  const response = await server.handle({
    jsonrpc: "2.0",
    id: "initialize",
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "vitest", version: "1.0.0" },
    },
  });
  await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
  return response;
}

describe("TdaiMcpServer", () => {
  it("negotiates initialize and advertises tool capabilities", async () => {
    const server = new TdaiMcpServer(gateway());
    const response = await initialize(server, "2025-03-26");
    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: "initialize",
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "memory-tencentdb" },
      },
    });
  });

  it("falls back to the current protocol for unsupported client versions", async () => {
    const server = new TdaiMcpServer(gateway());
    const response = await initialize(server, "1900-01-01");
    expect(response?.result).toMatchObject({ protocolVersion: "2025-11-25" });
  });

  it("publishes five tools with closed JSON schemas", async () => {
    const server = new TdaiMcpServer(gateway());
    await initialize(server);
    const response = await server.handle({ jsonrpc: "2.0", id: "tools", method: "tools/list" });
    const tools = (response?.result as { tools: Array<{ inputSchema: { additionalProperties: boolean } }> }).tools;
    expect(tools).toHaveLength(5);
    expect(tools.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(true);
  });

  it("validates and dispatches recall calls", async () => {
    const mock = gateway();
    const server = new TdaiMcpServer(mock);
    await initialize(server);
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "tdai_recall",
        arguments: { query: "current task", session_key: "project-a" },
      },
    });
    expect(mock.recall).toHaveBeenCalledWith({ query: "current task", session_key: "project-a" });
    expect(response?.result).toMatchObject({
      structuredContent: { prepend_context: "dynamic", append_system_context: "stable" },
    });
  });

  it("returns JSON-RPC invalid params errors before calling the gateway", async () => {
    const mock = gateway();
    const server = new TdaiMcpServer(mock);
    await initialize(server);
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "tdai_memory_search", arguments: { query: "q", limit: 500 } },
    });
    expect(response).toMatchObject({ error: { code: -32602 } });
    expect(mock.searchMemories).not.toHaveBeenCalled();

    const extraArgument = await server.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "tdai_recall", arguments: { query: "q", session_key: "s", hidden: true } },
    });
    expect(extraArgument).toMatchObject({ error: { code: -32602 } });
    expect(mock.recall).not.toHaveBeenCalled();
  });

  it.each([
    [
      "tdai_capture",
      { user_content: "question", assistant_content: "answer", session_key: "s", session_id: "run" },
      "capture",
      { user_content: "question", assistant_content: "answer", session_key: "s", session_id: "run" },
    ],
    [
      "tdai_memory_search",
      { query: "memory", limit: 10, type: "fact", scene: "work" },
      "searchMemories",
      { query: "memory", limit: 10, type: "fact", scene: "work" },
    ],
    [
      "tdai_conversation_search",
      { query: "source", session_key: "s" },
      "searchConversations",
      { query: "source", session_key: "s" },
    ],
    [
      "tdai_session_end",
      { session_key: "s" },
      "endSession",
      { session_key: "s" },
    ],
  ])("dispatches %s with validated arguments", async (name, args, method, expected) => {
    const mock = gateway();
    const server = new TdaiMcpServer(mock);
    await initialize(server);
    const response = await server.handle({
      jsonrpc: "2.0",
      id: name,
      method: "tools/call",
      params: { name, arguments: args },
    });
    expect(mock[method as keyof typeof mock]).toHaveBeenCalledWith(expected);
    expect(response?.result).not.toMatchObject({ isError: true });
  });

  it("converts gateway failures into MCP tool errors", async () => {
    const mock = gateway();
    mock.capture.mockRejectedValue(new GatewayRequestError("gateway unavailable"));
    const server = new TdaiMcpServer(mock);
    await initialize(server);
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "tdai_capture",
        arguments: {
          user_content: "question",
          assistant_content: "answer",
          session_key: "s",
        },
      },
    });
    expect(response?.result).toMatchObject({ isError: true });
  });

  it("does not respond to notifications and enters the operation phase", async () => {
    const server = new TdaiMcpServer(gateway());
    const response = await initialize(server);
    expect(response?.result).toMatchObject({ protocolVersion: "2025-11-25" });
    await expect(server.handle({ jsonrpc: "2.0", method: "notifications/unknown" }))
      .resolves.toBeUndefined();
    await expect(server.handle({ jsonrpc: "2.0", id: "tools", method: "tools/list" }))
      .resolves.toMatchObject({ result: { tools: expect.any(Array) } });
  });

  it("enforces initialization and rejects null request IDs", async () => {
    const server = new TdaiMcpServer(gateway());
    await expect(server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }))
      .resolves.toMatchObject({ error: { code: -32002 } });
    await expect(server.handle({ jsonrpc: "2.0", id: null, method: "ping" }))
      .resolves.toMatchObject({ error: { code: -32600 } });
    await expect(server.handle({ jsonrpc: "2.0", id: 1.5, method: "ping" }))
      .resolves.toMatchObject({ error: { code: -32600 } });
    await expect(server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    })).resolves.toMatchObject({ error: { code: -32602 } });
  });

  it("returns protocol errors for invalid requests, methods, and tools", async () => {
    const server = new TdaiMcpServer(gateway());
    await expect(server.handle(null)).resolves.toMatchObject({ error: { code: -32600 } });
    await initialize(server);
    await expect(server.handle({ jsonrpc: "2.0", id: 1, method: "missing" }))
      .resolves.toMatchObject({ error: { code: -32601 } });
    await expect(server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "missing", arguments: {} },
    })).resolves.toMatchObject({ error: { code: -32602 } });
    await expect(server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "tdai_recall", arguments: { query: "q" } },
    })).resolves.toMatchObject({ error: { code: -32602 } });
  });

  it("constructs a Gateway client from environment configuration", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ results: "ok", total: 1, strategy: "hybrid" }), { status: 200 }),
    );
    const server = createMcpServerFromEnvironment({
      TDAI_GATEWAY_URL: "http://memory.test:9000/base",
      TDAI_GATEWAY_API_KEY: "key",
      TDAI_GATEWAY_TIMEOUT_MS: "2500",
    }, { fetchImpl });
    await initialize(server);
    await server.handle({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "tdai_memory_search", arguments: { query: "q" } },
    });
    expect(String(fetchImpl.mock.calls[0][0])).toBe("http://memory.test:9000/base/search/memories");
  });

  it("rejects invalid environment timeout configuration", () => {
    expect(() => createMcpServerFromEnvironment({ TDAI_GATEWAY_TIMEOUT_MS: "zero" })).toThrow(
      "must be a positive integer",
    );
  });
});

describe("runStdioMcpServer", () => {
  it("emits one JSON-RPC frame per input line and recovers from parse errors", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk) => { text += chunk.toString(); });

    const running = runStdioMcpServer(new TdaiMcpServer(gateway()), input, output);
    input.end('not-json\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    await running;

    const frames = text.trim().split("\n").map((line) => JSON.parse(line));
    expect(frames).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { jsonrpc: "2.0", id: 1, result: {} },
    ]);
  });
});

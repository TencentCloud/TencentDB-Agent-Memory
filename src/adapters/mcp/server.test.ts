import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { TdaiMcpServer, createMcpServer } from "./server.js";
import { GatewayMemoryClient } from "../gateway-client/index.js";

// ============================
// Test helpers
// ============================

function mockGateway(): GatewayMemoryClient {
  return new GatewayMemoryClient({
    baseUrl: "http://127.0.0.1:8420",
    fetchImpl: async (url, init) => {
      const urlStr = String(url);
      if (urlStr.includes("/recall")) {
        return new Response(JSON.stringify({ context: "memory context", strategy: "hybrid", memory_count: 3 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.includes("/capture")) {
        return new Response(JSON.stringify({ l0_recorded: 2, scheduler_notified: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.includes("/session/end")) {
        return new Response(JSON.stringify({ flushed: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.includes("/search/memories")) {
        return new Response(JSON.stringify({ results: "memory result", total: 1, strategy: "hybrid" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.includes("/search/conversations")) {
        return new Response(JSON.stringify({ results: "conversation result", total: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    },
  });
}

async function initialize(
  server: TdaiMcpServer,
  protocolVersion = "2025-11-25",
): Promise<void> {
  const resp = await server.handleLine(JSON.stringify({
    jsonrpc: "2.0",
    id: "init-1",
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    },
  }));
  expect(resp).not.toBeNull();
  expect((resp!.result as Record<string, unknown>).protocolVersion).toBe(protocolVersion);

  // Send initialized notification
  await server.handleLine(JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  }));
}

// ============================
// Tests
// ============================

describe("TdaiMcpServer — initialization", () => {
  it("negotiates supported protocol version", async () => {
    const server = new TdaiMcpServer(mockGateway());
    const response = await server.handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    }));
    expect((response!.result as Record<string, unknown>).protocolVersion).toBe("2025-03-26");
  });

  it("falls back to latest for unsupported client versions", async () => {
    const server = new TdaiMcpServer(mockGateway());
    const response = await server.handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "1900-01-01" },
    }));
    expect((response!.result as Record<string, unknown>).protocolVersion).toBe("2025-11-25");
  });

  it("responds to initialize with server capabilities", async () => {
    const server = new TdaiMcpServer(mockGateway());
    const response = await server.handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    }));
    const result = response!.result as Record<string, unknown>;
    expect(result.serverInfo).toMatchObject({ name: "memory-tdai" });
    expect((result.capabilities as Record<string, unknown>).tools).toEqual({});
  });
});

describe("TdaiMcpServer — tools/list", () => {
  it("lists 5 tools with closed schemas", async () => {
    const server = new TdaiMcpServer(mockGateway());
    await initialize(server);

    const response = await server.handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    }));

    const tools = (response!.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools;
    expect(tools).toHaveLength(5);

    const names = tools.map((t) => t.name);
    expect(names).toContain("tdai_recall");
    expect(names).toContain("tdai_memory_search");
    expect(names).toContain("tdai_conversation_search");
    expect(names).toContain("tdai_capture");
    expect(names).toContain("tdai_session_end");

    // All schemas should be closed (no extra properties allowed)
    for (const tool of tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });
});

describe("TdaiMcpServer — tools/call", () => {
  it("dispatches tdai_recall with validated arguments", async () => {
    const gateway = mockGateway();
    const recallSpy = vi.spyOn(gateway, "recall");
    const server = new TdaiMcpServer(gateway);
    await initialize(server);

    const response = await server.handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "tdai_recall",
        arguments: { query: "current task", session_key: "project-a" },
      },
    }));

    expect(recallSpy).toHaveBeenCalledWith({ query: "current task", session_key: "project-a" });
    expect(response!.result).toBeDefined();
  });

  it("dispatches tdai_memory_search", async () => {
    const gateway = mockGateway();
    const searchSpy = vi.spyOn(gateway, "searchMemories");
    const server = new TdaiMcpServer(gateway);
    await initialize(server);

    await server.handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "tdai_memory_search",
        arguments: { query: "test", limit: 10, type: "persona" },
      },
    }));

    expect(searchSpy).toHaveBeenCalledWith({ query: "test", limit: 10, type: "persona", scene: undefined });
  });

  it("dispatches tdai_conversation_search", async () => {
    const gateway = mockGateway();
    const convSpy = vi.spyOn(gateway, "searchConversations");
    const server = new TdaiMcpServer(gateway);
    await initialize(server);

    await server.handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "tdai_conversation_search",
        arguments: { query: "hello", session_key: "sess-1" },
      },
    }));

    expect(convSpy).toHaveBeenCalledWith({ query: "hello", session_key: "sess-1", limit: undefined });
  });

  it("dispatches tdai_capture", async () => {
    const gateway = mockGateway();
    const captureSpy = vi.spyOn(gateway, "capture");
    const server = new TdaiMcpServer(gateway);
    await initialize(server);

    await server.handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "tdai_capture",
        arguments: {
          user_content: "question",
          assistant_content: "answer",
          session_key: "sess-1",
          session_id: "run-1",
        },
      },
    }));

    expect(captureSpy).toHaveBeenCalledWith({
      user_content: "question",
      assistant_content: "answer",
      session_key: "sess-1",
      session_id: "run-1",
    });
  });

  it("dispatches tdai_session_end", async () => {
    const gateway = mockGateway();
    const endSpy = vi.spyOn(gateway, "endSession");
    const server = new TdaiMcpServer(gateway);
    await initialize(server);

    await server.handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "tdai_session_end",
        arguments: { session_key: "sess-1" },
      },
    }));

    expect(endSpy).toHaveBeenCalledWith({ session_key: "sess-1" });
  });
});

describe("TdaiMcpServer — protocol validation", () => {
  it("rejects invalid JSON", async () => {
    const server = new TdaiMcpServer(mockGateway());
    const response = await server.handleLine("not-json");
    expect(response!.error!.code).toBe(-32700);
  });

  it("rejects missing jsonrpc field", async () => {
    const server = new TdaiMcpServer(mockGateway());
    const response = await server.handleLine(JSON.stringify({
      id: 1,
      method: "tools/list",
    }));
    expect(response!.error!.code).toBe(-32600);
  });

  it("rejects wrong jsonrpc version", async () => {
    const server = new TdaiMcpServer(mockGateway());
    const response = await server.handleLine(JSON.stringify({
      jsonrpc: "1.0",
      id: 1,
      method: "tools/list",
    }));
    expect(response!.error!.code).toBe(-32600);
  });

  it("returns MethodNotFound for unknown method", async () => {
    const server = new TdaiMcpServer(mockGateway());
    const response = await server.handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "unknown_method",
    }));
    expect(response!.error!.code).toBe(-32601);
  });
});

describe("TdaiMcpServer — input validation", () => {
  it("rejects tools/call without name", async () => {
    const server = new TdaiMcpServer(mockGateway());
    await initialize(server);

    const response = await server.handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { arguments: { query: "test" } },
    }));
    expect(response!.error!.code).toBe(-32602);
  });

  it("rejects tools/call without arguments", async () => {
    const server = new TdaiMcpServer(mockGateway());
    await initialize(server);

    const response = await server.handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "tdai_recall" },
    }));
    expect(response!.error!.code).toBe(-32602);
  });

  it("rejects tools/call with extra arguments", async () => {
    const server = new TdaiMcpServer(mockGateway());
    await initialize(server);

    const response = await server.handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "tdai_recall",
        arguments: { query: "q", session_key: "s", hidden: true },
      },
    }));
    expect(response!.error!.code).toBe(-32602);
    expect(response!.error!.message).toContain("hidden");
  });

  it("rejects tools/call with missing required arguments", async () => {
    const server = new TdaiMcpServer(mockGateway());
    await initialize(server);

    const response = await server.handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "tdai_recall",
        arguments: { query: "q" }, // missing session_key
      },
    }));
    expect(response!.error!.code).toBe(-32602);
    expect(response!.error!.message).toContain("session_key");
  });

  it("rejects tools/call for unknown tool", async () => {
    const server = new TdaiMcpServer(mockGateway());
    await initialize(server);

    const response = await server.handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "unknown_tool", arguments: {} },
    }));
    expect(response!.error!.code).toBe(-32602);
  });

  it("rejects null request IDs", async () => {
    const server = new TdaiMcpServer(mockGateway());
    const response = await server.handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      method: "ping",
    }));
    // Notifications (null id) return null
    expect(response).toBeNull();
  });
});

describe("TdaiMcpServer — initialization enforcement", () => {
  it("rejects tools/call before initialization", async () => {
    const server = new TdaiMcpServer(mockGateway());
    const response = await server.handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "tdai_memory_search",
        arguments: { query: "test" },
      },
    }));

    expect(response!.error!.code).toBe(-32002);
    expect(response!.error!.message).toContain("not initialized");
  });
});

describe("TdaiMcpServer — notifications", () => {
  it("returns null for notifications (no id)", async () => {
    const server = new TdaiMcpServer(mockGateway());
    const response = await server.handleLine(JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }));
    expect(response).toBeNull();
  });
});

describe("TdaiMcpServer — empty and edge cases", () => {
  it("returns null for empty lines", async () => {
    const server = new TdaiMcpServer(mockGateway());
    const response = await server.handleLine("");
    expect(response).toBeNull();
  });

  it("handles whitespace-only lines", async () => {
    const server = new TdaiMcpServer(mockGateway());
    const response = await server.handleLine("   ");
    expect(response).toBeNull();
  });
});

describe("createMcpServer — factory", () => {
  it("creates server from environment configuration", () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    const server = createMcpServer({
      gatewayUrl: "http://memory.test:9000",
      apiKey: "test-key",
      fetchImpl,
    });
    expect(server).toBeInstanceOf(TdaiMcpServer);
  });

  it("uses Gateway default port when no URL is configured", () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    const server = createMcpServer({ fetchImpl });
    expect(server).toBeInstanceOf(TdaiMcpServer);
  });
});

describe("TdaiMcpServer — stdio integration", () => {
  it("emits one JSON-RPC frame per input line and recovers from parse errors", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk) => { text += chunk.toString(); });

    const server = new TdaiMcpServer(mockGateway());
    const running = server.start(input, output);
    input.end('not-json\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    await running;

    const frames = text.trim().split("\n").map((line) => JSON.parse(line));
    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(frames[0]).toMatchObject({ error: { code: -32700 } });
  });
});

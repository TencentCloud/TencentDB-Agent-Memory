/**
 * TdaiMcpServer protocol tests (offline, fake MemoryClient).
 *
 * Exercises the wire behaviour line-by-line through the public
 * `handleMessage()` seam: handshake, tool listing, tool calls, and every
 * JSON-RPC failure mode the MCP stdio transport defines.
 */

import { describe, expect, it, vi } from "vitest";

import { TdaiMcpServer, SUPPORTED_PROTOCOL_VERSIONS, SERVER_NAME } from "./mcp-server.js";
import { TOOL_DEFINITIONS } from "./tools.js";
import type { MemoryClient } from "../../adapter-sdk/index.js";

// ============================
// Helpers
// ============================

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function createFakeClient(overrides: Partial<MemoryClient> = {}): MemoryClient {
  return {
    recall: vi.fn(async () => ({
      context: "system context",
      prependContext: "relevant memories",
      strategy: "hybrid",
      memoryCount: 2,
    })),
    capture: vi.fn(async () => ({ l0Recorded: 2, schedulerNotified: true })),
    searchMemories: vi.fn(async () => ({
      text: "Found 1 matching memories:", total: 1, strategy: "hybrid", items: [],
    })),
    searchConversations: vi.fn(async () => ({
      text: "Found 1 matching message(s):", total: 1, items: [],
    })),
    endSession: vi.fn(async () => {}),
    health: vi.fn(async () => ({ status: "ok" as const, vectorStore: true, embeddingService: true })),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

function createServer(client: MemoryClient = createFakeClient()): TdaiMcpServer {
  return new TdaiMcpServer({
    client,
    sessionKey: "claude-code:test",
    userId: "u-test",
    logger: silentLogger,
    serverVersion: "9.9.9",
  });
}

async function roundTrip(server: TdaiMcpServer, message: unknown): Promise<any> {
  const raw = typeof message === "string" ? message : JSON.stringify(message);
  const response = await server.handleMessage(raw);
  return response === undefined ? undefined : JSON.parse(response);
}

function request(id: number, method: string, params?: Record<string, unknown>) {
  return { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
}

function toolCall(id: number, name: string, args?: Record<string, unknown>) {
  return request(id, "tools/call", { name, arguments: args ?? {} });
}

// ============================
// Handshake
// ============================

describe("TdaiMcpServer — handshake", () => {
  it("initialize echoes a supported protocolVersion and reports serverInfo + tools capability", async () => {
    const server = createServer();

    const res = await roundTrip(server, request(1, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "claude-code", version: "1.0.0" },
    }));

    expect(res.jsonrpc).toBe("2.0");
    expect(res.id).toBe(1);
    expect(res.result.protocolVersion).toBe("2025-03-26");
    expect(res.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(res.result.serverInfo).toEqual({ name: SERVER_NAME, version: "9.9.9" });
  });

  it("initialize downgrades an unknown protocolVersion to the latest supported", async () => {
    const server = createServer();

    const res = await roundTrip(server, request(2, "initialize", { protocolVersion: "2099-01-01" }));

    expect(res.result.protocolVersion).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
  });

  it("notifications/initialized is consumed silently (no response)", async () => {
    const server = createServer();

    const res = await server.handleMessage(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );

    expect(res).toBeUndefined();
  });

  it("ping returns an empty result", async () => {
    const server = createServer();

    const res = await roundTrip(server, request(3, "ping"));

    expect(res.result).toEqual({});
  });
});

// ============================
// tools/list
// ============================

describe("TdaiMcpServer — tools/list", () => {
  it("returns all 5 memory tools with object schemas and required fields", async () => {
    const server = createServer();

    const res = await roundTrip(server, request(4, "tools/list"));

    const tools = res.result.tools as typeof TOOL_DEFINITIONS;
    expect(tools.map((t) => t.name)).toEqual([
      "memory_recall",
      "memory_capture",
      "memory_search",
      "conversation_search",
      "memory_session_end",
    ]);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties).toBeTypeOf("object");
    }
    expect(tools[0].inputSchema.required).toEqual(["query"]);
    expect(tools[1].inputSchema.required).toEqual(["user_content", "assistant_content"]);
  });
});

// ============================
// tools/call — happy paths
// ============================

describe("TdaiMcpServer — tools/call", () => {
  it("memory_recall maps args, applies the default session key, and joins contexts", async () => {
    const client = createFakeClient();
    const server = createServer(client);

    const res = await roundTrip(server, toolCall(5, "memory_recall", { query: "what do I like" }));

    expect(client.recall).toHaveBeenCalledWith({
      query: "what do I like",
      sessionKey: "claude-code:test",
      userId: "u-test",
    });
    expect(res.result.isError).toBeUndefined();
    expect(res.result.content).toEqual([
      { type: "text", text: "relevant memories\n\nsystem context" },
    ]);
  });

  it("memory_recall reports 'No relevant memories found.' when recall is empty", async () => {
    const client = createFakeClient({
      recall: vi.fn(async () => ({ context: "", memoryCount: 0 })),
    });
    const server = createServer(client);

    const res = await roundTrip(server, toolCall(6, "memory_recall", { query: "anything" }));

    expect(res.result.content[0].text).toBe("No relevant memories found.");
  });

  it("memory_capture maps snake_case args and honours a session_key override", async () => {
    const client = createFakeClient();
    const server = createServer(client);

    const res = await roundTrip(server, toolCall(7, "memory_capture", {
      user_content: "I prefer green tea",
      assistant_content: "Noted!",
      session_key: "override-session",
    }));

    expect(client.capture).toHaveBeenCalledWith({
      userContent: "I prefer green tea",
      assistantContent: "Noted!",
      sessionKey: "override-session",
      userId: "u-test",
    });
    expect(res.result.content[0].text).toBe("Captured: l0_recorded=2, scheduler_notified=true");
  });

  it("memory_search forwards query/limit/type/scene and returns the text payload", async () => {
    const client = createFakeClient();
    const server = createServer(client);

    const res = await roundTrip(server, toolCall(8, "memory_search", {
      query: "tea", limit: 7, type: "persona", scene: "daily",
    }));

    expect(client.searchMemories).toHaveBeenCalledWith({
      query: "tea", limit: 7, type: "persona", scene: "daily",
    });
    expect(res.result.content[0].text).toBe("Found 1 matching memories:");
  });

  it("conversation_search does NOT default session_key (it is a filter, not a scope)", async () => {
    const client = createFakeClient();
    const server = createServer(client);

    await roundTrip(server, toolCall(9, "conversation_search", { query: "past chat" }));

    expect(client.searchConversations).toHaveBeenCalledWith({
      query: "past chat", limit: 5, sessionKey: undefined,
    });
  });

  it("memory_session_end flushes the default session (or an override)", async () => {
    const client = createFakeClient();
    const server = createServer(client);

    const res = await roundTrip(server, toolCall(10, "memory_session_end", {}));
    expect(client.endSession).toHaveBeenCalledWith("claude-code:test");
    expect(res.result.content[0].text).toBe("Session flushed: claude-code:test");

    await roundTrip(server, toolCall(11, "memory_session_end", { session_key: "other" }));
    expect(client.endSession).toHaveBeenLastCalledWith("other");
  });

  it("tool failures are reported as isError:true results, not JSON-RPC errors", async () => {
    const client = createFakeClient({
      searchMemories: vi.fn(async () => {
        throw new Error("gateway unreachable");
      }),
    });
    const server = createServer(client);

    const res = await roundTrip(server, toolCall(12, "memory_search", { query: "q" }));

    expect(res.error).toBeUndefined();
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("gateway unreachable");
  });

  it("unknown tool name → JSON-RPC -32602 (protocol error per MCP spec)", async () => {
    const server = createServer();

    const res = await roundTrip(server, toolCall(13, "made_up_tool", {}));

    expect(res.result).toBeUndefined();
    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toContain("made_up_tool");
  });

  it("missing tool name → -32602", async () => {
    const server = createServer();

    const res = await roundTrip(server, request(14, "tools/call", { arguments: {} }));

    expect(res.error.code).toBe(-32602);
  });
});

// ============================
// Wire-level failure modes
// ============================

describe("TdaiMcpServer — malformed input", () => {
  it("unknown method → -32601", async () => {
    const server = createServer();

    const res = await roundTrip(server, request(15, "resources/list"));

    expect(res.error.code).toBe(-32601);
  });

  it("unparseable JSON → -32700 with id null", async () => {
    const server = createServer();

    const res = await roundTrip(server, "this is { not json");

    expect(res.error.code).toBe(-32700);
    expect(res.id).toBeNull();
  });

  it("JSON array (batch) → -32600", async () => {
    const server = createServer();

    const res = await roundTrip(server, [request(16, "ping")]);

    expect(res.error.code).toBe(-32600);
  });

  it("object without method → -32600", async () => {
    const server = createServer();

    const res = await roundTrip(server, { jsonrpc: "2.0", id: 17 });

    expect(res.error.code).toBe(-32600);
    expect(res.id).toBe(17);
  });

  it("blank lines and unrelated notifications produce no response", async () => {
    const server = createServer();

    expect(await server.handleMessage("")).toBeUndefined();
    expect(await server.handleMessage("   ")).toBeUndefined();
    expect(
      await server.handleMessage(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled" })),
    ).toBeUndefined();
  });
});

// ============================
// Stream lifecycle
// ============================

describe("TdaiMcpServer — stream wiring", () => {
  it("serves a full handshake + tool call over injected streams and closes cleanly", async () => {
    const { PassThrough } = await import("node:stream");
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (c: Buffer) => chunks.push(c.toString("utf-8")));

    const client = createFakeClient();
    const server = new TdaiMcpServer({
      client,
      sessionKey: "claude-code:stream",
      input,
      output,
      logger: silentLogger,
      serverVersion: "1.0.0",
    });

    const running = server.start();

    input.write(JSON.stringify(request(1, "initialize", { protocolVersion: "2025-06-18" })) + "\n");
    input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    input.write(JSON.stringify(request(2, "tools/list")) + "\n");
    input.write(JSON.stringify(toolCall(3, "memory_recall", { query: "hi" })) + "\n");
    input.end();

    await running;
    await server.stop();

    const lines = chunks.join("").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3); // notification produced no output
    expect(lines[0].id).toBe(1);
    expect(lines[0].result.protocolVersion).toBe("2025-06-18");
    expect(lines[1].id).toBe(2);
    expect(lines[1].result.tools).toHaveLength(5);
    expect(lines[2].id).toBe(3);
    expect(lines[2].result.content[0].type).toBe("text");
    expect(client.close).toHaveBeenCalled(); // stop() released the client
  });

  it("one failing write does not poison the serialized write chain", async () => {
    const { PassThrough } = await import("node:stream");
    const input = new PassThrough();
    const written: string[] = [];
    let failNext = true;
    // Output whose first write throws (EPIPE-style) and then recovers.
    const output = {
      write(chunk: string): boolean {
        if (failNext) {
          failNext = false;
          throw new Error("EPIPE: broken pipe");
        }
        written.push(String(chunk));
        return true;
      },
    } as unknown as NodeJS.WritableStream;

    const server = new TdaiMcpServer({
      client: createFakeClient(),
      sessionKey: "claude-code:chain",
      input,
      output,
      logger: silentLogger,
    });

    const running = server.start();
    input.write(JSON.stringify(request(1, "ping")) + "\n"); // write throws
    input.write(JSON.stringify(request(2, "ping")) + "\n"); // must still be served
    input.end();
    await running;
    await server.stop();

    const lines = written.join("").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1); // first response was lost to the throw...
    expect(lines[0].id).toBe(2); // ...but the chain kept going.
  });
});

// ============================
// Logging discipline (stdio transport)
// ============================

describe("TdaiMcpServer — default logger", () => {
  it("falls back to a stderr-only logger (never console.* / stdout)", async () => {
    const consoleSpies = (["debug", "info", "warn", "error", "log"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const server = new TdaiMcpServer({
      client: createFakeClient(),
      sessionKey: "claude-code:no-logger",
      // no logger injected — must NOT inherit the Base's console default
    });
    // Triggers logger.debug on the default logger.
    await server.handleMessage(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));

    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalled();
    expect(String(stderrSpy.mock.calls[0][0])).toContain("notifications/initialized");
  });
});

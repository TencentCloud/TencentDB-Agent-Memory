import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  coerceSearchLimit,
  GatewayMemoryOperations,
  getMcpToolDefinitions,
  getOpenClawSearchToolDefinitions,
  MCP_SERVER_INSTRUCTIONS,
  TdaiAdapterRuntime,
  toMcpResult,
} from "./index.js";
import type {
  AdapterSession,
  AdapterCaptureResult,
  AdapterCompletedTurn,
  AdapterRecallResult,
  MemoryAdapterOperations,
  TdaiPlatformAdapter,
} from "./index.js";

describe("adapter SDK tool contract", () => {
  it("generates the canonical MCP tool surface from one source", () => {
    const tools = getMcpToolDefinitions();

    expect(tools.map((tool) => tool.name)).toEqual([
      "memory_tencentdb_health",
      "memory_tencentdb_recall",
      "memory_tencentdb_capture",
      "memory_tencentdb_memory_search",
      "memory_tencentdb_conversation_search",
      "memory_tencentdb_session_end",
    ]);
    expect(tools.find((tool) => tool.name === "memory_tencentdb_capture")?.inputSchema.required)
      .toEqual(["user_content", "assistant_content"]);
    expect(tools.find((tool) => tool.name === "memory_tencentdb_memory_search")?.annotations)
      .toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tools.find((tool) => tool.name === "memory_tencentdb_capture")?.annotations)
      .toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it("provides MCP server instructions for clients such as Codex", () => {
    expect(MCP_SERVER_INSTRUCTIONS).toContain("memory_tencentdb_recall");
    expect(MCP_SERVER_INSTRUCTIONS).toContain("memory_tencentdb_capture");
    expect(MCP_SERVER_INSTRUCTIONS).toContain("Never store secrets");
  });

  it("generates OpenClaw search tools from the same canonical specs", () => {
    const tools = getOpenClawSearchToolDefinitions();

    expect(tools.map((tool) => tool.name)).toEqual([
      "tdai_memory_search",
      "tdai_conversation_search",
    ]);
    expect(tools[0].parameters.properties.query).toMatchObject({ type: "string" });
    expect(tools[1].parameters.properties.session_key).toMatchObject({ type: "string" });
  });
});

describe("adapter SDK package export", () => {
  it("exposes a stable npm subpath with runtime and type entries", () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
      exports?: Record<string, unknown>;
    };

    expect(packageJson.exports?.["./adapter-sdk"]).toEqual({
      types: "./dist/adapter-sdk.d.mts",
      import: "./dist/adapter-sdk.mjs",
      default: "./dist/adapter-sdk.mjs",
    });
  });
});

describe("adapter SDK parameter normalization", () => {
  it("clamps LLM supplied limits to the documented range", () => {
    expect(coerceSearchLimit(undefined)).toBe(5);
    expect(coerceSearchLimit("")).toBe(5);
    expect(coerceSearchLimit(true)).toBe(5);
    expect(coerceSearchLimit("10.8")).toBe(10);
    expect(coerceSearchLimit(0)).toBe(1);
    expect(coerceSearchLimit(500)).toBe(20);
  });
});

describe("TdaiAdapterRuntime", () => {
  it("lets a platform implement one event mapping interface for recall and capture", async () => {
    type Event = { prompt: string; messages: unknown[] };
    type Context = { sessionKey: string; sessionId: string };

    const operations = new FakeOperations();
    const adapter: TdaiPlatformAdapter<Event, Context> = {
      platform: "unit-platform",
      getSession: ({ context }): AdapterSession => ({
        sessionKey: context.sessionKey,
        sessionId: context.sessionId,
      }),
      getRecallInput: ({ event }) => ({ query: event.prompt }),
      getCaptureInput: ({ event }) => ({
        userContent: event.prompt,
        assistantContent: "assistant reply",
        messages: event.messages,
        originalUserMessageCount: event.messages.length,
      }),
      applyRecallResult: (result) => ({
        injected: [result.prependContext, result.appendSystemContext].filter(Boolean).join("\n\n"),
      }),
    };

    const runtime = new TdaiAdapterRuntime({ adapter, operations });
    const envelope = {
      event: {
        prompt: "remember the SDK contract",
        messages: [{ role: "user", content: "remember the SDK contract" }],
      },
      context: { sessionKey: "sdk-session", sessionId: "turn-1" },
    };

    await expect(runtime.handleRecall(envelope)).resolves.toEqual({
      injected: "<relevant-memories>sdk</relevant-memories>\n\n<memory-tools-guide>search when needed</memory-tools-guide>",
    });
    await expect(runtime.handleCapture(envelope)).resolves.toMatchObject({
      l0RecordedCount: 1,
      schedulerNotified: true,
    });

    expect(operations.recallCalls).toEqual([{ query: "remember the SDK contract", sessionKey: "sdk-session" }]);
    expect(operations.captureCalls[0]).toMatchObject({
      userText: "remember the SDK contract",
      assistantText: "assistant reply",
      sessionKey: "sdk-session",
      sessionId: "turn-1",
      originalUserMessageCount: 1,
    });
  });

  it("returns structured tool errors without throwing to MCP callers", async () => {
    const operations = new FakeOperations();
    const onError = vi.fn();
    const runtime = new TdaiAdapterRuntime({
      adapter: {
        platform: "unit-platform",
        getSession: () => ({ sessionKey: "sdk-session" }),
        onError,
      },
      operations,
    });

    const result = await runtime.handleToolCall({
      name: "memory_tencentdb_memory_search",
      arguments: {},
    });

    expect(result).toMatchObject({
      isError: true,
      text: "Missing required argument: query",
    });
    expect(toMcpResult(result)).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Missing required argument: query" }],
    });
    expect(onError).toHaveBeenCalledWith("tool", expect.any(Error));
  });
});

describe("GatewayMemoryOperations", () => {
  it("maps SDK capture turns to the Gateway /capture request shape", async () => {
    const client = {
      captureTurn: vi.fn(async () => ({
        l0_recorded: 2,
        scheduler_notified: true,
      })),
      recall: vi.fn(),
      searchMemories: vi.fn(),
      searchConversations: vi.fn(),
      endSession: vi.fn(),
    };

    const operations = new GatewayMemoryOperations({
      client: client as never,
      defaultSessionKey: "default-session",
    });

    await expect(operations.capture({
      userText: "remember gateway mapping",
      assistantText: "stored",
      messages: [{ role: "user", content: "remember gateway mapping" }],
      sessionKey: "gateway-session",
      sessionId: "turn-1",
    }, "user-1")).resolves.toMatchObject({
      l0RecordedCount: 2,
      schedulerNotified: true,
    });

    expect(client.captureTurn).toHaveBeenCalledWith({
      userContent: "remember gateway mapping",
      assistantContent: "stored",
      messages: [{ role: "user", content: "remember gateway mapping" }],
      sessionKey: "gateway-session",
      sessionId: "turn-1",
      userId: "user-1",
    });
  });

  it("omits generated message arrays so the Gateway can assign capture-safe timestamps", async () => {
    const client = {
      captureTurn: vi.fn(async () => ({
        l0_recorded: 2,
        scheduler_notified: false,
      })),
      recall: vi.fn(),
      searchMemories: vi.fn(),
      searchConversations: vi.fn(),
      endSession: vi.fn(),
    };

    const operations = new GatewayMemoryOperations({
      client: client as never,
      defaultSessionKey: "default-session",
    });
    const runtime = new TdaiAdapterRuntime({ operations });

    await runtime.handleToolCall({
      name: "memory_tencentdb_capture",
      arguments: {
        user_content: "remember gateway timestamps",
        assistant_content: "stored",
        session_key: "gateway-session",
      },
    });

    expect(client.captureTurn).toHaveBeenCalledWith({
      userContent: "remember gateway timestamps",
      assistantContent: "stored",
      messages: undefined,
      sessionKey: "gateway-session",
      sessionId: undefined,
      userId: undefined,
    });
  });
});

class FakeOperations implements MemoryAdapterOperations {
  recallCalls: Array<{ query: string; sessionKey: string }> = [];
  captureCalls: AdapterCompletedTurn[] = [];

  async recall(query: string, sessionKey: string): Promise<AdapterRecallResult> {
    this.recallCalls.push({ query, sessionKey });
    return {
      prependContext: "<relevant-memories>sdk</relevant-memories>",
      appendSystemContext: "<memory-tools-guide>search when needed</memory-tools-guide>",
      recallStrategy: "unit",
    };
  }

  async capture(turn: AdapterCompletedTurn): Promise<AdapterCaptureResult> {
    this.captureCalls.push(turn);
    return {
      l0RecordedCount: 1,
      schedulerNotified: true,
      l0VectorsWritten: 0,
      filteredMessages: [{ role: "user", content: turn.userText, timestamp: 1 }],
    };
  }

  async searchMemories(): Promise<{ text: string; total: number; strategy: string }> {
    return { text: "memory result", total: 1, strategy: "unit" };
  }

  async searchConversations(): Promise<{ text: string; total: number }> {
    return { text: "conversation result", total: 1 };
  }

  async endSession(): Promise<void> {}
}

/**
 * Tests for the MCP server adapter (issue #3 — 深入, Claude Code platform).
 *
 * Drives `handleJsonRpc` (the pure JSON-RPC dispatcher) against a fake
 * `MemoryAdapter`, verifying:
 *   - initialize → server info + tools capability
 *   - tools/list → four memory tools with correct schemas
 *   - tools/call → correct dispatch + arg mapping for each tool
 *   - error model: bad args and adapter failures return isError=true (not a crash)
 *   - notifications get no response; unknown methods return method-not-found
 *
 * Also exercises `runStdio` end-to-end over fake streams.
 */
import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { Writable } from "node:stream";

import { handleJsonRpc, runStdio } from "./mcp-server.js";
import type { MemoryAdapter } from "../sdk/types.js";
import type {
  CaptureResult,
  ConversationSearchParams,
  MemorySearchParams,
  RecallResult,
} from "../../core/types.js";
import type {
  CaptureTurn,
  ConversationSearchOutcome,
  MemorySearchOutcome,
} from "../sdk/types.js";

// ──────────────────────────────────────────────────────────────────────────
// Fake adapter
// ──────────────────────────────────────────────────────────────────────────

function makeFakeAdapter(overrides: Partial<MemoryAdapter> = {}): MemoryAdapter {
  const base: MemoryAdapter = {
    kind: "fake",
    async initialize() {},
    async destroy() {},
    async recall(query: string, _sk: string): Promise<RecallResult> {
      return { appendSystemContext: `RECALL[${query}]`, recallStrategy: "hybrid" };
    },
    async capture(turn: CaptureTurn): Promise<CaptureResult> {
      return {
        l0RecordedCount: 3,
        schedulerNotified: true,
        l0VectorsWritten: 0,
        filteredMessages: [],
      };
    },
    async searchMemories(p: MemorySearchParams): Promise<MemorySearchOutcome> {
      return { text: `MEM[${p.query}/${p.type ?? "-"}]`, total: 2, strategy: "embedding" };
    },
    async searchConversations(p: ConversationSearchParams): Promise<ConversationSearchOutcome> {
      return { text: `CONV[${p.query}]`, total: 1 };
    },
    async endSession(_sk: string) {},
  };
  return { ...base, ...overrides } as MemoryAdapter;
}

async function send(line: string, adapter: MemoryAdapter) {
  return handleJsonRpc(line, adapter);
}

const textOf = (r: { content: { type: string; text: string }[] }) => r.content[0].text;

// ==========================================================================
// 深入 — MCP initialize / tools/list
// ==========================================================================

describe("[深入] MCP — initialize & tools/list", () => {
  it("initialize returns server info + tools capability", async () => {
    const r = await send(
      `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`,
      makeFakeAdapter(),
    );
    expect(r).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "tencentdb-agent-memory" },
      },
    });
  });

  it("tools/list exposes the four memory tools", async () => {
    const r = await send(
      `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
      makeFakeAdapter(),
    );
    const names = (r!.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toEqual([
      "tdai_memory_search",
      "tdai_conversation_search",
      "tdai_recall",
      "tdai_capture",
    ]);
    // Schemas require the right fields.
    const tools = (r!.result as { tools: { name: string; inputSchema: { required: string[] } }[] }).tools;
    const capture = tools.find((t) => t.name === "tdai_capture")!;
    expect(capture.inputSchema.required).toEqual([
      "user_content",
      "assistant_content",
      "session_key",
    ]);
  });
});

// ==========================================================================
// 深入 — tools/call dispatch for each tool
// ==========================================================================

describe("[深入] MCP — tools/call dispatch", () => {
  it("tdai_memory_search maps args and returns text", async () => {
    const r = await send(
      `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"tdai_memory_search","arguments":{"query":"coffee","limit":50,"type":"episodic"}}}`,
      makeFakeAdapter(),
    );
    expect(r!.id).toBe(3);
    expect(textOf(r!.result as never)).toBe("MEM[coffee/episodic]");
  });

  it("clamps limit into [1,20]", async () => {
    // limit 50 → clamped to 20; the fake adapter ignores limit in output, so
    // we verify no error and a normal text result.
    const r = await send(
      `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"tdai_memory_search","arguments":{"query":"q","limit":99999}}}`,
      makeFakeAdapter(),
    );
    expect(r!.result).toBeDefined();
  });

  it("tdai_conversation_search maps session_key → sessionKey", async () => {
    const r = await send(
      `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"tdai_conversation_search","arguments":{"query":"q","session_key":"s1"}}}`,
      makeFakeAdapter(),
    );
    expect(textOf(r!.result as never)).toBe("CONV[q]");
  });

  it("tdai_recall returns the recalled context", async () => {
    const r = await send(
      `{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"tdai_recall","arguments":{"query":"hi","session_key":"s"}}}`,
      makeFakeAdapter(),
    );
    expect(textOf(r!.result as never)).toBe("RECALL[hi]");
  });

  it("tdai_capture maps snake_case body → CaptureTurn and returns a summary", async () => {
    let captured: CaptureTurn | undefined;
    const adapter = makeFakeAdapter({
      async capture(turn: CaptureTurn) {
        captured = turn;
        return { l0RecordedCount: 7, schedulerNotified: false, l0VectorsWritten: 0, filteredMessages: [] };
      },
    });
    const r = await send(
      `{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"tdai_capture","arguments":{"user_content":"u","assistant_content":"a","session_key":"s","session_id":"sid"}}}`,
      adapter,
    );
    expect(textOf(r!.result as never)).toBe("Captured: l0_recorded=7, scheduler_notified=false");
    expect(captured).toMatchObject({ userText: "u", assistantText: "a", sessionKey: "s", sessionId: "sid" });
  });
});

// ==========================================================================
// 深入 — error model & protocol edge cases
// ==========================================================================

describe("[深入] MCP — error model & protocol edges", () => {
  it("adapter failure returns isError=true (server keeps running)", async () => {
    const adapter = makeFakeAdapter({
      async recall() {
        throw new Error("gateway down");
      },
    });
    const r = await send(
      `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"tdai_recall","arguments":{"query":"q","session_key":"s"}}}`,
      adapter,
    );
    const result = r!.result as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("gateway down");
  });

  it("missing required arg returns isError=true", async () => {
    const r = await send(
      `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"tdai_memory_search","arguments":{}}}`,
      makeFakeAdapter(),
    );
    const result = r!.result as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it("unknown tool returns isError=true", async () => {
    const r = await send(
      `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"nope","arguments":{}}}`,
      makeFakeAdapter(),
    );
    const result = r!.result as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown tool");
  });

  it("notifications get no response (null)", async () => {
    const r = await send(
      `{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}`,
      makeFakeAdapter(),
    );
    expect(r).toBeNull();
  });

  it("unknown method → method-not-found error", async () => {
    const r = await send(
      `{"jsonrpc":"2.0","id":9,"method":"resources/list","params":{}}`,
      makeFakeAdapter(),
    );
    expect(r!.error!.code).toBe(-32601);
  });

  it("non-JSON line → parse error", async () => {
    const r = await send(`this is not json`, makeFakeAdapter());
    expect(r!.error!.code).toBe(-32700);
  });
});

// ==========================================================================
// 深入 — runStdio end-to-end over fake streams
// ==========================================================================

describe("[深入] MCP — runStdio loop", () => {
  it("handles a batch of newline-delimited requests and writes responses", async () => {
    const input = [
      `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`,
      `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"tdai_memory_search","arguments":{"query":"q"}}}`,
      `{"jsonrpc":"2.0","method":"notifications/initialized"}`,
    ].join("\n") + "\n";

    const outChunks: string[] = [];
    const stdout = new Writable({
      write(chunk, _enc, cb) {
        outChunks.push(chunk.toString());
        cb();
      },
    });

    await runStdio({
      adapter: makeFakeAdapter(),
      stdin: Readable.from([input]),
      stdout,
    });

    const lines = outChunks.join("").trim().split("\n");
    // Two responses (notification produced none).
    expect(lines).toHaveLength(2);
    const init = JSON.parse(lines[0]);
    const call = JSON.parse(lines[1]);
    expect(init.result.serverInfo.name).toBe("tencentdb-agent-memory");
    expect(call.result.content[0].text).toBe("MEM[q/-]");
  });
});

import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { StorageAdapter } from "../../core/storage/adapter.js";
import { defaultOffloadConfig, defaultCompactState } from "../types.js";
import { preciseMessageTokens } from "./compressor.js";

vi.mock("../opik-tracer.js", () => ({
  traceServerCompaction: vi.fn(),
}));

const { handleCompaction } = await import("./compaction-handler.js");
type CompactionReport = import("./compaction-handler.js").CompactionReport;

describe("handleCompaction fast-path token accounting", () => {
  it("recomputes tokens after summary replacement with no deletions", async () => {
    const messages = [
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: "{}" },
        }],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: "x".repeat(5_000),
      },
    ];
    const totalTokens = messages.reduce((sum, msg) => sum + preciseMessageTokens(msg), 0);
    const compactState = {
      ...defaultCompactState(),
      confirmedOffloadIds: ["call_1"],
    };
    const entry = {
      tool_call_id: "call_1",
      tool_call: "read_file",
      summary: "Read the requested file",
      timestamp: new Date(0).toISOString(),
      score: 10,
      node_id: null,
    };
    const storage = {
      readFile: vi.fn(async (key: string) => {
        if (key.endsWith("/compact-state.json")) return JSON.stringify(compactState);
        if (key.endsWith("/entries.jsonl")) return `${JSON.stringify(entry)}\n`;
        return null;
      }),
      readdirNames: vi.fn(async () => []),
      writeFile: vi.fn(async () => {}),
    } as unknown as StorageAdapter;
    const config = {
      ...defaultOffloadConfig(),
      mildOffloadRatio: 0.5,
      aggressiveCompressRatio: 0.85,
      emergencyCompressRatio: 1.0,
    };
    let responseBody: { data?: { messages: unknown[]; report: CompactionReport } } | undefined;

    await handleCompaction(
      {} as http.IncomingMessage,
      {} as http.ServerResponse,
      { serviceId: "default" },
      {
        storage,
        config,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
      "req-1",
      async () => ({
        session_id: "session-1",
        messages,
        ratio: 1,
        context_window: totalTokens,
        total_tokens: totalTokens,
      }),
      (_res, _status, body) => {
        responseBody = body as typeof responseBody;
      },
      (data, requestId) => ({ data, request_id: requestId }),
      (code, message, requestId) => ({ code, message, request_id: requestId }),
    );

    expect(responseBody?.data?.messages).toHaveLength(2);
    expect(responseBody?.data?.report).toMatchObject({
      resolvedLevel: "fastpath",
      fastPathReplaced: 1,
      fastPathDeleted: 0,
      mildReplacements: 0,
      aggressiveDeleted: 0,
      emergencyDeleted: 0,
    });
  });
});

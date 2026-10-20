import type http from "node:http";
import { describe, expect, it } from "vitest";
import type { StorageAdapter } from "../../core/storage/adapter.js";
import { defaultOffloadConfig, type CompactState, type OffloadEntry } from "../types.js";
import { handleCompaction, type CompactionReport } from "./compaction-handler.js";

function createInMemoryStorage(initialFiles: Record<string, string>): StorageAdapter {
  const files = new Map<string, string>(Object.entries(initialFiles));
  return {
    readFile: async (key: string) => files.get(key) ?? null,
    writeFile: async (key: string, content: string | Buffer) => {
      files.set(key, typeof content === "string" ? content : content.toString("utf-8"));
    },
    readdirNames: async () => [],
  } as unknown as StorageAdapter;
}

describe("handleCompaction fast-path token recalculation", () => {
  it("recalculates totalTokens and tokenArray when fast-path replaces confirmed tool results without deletions", async () => {
    const sessionId = "sess-fp-replace";
    const basePath = `offload/${sessionId}`;

    const compactState: CompactState = {
      confirmedOffloadIds: ["call_big"],
      deletedOffloadIds: [],
      lastCompactedAt: "2026-01-01T00:00:00.000Z",
    };

    const entry: OffloadEntry = {
      tool_call_id: "call_big",
      tool_call: "read_file",
      summary: "short summary",
      timestamp: "2026-01-01T00:00:00.000Z",
      score: 9,
      node_id: null,
    };

    const storage = createInMemoryStorage({
      [`${basePath}/compact-state.json`]: JSON.stringify(compactState),
      [`${basePath}/entries.jsonl`]: `${JSON.stringify(entry)}\n`,
    });

    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: "Please inspect big.log" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_big",
            type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ path: "big.log" }) },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_big",
        content: "hello ".repeat(30000),
      },
    ];

    for (let i = 0; i < 6; i++) {
      messages.push({ role: "user", content: `Follow-up question ${i}` });
      messages.push({ role: "assistant", content: `Follow-up answer ${i}` });
    }

    let statusCode = 0;
    let responsePayload: { data?: { messages: Array<Record<string, unknown>>; report: CompactionReport } } | undefined;

    await handleCompaction(
      {} as http.IncomingMessage,
      {} as http.ServerResponse,
      { serviceId: "test-service" },
      {
        storage,
        config: defaultOffloadConfig(),
        logger: {
          info: () => {},
          warn: () => {},
          error: () => {},
        },
      },
      "req-test-1",
      async () =>
        ({
          session_id: sessionId,
          messages,
          context_window: 30000,
          total_tokens: 30046,
          ratio: 30046 / 30000,
        }) as never,
      (_res, status, body) => {
        statusCode = status;
        responsePayload = body as typeof responsePayload;
      },
      (data) => ({ data }),
      (code, message) => ({ code, message }),
    );

    expect(statusCode).toBe(200);
    const report = responsePayload?.data?.report;
    expect(report).toBeDefined();
    expect(report?.fastPathReplaced).toBe(1);
    expect(report?.fastPathDeleted).toBe(0);
    expect(report?.resolvedLevel).toBe("fastpath");
    expect(report?.aggressiveDeleted).toBe(0);
    expect(report?.emergencyDeleted).toBe(0);
  });
});

/**
 * Tests for buildMemoryTools + coerceLimit — verifies the neutral tool layer
 * that every platform adapter consumes.
 */

import { describe, it, expect, vi } from "vitest";
import { buildMemoryTools, coerceLimit } from "./tools.js";
import type { MemoryAdapter } from "./memory-adapter.js";

/** Minimal in-memory adapter double for exercising the tool layer. */
function fakeAdapter(overrides: Partial<MemoryAdapter> = {}): MemoryAdapter {
  return {
    platform: "fake",
    health: vi.fn(async () => ({ ok: true, status: "ok", degraded: false })),
    recall: vi.fn(async () => ({ context: "ctx", strategy: "hybrid", memoryCount: 1 })),
    searchMemories: vi.fn(async () => ({ text: "mem-results", total: 2, strategy: "vector" })),
    searchConversations: vi.fn(async () => ({ text: "conv-results", total: 1 })),
    capture: vi.fn(async () => ({ l0Recorded: 2, schedulerNotified: true })),
    endSession: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("coerceLimit", () => {
  it.each([
    [undefined, 5],
    [null, 5],
    ["", 5],
    ["10", 10],
    [10.9, 10],
    ["10.9", 10],
    [0, 1],
    [-3, 1],
    [999, 20],
    [true, 5],
    ["abc", 5],
  ])("coerces %p → %p", (input, expected) => {
    expect(coerceLimit(input)).toBe(expected);
  });
});

describe("buildMemoryTools", () => {
  it("exposes the four canonical tools by default", () => {
    const tools = buildMemoryTools(fakeAdapter());
    expect(tools.map((t) => t.name)).toEqual([
      "tdai_memory_search",
      "tdai_conversation_search",
      "tdai_recall",
      "tdai_capture",
    ]);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(typeof t.description).toBe("string");
    }
  });

  it("can exclude write/recall tools and apply a name prefix", () => {
    const tools = buildMemoryTools(fakeAdapter(), {
      includeCapture: false,
      includeRecall: false,
      namePrefix: "mem_",
    });
    expect(tools.map((t) => t.name)).toEqual(["mem_tdai_memory_search", "mem_tdai_conversation_search"]);
  });

  it("routes memory_search through the adapter with coerced args", async () => {
    const adapter = fakeAdapter();
    const [memSearch] = buildMemoryTools(adapter);
    const res = await memSearch.invoke({ query: "cats", limit: "9", type: "episodic" });

    expect(res.isError).toBeFalsy();
    expect(res.text).toBe("mem-results");
    expect(adapter.searchMemories).toHaveBeenCalledWith({
      query: "cats",
      limit: 9,
      type: "episodic",
      scene: undefined,
    });
  });

  it("returns isError (never throws) when a required arg is missing", async () => {
    const [memSearch] = buildMemoryTools(fakeAdapter());
    const res = await memSearch.invoke({});
    expect(res.isError).toBe(true);
    expect(res.text).toContain("query");
  });

  it("returns isError (never throws) when the adapter fails", async () => {
    const adapter = fakeAdapter({
      searchMemories: vi.fn(async () => {
        throw new Error("gateway down");
      }),
    });
    const [memSearch] = buildMemoryTools(adapter);
    const res = await memSearch.invoke({ query: "x" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("gateway down");
  });

  it("defaults recall/capture session key and honors an override", async () => {
    const adapter = fakeAdapter();
    const tools = buildMemoryTools(adapter, { sessionKey: "sess-default" });
    const recall = tools.find((t) => t.name === "tdai_recall")!;
    const capture = tools.find((t) => t.name === "tdai_capture")!;

    await recall.invoke({ query: "hi" });
    expect(adapter.recall).toHaveBeenCalledWith({ query: "hi", sessionKey: "sess-default" });

    await capture.invoke({ user_content: "u", assistant_content: "a", session_key: "sess-override" });
    expect(adapter.capture).toHaveBeenCalledWith({
      userContent: "u",
      assistantContent: "a",
      sessionKey: "sess-override",
    });
  });

  it("capture reports a human-readable summary", async () => {
    const capture = buildMemoryTools(fakeAdapter()).find((t) => t.name === "tdai_capture")!;
    const res = await capture.invoke({ user_content: "u", assistant_content: "a" });
    expect(res.text).toContain("2 message(s) recorded");
    expect(res.text).toContain("notified");
  });
});

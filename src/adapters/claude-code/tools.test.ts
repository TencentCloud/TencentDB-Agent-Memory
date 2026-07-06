/**
 * MCP tool dispatch unit tests (offline, fake MemoryClient).
 */

import { describe, expect, it, vi } from "vitest";

import { clampLimit, dispatchToolCall, UnknownToolError, TOOL_DEFINITIONS } from "./tools.js";
import type { ToolDispatchContext } from "./tools.js";
import type { MemoryClient } from "../../adapter-sdk/index.js";

function createFakeClient(overrides: Partial<MemoryClient> = {}): MemoryClient {
  return {
    recall: vi.fn(async () => ({ context: "", memoryCount: 0 })),
    capture: vi.fn(async () => ({ l0Recorded: 1, schedulerNotified: false })),
    searchMemories: vi.fn(async () => ({ text: "mem", total: 0, strategy: "none", items: [] })),
    searchConversations: vi.fn(async () => ({ text: "conv", total: 0, items: [] })),
    endSession: vi.fn(async () => {}),
    health: vi.fn(async () => ({ status: "ok" as const, vectorStore: true, embeddingService: true })),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

function ctx(client: MemoryClient): ToolDispatchContext {
  return { client, defaultSessionKey: "default-session", userId: "u1" };
}

describe("clampLimit", () => {
  it("clamps to 1..20 with default 5 — identical to root index.ts tools", () => {
    expect(clampLimit(undefined)).toBe(5);
    expect(clampLimit(null)).toBe(5);
    expect(clampLimit("not-a-number")).toBe(5);
    expect(clampLimit(0)).toBe(5); // 0 is falsy → default, matching index.ts `|| 5`
    expect(clampLimit(-3)).toBe(1);
    expect(clampLimit(1)).toBe(1);
    expect(clampLimit(7)).toBe(7);
    expect(clampLimit(20)).toBe(20);
    expect(clampLimit(999)).toBe(20);
    expect(clampLimit("12")).toBe(12);
  });
});

describe("dispatchToolCall — session key defaulting", () => {
  it("memory_recall uses the default session key when none is given", async () => {
    const client = createFakeClient();

    await dispatchToolCall("memory_recall", { query: "q" }, ctx(client));

    expect(client.recall).toHaveBeenCalledWith({
      query: "q", sessionKey: "default-session", userId: "u1",
    });
  });

  it("session_key argument overrides the default", async () => {
    const client = createFakeClient();

    await dispatchToolCall("memory_recall", { query: "q", session_key: "s-override" }, ctx(client));

    expect(client.recall).toHaveBeenCalledWith({
      query: "q", sessionKey: "s-override", userId: "u1",
    });
  });

  it("a blank session_key argument falls back to the default", async () => {
    const client = createFakeClient();

    await dispatchToolCall("memory_session_end", { session_key: "   " }, ctx(client));

    expect(client.endSession).toHaveBeenCalledWith("default-session");
  });
});

describe("dispatchToolCall — argument mapping", () => {
  it("memory_search clamps limit and drops blank filters", async () => {
    const client = createFakeClient();

    await dispatchToolCall(
      "memory_search",
      { query: "q", limit: 999, type: "", scene: "  " },
      ctx(client),
    );

    expect(client.searchMemories).toHaveBeenCalledWith({
      query: "q", limit: 20, type: undefined, scene: undefined,
    });
  });

  it("conversation_search passes session_key as a filter only (no default)", async () => {
    const client = createFakeClient();

    await dispatchToolCall("conversation_search", { query: "q" }, ctx(client));
    expect(client.searchConversations).toHaveBeenCalledWith({
      query: "q", limit: 5, sessionKey: undefined,
    });

    await dispatchToolCall("conversation_search", { query: "q", session_key: "s9" }, ctx(client));
    expect(client.searchConversations).toHaveBeenLastCalledWith({
      query: "q", limit: 5, sessionKey: "s9",
    });
  });

  it("memory_capture formats the outcome summary", async () => {
    const client = createFakeClient();

    const text = await dispatchToolCall(
      "memory_capture",
      { user_content: "u", assistant_content: "a" },
      ctx(client),
    );

    expect(text).toBe("Captured: l0_recorded=1, scheduler_notified=false");
  });

  it("throws UnknownToolError for unregistered names", async () => {
    await expect(dispatchToolCall("nope", {}, ctx(createFakeClient()))).rejects.toBeInstanceOf(
      UnknownToolError,
    );
  });
});

describe("TOOL_DEFINITIONS", () => {
  it("every schema property referenced in required exists", () => {
    for (const tool of TOOL_DEFINITIONS) {
      for (const req of tool.inputSchema.required ?? []) {
        expect(tool.inputSchema.properties, `${tool.name}.${req}`).toHaveProperty(req);
      }
    }
  });

  it("memory_search type filter enumerates the three memory types", () => {
    const memorySearch = TOOL_DEFINITIONS.find((t) => t.name === "memory_search")!;
    const typeProp = memorySearch.inputSchema.properties.type as { enum: string[] };
    expect(typeProp.enum).toEqual(["persona", "episodic", "instruction"]);
  });
});

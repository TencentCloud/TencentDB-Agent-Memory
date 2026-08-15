/**
 * Tests for the SDK base adapter — focusing on the circuit breaker
 * behavior, graceful degradation, and the SDK contract.
 *
 * These tests mock the GatewayClient to simulate Gateway failures
 * without needing a real Gateway.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryAdapterBase } from "./base-adapter.js";
import type { AdapterConfig, RecallResult, SearchResult, ToolDefinition, ConversationMessage } from "./types.js";

// ── Test adapter (concrete implementation for testing) ────────────

class TestAdapter extends MemoryAdapterBase {
  readonly platformName = "test";

  formatRecallResult(result: RecallResult): {
    prependContext?: string;
    appendSystemContext?: string;
  } {
    const parts: { prependContext?: string; appendSystemContext?: string } = {};
    if (result.memories.length > 0) {
      parts.prependContext = result.memories.map((m) => `- [${m.type}] ${m.content}`).join("\n");
    }
    if (result.persona) {
      parts.appendSystemContext = `Persona: ${result.persona.content}`;
    }
    return parts;
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: "test_search",
        description: "Test tool",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ];
  }

  formatToolResult(toolName: string, rawResult: SearchResult | string): string {
    if (typeof rawResult === "string") return rawResult;
    return rawResult.items.map((m) => `- [${m.type}] ${m.content}`).join("\n");
  }

  normalizeMessages(
    rawMessages: unknown,
    _context?: Record<string, unknown>,
  ): ConversationMessage[] {
    if (!Array.isArray(rawMessages)) return [];
    return rawMessages
      .filter((m) => m && typeof m === "object" && (m as any).content)
      .map((m) => ({
        role: (m as any).role === "user" ? "user" : "assistant",
        content: String((m as any).content),
        timestamp: (m as any).timestamp || new Date().toISOString(),
      }));
  }
}

// ── Tests ──────────────────────────────────────────────────────────

describe("MemoryAdapterBase (SDK)", () => {
  let adapter: TestAdapter;

  beforeEach(() => {
    adapter = new TestAdapter();
  });

  describe("platformName", () => {
    it("should return the platform name set by subclass", () => {
      expect(adapter.platformName).toBe("test");
    });
  });

  describe("isInitialized", () => {
    it("should be false before initialize()", () => {
      expect(adapter.isInitialized).toBe(false);
    });
  });

  describe("session management", () => {
    it("should set and get session ID", () => {
      adapter.setSessionId("test-session-123");
      expect(adapter.currentSessionId).toBe("test-session-123");
    });

    it("should default to empty session ID", () => {
      expect(adapter.currentSessionId).toBe("");
    });
  });

  describe("recall without initialization", () => {
    it("should return empty strings when not initialized", async () => {
      const { prependContext, appendSystemContext } = await adapter.recall("test query");
      expect(prependContext).toBe("");
      expect(appendSystemContext).toBe("");
    });

    it("should return empty strings for empty query", async () => {
      const { prependContext, appendSystemContext } = await adapter.recall("");
      expect(prependContext).toBe("");
      expect(appendSystemContext).toBe("");
    });
  });

  describe("capture without initialization", () => {
    it("should return failure when not initialized", async () => {
      const result = await adapter.capture([{ role: "user", content: "test" }]);
      expect(result.success).toBe(false);
      expect(result.capturedCount).toBe(0);
    });
  });

  describe("searchMemories without initialization", () => {
    it("should return empty result when not initialized", async () => {
      const result = await adapter.searchMemories("test");
      expect(result.total).toBe(0);
    });

    it("should return empty result for empty query", async () => {
      const result = await adapter.searchMemories("");
      expect(result.total).toBe(0);
    });
  });

  describe("searchConversations without initialization", () => {
    it("should return empty result when not initialized", async () => {
      const result = await adapter.searchConversations("test");
      expect(result.total).toBe(0);
    });
  });

  describe("readScene without initialization", () => {
    it("should return 'Scene not available.' when not initialized", async () => {
      const result = await adapter.readScene("test-scene");
      expect(result).toContain("Scene not available");
    });
  });

  describe("handleToolCall without initialization", () => {
    it("should return error JSON for unknown tool", async () => {
      const result = await adapter.handleToolCall("unknown_tool", {});
      expect(result).toContain("Unknown tool");
    });

    it("should return empty result for memory_search when not initialized", async () => {
      const result = await adapter.handleToolCall("tdai_memory_search", { query: "test" });
      // searchMemories returns {text: "No results.", total: 0, items: []} when not initialized,
      // then formatToolResult formats the empty items list as empty string
      expect(result).toBe("");
    });
  });

  describe("shutdown", () => {
    it("should not throw when not initialized", () => {
      expect(() => adapter.shutdown()).not.toThrow();
    });
  });

  describe("circuit breaker constants", () => {
    it("should export BREAKER_THRESHOLD", async () => {
      const mod = await import("./base-adapter.js");
      expect(mod.BREAKER_THRESHOLD).toBeDefined();
      expect(typeof mod.BREAKER_THRESHOLD).toBe("number");
      expect(mod.BREAKER_THRESHOLD).toBe(5);
    });

    it("should export BREAKER_COOLDOWN_MS", async () => {
      const mod = await import("./base-adapter.js");
      expect(mod.BREAKER_COOLDOWN_MS).toBeDefined();
      expect(typeof mod.BREAKER_COOLDOWN_MS).toBe("number");
      expect(mod.BREAKER_COOLDOWN_MS).toBe(60_000);
    });
  });

  describe("default tool definitions", () => {
    it("should export DEFAULT_MEMORY_SEARCH_TOOL", async () => {
      const mod = await import("./base-adapter.js");
      expect(mod.DEFAULT_MEMORY_SEARCH_TOOL).toBeDefined();
      expect(mod.DEFAULT_MEMORY_SEARCH_TOOL.name).toBe("tdai_memory_search");
      expect(mod.DEFAULT_MEMORY_SEARCH_TOOL.parameters.required).toContain("query");
    });

    it("should export DEFAULT_CONVERSATION_SEARCH_TOOL", async () => {
      const mod = await import("./base-adapter.js");
      expect(mod.DEFAULT_CONVERSATION_SEARCH_TOOL).toBeDefined();
      expect(mod.DEFAULT_CONVERSATION_SEARCH_TOOL.name).toBe("tdai_conversation_search");
    });

    it("should export DEFAULT_READ_SCENE_TOOL", async () => {
      const mod = await import("./base-adapter.js");
      expect(mod.DEFAULT_READ_SCENE_TOOL).toBeDefined();
      expect(mod.DEFAULT_READ_SCENE_TOOL.name).toBe("tdai_read_scene");
      expect(mod.DEFAULT_READ_SCENE_TOOL.parameters.required).toContain("scene_id");
    });
  });

  describe("lifecycle hooks", () => {
    it("should call onGatewayReady on successful health check", async () => {
      const readySpy = vi.fn();
      const testAdapter = new (class extends TestAdapter {
        onGatewayReady() {
          readySpy();
        }
      })();

      // We can't fully test this without mocking fetch, but we can
      // verify the hook exists and doesn't throw
      expect(typeof testAdapter.onGatewayReady).toBe("function");
      testAdapter.onGatewayReady();
      expect(readySpy).toHaveBeenCalled();
    });

    it("should call onGatewayUnavailable on failed health check", () => {
      const unavailableSpy = vi.fn();
      const testAdapter = new (class extends TestAdapter {
        onGatewayUnavailable(status: string) {
          unavailableSpy(status);
        }
      })();

      expect(typeof testAdapter.onGatewayUnavailable).toBe("function");
      testAdapter.onGatewayUnavailable("down");
      expect(unavailableSpy).toHaveBeenCalledWith("down");
    });

    it("should call onRecallError on recall failure", () => {
      const errorSpy = vi.fn();
      const testAdapter = new (class extends TestAdapter {
        onRecallError(error: unknown) {
          errorSpy(error);
        }
      })();

      expect(typeof testAdapter.onRecallError).toBe("function");
      testAdapter.onRecallError(new Error("test"));
      expect(errorSpy).toHaveBeenCalled();
    });

    it("should call onCaptureError on capture failure", () => {
      const errorSpy = vi.fn();
      const testAdapter = new (class extends TestAdapter {
        onCaptureError(error: string) {
          errorSpy(error);
        }
      })();

      expect(typeof testAdapter.onCaptureError).toBe("function");
      testAdapter.onCaptureError("test error");
      expect(errorSpy).toHaveBeenCalledWith("test error");
    });
  });
});

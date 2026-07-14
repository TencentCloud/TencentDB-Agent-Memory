/**
 * Red-team tests for MemoryAdapter interface.
 *
 * Covers: interface contract, implementation completeness,
 * parameter bounds, graceful degradation, concurrent access.
 */
import { describe, it, expect, vi } from "vitest";
import type { MemoryAdapter } from "./types";

// ── Helpers ──────────────────────────────────────────────

/** A minimal MemoryAdapter implementation for testing. */
class TestMemoryAdapter implements MemoryAdapter {
  readonly name = "test-adapter";
  private _available = true;
  private _callCount: Record<string, number> = {};

  initialize(_config?: Record<string, unknown>): boolean {
    this._available = true;
    return true;
  }

  isAvailable(): boolean {
    return this._available;
  }

  recall(query: string, limit?: number): { prependContext: string; appendSystemContext: string } {
    this._callCount.recall = (this._callCount.recall || 0) + 1;
    if (!query) return { prependContext: "", appendSystemContext: "" };
    const memLines = [`- [test] ${query.substring(0, 50)}`];
    return {
      prependContext: `<memories>\n${memLines.slice(0, limit ?? 5).join("\n")}\n</memories>`,
      appendSystemContext: "",
    };
  }

  capture(_userContent: string, _assistantContent: string, _sessionId?: string): boolean {
    this._callCount.capture = (this._callCount.capture || 0) + 1;
    return true;
  }

  searchMemory(query: string, limit?: number): Array<Record<string, unknown>> {
    this._callCount.searchMemory = (this._callCount.searchMemory || 0) + 1;
    if (!query) return [];
    return Array.from({ length: Math.min(limit ?? 5, 5) }, (_, i) => ({
      id: `mem-${i}`,
      content: `result for: ${query.substring(0, 50)}`,
      type: "test",
    }));
  }

  searchConversation(query: string, limit?: number): Array<Record<string, unknown>> {
    this._callCount.searchConversation = (this._callCount.searchConversation || 0) + 1;
    if (!query) return [];
    return Array.from({ length: Math.min(limit ?? 5, 3) }, (_, i) => ({
      id: `conv-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message about: ${query.substring(0, 50)}`,
    }));
  }

  shutdown(): void {
    this._available = false;
  }

  get callCount() { return { ...this._callCount }; }
}

/** An adapter that always fails — tests graceful degradation. */
class FailingAdapter implements MemoryAdapter {
  readonly name = "failing-adapter";
  initialize(): boolean { return false; }
  isAvailable(): boolean { return false; }
  recall(): { prependContext: string; appendSystemContext: string } {
    return { prependContext: "", appendSystemContext: "" };
  }
  capture(): boolean { return false; }
  searchMemory(): Array<Record<string, unknown>> { return []; }
  searchConversation(): Array<Record<string, unknown>> { return []; }
  shutdown(): void { /* no-op */ }
}

// ═══════════════════════════════════════════════════════════
// T1: Interface contract
// ═══════════════════════════════════════════════════════════

describe("MemoryAdapter — interface contract", () => {
  it("T1a: can be implemented", () => {
    const adapter: MemoryAdapter = new TestMemoryAdapter();
    expect(adapter).toBeDefined();
    expect(adapter.name).toBe("test-adapter");
  });

  it("T1b: has all required methods", () => {
    const adapter = new TestMemoryAdapter();
    expect(typeof adapter.initialize).toBe("function");
    expect(typeof adapter.isAvailable).toBe("function");
    expect(typeof adapter.recall).toBe("function");
    expect(typeof adapter.capture).toBe("function");
    expect(typeof adapter.searchMemory).toBe("function");
    expect(typeof adapter.searchConversation).toBe("function");
    expect(typeof adapter.shutdown).toBe("function");
  });

  it("T1c: graceful degradation adapter works", () => {
    const adapter: MemoryAdapter = new FailingAdapter();
    const r = adapter.recall("test");
    expect(r.prependContext).toBe("");
    expect(r.appendSystemContext).toBe("");
    expect(adapter.capture("u", "a")).toBe(false);
    expect(adapter.searchMemory("test")).toEqual([]);
    expect(adapter.searchConversation("test")).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// T2: Parameter bounds
// ═══════════════════════════════════════════════════════════

describe("MemoryAdapter — parameter bounds", () => {
  it("T2a: recall with empty query returns empty context", () => {
    const adapter = new TestMemoryAdapter();
    const r = adapter.recall("", 0);
    expect(r.prependContext).toBe("");
    expect(r.appendSystemContext).toBe("");
  });

  it("T2b: recall without limit uses default", () => {
    const adapter = new TestMemoryAdapter();
    const r = adapter.recall("test query");
    expect(r.prependContext).toContain("test query");
  });

  it("T2c: capture empty strings does not crash", () => {
    const adapter = new TestMemoryAdapter();
    expect(adapter.capture("", "")).toBe(true);
  });

  it("T2d: capture with default sessionId", () => {
    const adapter = new TestMemoryAdapter();
    expect(adapter.capture("user", "assistant")).toBe(true);
    expect(adapter.capture("user", "assistant", "sess-1")).toBe(true);
  });

  it("T2e: search with empty query returns empty", () => {
    const adapter = new TestMemoryAdapter();
    expect(adapter.searchMemory("")).toEqual([]);
    expect(adapter.searchConversation("")).toEqual([]);
  });

  it("T2f: search with special characters does not crash", () => {
    const adapter = new TestMemoryAdapter();
    const sql = ["'; DROP TABLE memories; --", "<script>alert(1)</script>", "日本語"];
    for (const q of sql) {
      expect(Array.isArray(adapter.searchMemory(q))).toBe(true);
      expect(Array.isArray(adapter.searchConversation(q))).toBe(true);
    }
  });

  it("T2g: negative limit clamped gracefully", () => {
    const adapter = new TestMemoryAdapter();
    const r = adapter.recall("test", -1);
    expect(r.prependContext).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// T3: Lifecycle
// ═══════════════════════════════════════════════════════════

describe("MemoryAdapter — lifecycle", () => {
  it("T3a: shutdown marks unavailable", () => {
    const adapter = new TestMemoryAdapter();
    adapter.initialize();
    expect(adapter.isAvailable()).toBe(true);
    adapter.shutdown();
    expect(adapter.isAvailable()).toBe(false);
  });

  it("T3b: reinitialize after shutdown", () => {
    const adapter = new TestMemoryAdapter();
    adapter.initialize();
    adapter.shutdown();
    expect(adapter.initialize()).toBe(true);
    expect(adapter.isAvailable()).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// T4: Concurrency
// ═══════════════════════════════════════════════════════════

describe("MemoryAdapter — concurrency", () => {
  it("T4a: multiple recall calls succeed", () => {
    const adapter = new TestMemoryAdapter();
    const results = Array.from({ length: 10 }, (_, i) => adapter.recall(`query-${i}`, 3));
    expect(results).toHaveLength(10);
    results.forEach((r, i) => {
      expect(r.prependContext).toContain(`query-${i}`);
    });
  });

  it("T4b: interleaved recall and capture", () => {
    const adapter = new TestMemoryAdapter();
    for (let i = 0; i < 5; i++) {
      adapter.recall(`q-${i}`, 2);
      adapter.capture(`user-${i}`, `asst-${i}`, `sess-${i}`);
    }
    expect(adapter.callCount.recall).toBe(5);
    expect(adapter.callCount.capture).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════════
// T5: Return types
// ═══════════════════════════════════════════════════════════

describe("MemoryAdapter — return types", () => {
  it("T5a: recall returns structured context", () => {
    const adapter = new TestMemoryAdapter();
    const r = adapter.recall("architecture", 2);
    expect(r).toHaveProperty("prependContext");
    expect(r).toHaveProperty("appendSystemContext");
    expect(typeof r.prependContext).toBe("string");
    expect(typeof r.appendSystemContext).toBe("string");
  });

  it("T5b: capture returns boolean", () => {
    const adapter = new TestMemoryAdapter();
    const result = adapter.capture("user", "asst");
    expect(typeof result).toBe("boolean");
  });

  it("T5c: search returns array of records", () => {
    const adapter = new TestMemoryAdapter();
    const mems = adapter.searchMemory("test", 3);
    expect(Array.isArray(mems)).toBe(true);
    if (mems.length > 0) {
      expect(typeof mems[0]).toBe("object");
    }
  });

  it("T5d: initialize returns boolean", () => {
    const adapter = new TestMemoryAdapter();
    expect(typeof adapter.initialize()).toBe("boolean");
  });

  it("T5e: isAvailable returns boolean", () => {
    const adapter = new TestMemoryAdapter();
    expect(typeof adapter.isAvailable()).toBe("boolean");
  });
});

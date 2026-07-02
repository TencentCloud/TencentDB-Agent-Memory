/**
 * cache-diagnostics.test.ts — Unit tests for PrefixShape and CacheDiagnosticsTracker.
 */
import { describe, expect, it } from "vitest";
import {
  structuralHash,
  capturePrefixShape,
  comparePrefixShape,
  CacheDiagnosticsTracker,
} from "./cache-diagnostics.js";

describe("structuralHash", () => {
  it("same input produces same hash", () => {
    expect(structuralHash("hello")).toBe(structuralHash("hello"));
  });

  it("different inputs produce different hashes", () => {
    expect(structuralHash("hello")).not.toBe(structuralHash("world"));
  });

  it("handles empty string", () => {
    const h = structuralHash("");
    expect(typeof h).toBe("string");
    expect(h.length).toBeGreaterThan(0);
  });

  it("handles CJK characters", () => {
    const h1 = structuralHash("你好世界");
    const h2 = structuralHash("你好世界");
    expect(h1).toBe(h2);
  });

  it("is case-sensitive", () => {
    expect(structuralHash("Hello")).not.toBe(structuralHash("hello"));
  });
});

describe("capturePrefixShape", () => {
  it("captures hashes for all three sections", () => {
    const shape = capturePrefixShape({
      systemPrompt: "You are helpful.",
      toolSchemas: [{ name: "search" }],
      userPrefix: "",
    });
    expect(shape.systemHash).toBeTruthy();
    expect(shape.toolHash).toBeTruthy();
    expect(shape.userPrefixHash).toBeTruthy();
    expect(shape.capturedAt).toBeGreaterThan(0);
  });

  it("identical inputs produce identical hashes", () => {
    const params = {
      systemPrompt: "System",
      toolSchemas: [{ name: "t1" }],
      userPrefix: "",
    };
    const s1 = capturePrefixShape(params);
    const s2 = capturePrefixShape(params);
    expect(s1.systemHash).toBe(s2.systemHash);
    expect(s1.toolHash).toBe(s2.toolHash);
    expect(s1.userPrefixHash).toBe(s2.userPrefixHash);
  });

  it("different user prefix produces different userPrefixHash", () => {
    const s1 = capturePrefixShape({
      systemPrompt: "System",
      toolSchemas: [],
      userPrefix: "",
    });
    const s2 = capturePrefixShape({
      systemPrompt: "System",
      toolSchemas: [],
      userPrefix: "<relevant-memories>...content...</relevant-memories>",
    });
    expect(s1.userPrefixHash).not.toBe(s2.userPrefixHash);
    // But system and tool hashes should be the same
    expect(s1.systemHash).toBe(s2.systemHash);
    expect(s1.toolHash).toBe(s2.toolHash);
  });

  it("toolSchemas defaults to empty object when undefined", () => {
    const s1 = capturePrefixShape({
      systemPrompt: "System",
      toolSchemas: undefined,
      userPrefix: "",
    });
    const s2 = capturePrefixShape({
      systemPrompt: "System",
      toolSchemas: {},
      userPrefix: "",
    });
    expect(s1.toolHash).toBe(s2.toolHash); // both JSON.stringify to "{}"
  });
});

describe("comparePrefixShape", () => {
  it("detects stable prefix (no changes)", () => {
    const shape = capturePrefixShape({
      systemPrompt: "You are helpful.",
      toolSchemas: [],
      userPrefix: "",
    });
    const diag = comparePrefixShape(shape, { ...shape, capturedAt: Date.now() });
    expect(diag.prefixStable).toBe(true);
    expect(diag.changedSections).toHaveLength(0);
  });

  it("detects systemPrompt change", () => {
    const s1 = capturePrefixShape({ systemPrompt: "System v1", toolSchemas: [], userPrefix: "" });
    const s2 = capturePrefixShape({ systemPrompt: "System v2", toolSchemas: [], userPrefix: "" });
    const diag = comparePrefixShape(s1, s2);
    expect(diag.prefixStable).toBe(false);
    expect(diag.changedSections).toContain("systemPrompt");
  });

  it("detects toolSchemas change", () => {
    const s1 = capturePrefixShape({ systemPrompt: "S", toolSchemas: [{ name: "a" }], userPrefix: "" });
    const s2 = capturePrefixShape({ systemPrompt: "S", toolSchemas: [{ name: "b" }], userPrefix: "" });
    const diag = comparePrefixShape(s1, s2);
    expect(diag.prefixStable).toBe(false);
    expect(diag.changedSections).toContain("toolSchemas");
  });

  it("detects userPrefix change", () => {
    const s1 = capturePrefixShape({ systemPrompt: "S", toolSchemas: [], userPrefix: "" });
    const s2 = capturePrefixShape({ systemPrompt: "S", toolSchemas: [], userPrefix: "<recall>" });
    const diag = comparePrefixShape(s1, s2);
    expect(diag.prefixStable).toBe(false);
    expect(diag.changedSections).toContain("userPrefix");
  });

  it("detects multiple simultaneous changes", () => {
    const s1 = capturePrefixShape({ systemPrompt: "S1", toolSchemas: [{ name: "a" }], userPrefix: "" });
    const s2 = capturePrefixShape({ systemPrompt: "S2", toolSchemas: [{ name: "b" }], userPrefix: "P" });
    const diag = comparePrefixShape(s1, s2);
    expect(diag.prefixStable).toBe(false);
    expect(diag.changedSections.length).toBeGreaterThanOrEqual(3);
  });
});

describe("CacheDiagnosticsTracker", () => {
  it("first turn only captures shape (no diagnosis)", () => {
    const tracker = new CacheDiagnosticsTracker();
    const diag = tracker.recordTurn({
      systemPrompt: "System",
      toolSchemas: [],
      userPrefix: "",
    });
    expect(diag).toBeUndefined();
    expect(tracker.getHitRate()).toBe(0);
  });

  it("second turn with same prefix = cache hit", () => {
    const tracker = new CacheDiagnosticsTracker();
    const params = { systemPrompt: "System", toolSchemas: [], userPrefix: "" };
    tracker.recordTurn(params);
    const diag = tracker.recordTurn(params);
    expect(diag).toBeDefined();
    expect(diag!.prefixStable).toBe(true);
    expect(tracker.getHitRate()).toBe(1.0);
  });

  it("second turn with different prefix = cache miss", () => {
    const tracker = new CacheDiagnosticsTracker();
    tracker.recordTurn({ systemPrompt: "System", toolSchemas: [], userPrefix: "" });
    const diag = tracker.recordTurn({
      systemPrompt: "System",
      toolSchemas: [],
      userPrefix: "<relevant-memories>...new recall...</relevant-memories>",
    });
    expect(diag).toBeDefined();
    expect(diag!.prefixStable).toBe(false);
    expect(diag!.changedSections).toContain("userPrefix");
    expect(tracker.getHitRate()).toBe(0.0);
  });

  it("tracks correct hit rate over multiple turns", () => {
    const tracker = new CacheDiagnosticsTracker();
    const stableParams = { systemPrompt: "System", toolSchemas: [], userPrefix: "" };
    const changedParams = {
      systemPrompt: "System",
      toolSchemas: [],
      userPrefix: "<recall>A</recall>",
    };

    // Turn 1: initial capture
    tracker.recordTurn(stableParams);
    // Turn 2: stable → HIT
    tracker.recordTurn(stableParams);
    // Turn 3: different (from turn 2) → MISS
    tracker.recordTurn(changedParams);
    // Turn 4: stable (same as turn 3) → HIT
    tracker.recordTurn(changedParams);
    // Turn 5: stable → HIT
    tracker.recordTurn(changedParams);

    // 4 comparisons: HIT(2→1), MISS(3→2), HIT(4→3), HIT(5→4) = 3/4 = 75%
    expect(tracker.getHitRate()).toBe(0.75);
  });

  it("reset clears all state", () => {
    const tracker = new CacheDiagnosticsTracker();
    tracker.recordTurn({ systemPrompt: "S", toolSchemas: [], userPrefix: "" });
    tracker.recordTurn({ systemPrompt: "S", toolSchemas: [], userPrefix: "" });
    expect(tracker.getHitRate()).toBe(1.0);

    tracker.reset();
    expect(tracker.getHitRate()).toBe(0);

    // After reset, first turn again has no diagnosis
    const diag = tracker.recordTurn({ systemPrompt: "S", toolSchemas: [], userPrefix: "" });
    expect(diag).toBeUndefined();
  });
});

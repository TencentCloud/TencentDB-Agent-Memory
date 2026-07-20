/**
 * Tests for Prefix Stability Monitor.
 *
 * Verifies prefix snapshot capture, drift detection,
 * history tracking, and summary reporting.
 */
import { describe, expect, it } from "vitest";
import {
  capturePrefixSnapshot,
  detectDrift,
  createStabilityHistory,
  updateHistory,
  summarizeHistory,
} from "./prefix-stability.js";
import { DEFAULT_CACHE_BOUNDARY } from "./cache-boundary.js";

// ── Test fixtures ──

function makePrompt(prefix: string, dynamic: string): string {
  return `${prefix}${DEFAULT_CACHE_BOUNDARY}${dynamic}`;
}

describe("capturePrefixSnapshot", () => {
  it("captures prefix hash and metadata from a system prompt", () => {
    const prompt = makePrompt("stable-prefix", "dynamic-content");
    const snap = capturePrefixSnapshot("turn-1", prompt);

    expect(snap.turnId).toBe("turn-1");
    expect(snap.prefixLength).toBe("stable-prefix".length);
    expect(snap.boundaryIndex).toBe("stable-prefix".length);
    expect(snap.prefixHash).toBeTruthy();
    expect(snap.prefixHash).toHaveLength(8); // 32-bit hex
    expect(snap.capturedAt).toBeGreaterThan(0);
  });

  it("produces identical hash for identical prefixes", () => {
    const s1 = capturePrefixSnapshot("t1", makePrompt("ABC", "dyn"));
    const s2 = capturePrefixSnapshot("t2", makePrompt("ABC", "different"));
    expect(s1.prefixHash).toBe(s2.prefixHash);
  });

  it("produces different hash for different prefixes", () => {
    const s1 = capturePrefixSnapshot("t1", makePrompt("ABC", "dyn"));
    const s2 = capturePrefixSnapshot("t2", makePrompt("DEF", "dyn"));
    expect(s1.prefixHash).not.toBe(s2.prefixHash);
  });
});

describe("detectDrift", () => {
  it("reports no drift for identical snapshots", () => {
    const s1 = capturePrefixSnapshot("t1", makePrompt("stable", "dynamic"));
    const s2 = capturePrefixSnapshot("t2", makePrompt("stable", "dynamic"));
    const report = detectDrift(s1, s2);

    expect(report.drifted).toBe(false);
    expect(report.driftSeverity).toBe("none");
    expect(report.lengthDelta).toBe(0);
    expect(report.boundaryShift).toBe(0);
  });

  it("detects drift when prefix content changes", () => {
    const s1 = capturePrefixSnapshot("t1", makePrompt("old-prefix", "dynamic"));
    const s2 = capturePrefixSnapshot("t2", makePrompt("new-prefix", "dynamic"));
    const report = detectDrift(s1, s2);

    expect(report.drifted).toBe(true);
    expect(report.driftSeverity).toBe("minor"); // same length, just content change
  });

  it("classifies large boundary shift as significant", () => {
    const largePrefix = "X".repeat(200);
    const smallPrefix = "Y";
    const s1 = capturePrefixSnapshot("t1", makePrompt(largePrefix, "dyn"));
    const s2 = capturePrefixSnapshot("t2", makePrompt(smallPrefix, "dyn"));
    const report = detectDrift(s1, s2);

    expect(report.drifted).toBe(true);
    expect(report.driftSeverity).toBe("significant");
    expect(report.lengthDelta).toBe(smallPrefix.length - largePrefix.length);
    expect(report.boundaryShift).toBe(smallPrefix.length - largePrefix.length);
  });

  it("detects drift when boundary position shifts even if prefix content same length", () => {
    // Impossible in practice with CACHE_BOUNDARY since the marker itself
    // is part of position, but exercises the boundaryShift logic.
    const s1 = capturePrefixSnapshot("t1", makePrompt("AAAA", "dyn"));
    const s2 = capturePrefixSnapshot("t2", makePrompt("BBBB", "dyn"));
    const report = detectDrift(s1, s2);

    expect(report.drifted).toBe(true);
  });
});

describe("createStabilityHistory + updateHistory", () => {
  it("tracks first snapshot without drift report", () => {
    const history = createStabilityHistory();
    const snap = capturePrefixSnapshot("t1", makePrompt("ABC", "dyn"));
    const drift = updateHistory(history, snap);

    expect(drift).toBeUndefined();
    expect(history.totalTurns).toBe(1);
    expect(history.driftCount).toBe(0);
  });

  it("detects drift on second snapshot when prefix changed", () => {
    const history = createStabilityHistory();
    updateHistory(history, capturePrefixSnapshot("t1", makePrompt("stable", "dyn")));
    const drift = updateHistory(history, capturePrefixSnapshot("t2", makePrompt("CHANGED", "dyn")));

    expect(drift).toBeDefined();
    expect(drift!.drifted).toBe(true);
    expect(history.totalTurns).toBe(2);
    expect(history.driftCount).toBe(1);
  });

  it("does not count drift when prefix is identical", () => {
    const history = createStabilityHistory();
    updateHistory(history, capturePrefixSnapshot("t1", makePrompt("SAME", "dyn1")));
    updateHistory(history, capturePrefixSnapshot("t2", makePrompt("SAME", "dyn2")));
    updateHistory(history, capturePrefixSnapshot("t3", makePrompt("SAME", "dyn3")));

    expect(history.totalTurns).toBe(3);
    expect(history.driftCount).toBe(0);
  });

  it("counts multiple drifts across turns", () => {
    const history = createStabilityHistory();
    updateHistory(history, capturePrefixSnapshot("t1", makePrompt("A", "dyn")));
    updateHistory(history, capturePrefixSnapshot("t2", makePrompt("B", "dyn")));
    updateHistory(history, capturePrefixSnapshot("t3", makePrompt("C", "dyn")));

    expect(history.totalTurns).toBe(3);
    expect(history.driftCount).toBe(2); // A→B and B→C
  });
});

describe("summarizeHistory", () => {
  it("generates summary with stability metrics", () => {
    const history = createStabilityHistory();
    updateHistory(history, capturePrefixSnapshot("t1", makePrompt("A", "dyn")));
    updateHistory(history, capturePrefixSnapshot("t2", makePrompt("A", "dyn")));
    updateHistory(history, capturePrefixSnapshot("t3", makePrompt("B", "dyn")));

    const summary = summarizeHistory(history);

    expect(summary).toContain("Tracked 3 turns");
    expect(summary).toContain("Drifts detected: 1");
    expect(summary).toContain("Net prefix change detected"); // first ≠ last
  });

  it("reports stable when first and last match", () => {
    const history = createStabilityHistory();
    updateHistory(history, capturePrefixSnapshot("t1", makePrompt("S", "dyn")));
    updateHistory(history, capturePrefixSnapshot("t2", makePrompt("S", "dyn")));

    const summary = summarizeHistory(history);

    expect(summary).toContain("Prefix stable");
    expect(history.driftCount).toBe(0);
  });
});

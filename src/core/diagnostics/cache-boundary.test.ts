/**
 * Tests for Cache Boundary Auditor.
 *
 * Verifies CACHE_BOUNDARY position detection, content segmentation,
 * cacheable ratio computation, and prefix leak detection.
 */
import { describe, expect, it } from "vitest";
import {
  auditCacheBoundary,
  formatAuditSummary,
  hasCacheBoundary,
  detectPrefixLeaks,
  DEFAULT_CACHE_BOUNDARY,
} from "./cache-boundary.js";

// ── Test fixtures ──

function makeSystemPrompt(prefix: string, dynamic: string): string {
  return `${prefix}${DEFAULT_CACHE_BOUNDARY}${dynamic}`;
}

const STABLE_PERSONA = "You are a helpful assistant.";
const BASE_SYSTEM = "You have access to memory tools.";
const DYNAMIC_CONTENT = "Turn-specific instructions here.";

describe("auditCacheBoundary — boundary position", () => {
  it("finds CACHE_BOUNDARY at the expected position", () => {
    const prompt = makeSystemPrompt(STABLE_PERSONA, BASE_SYSTEM);
    const audit = auditCacheBoundary(prompt);

    expect(audit.boundaryFound).toBe(true);
    expect(audit.boundaryIndex).toBe(STABLE_PERSONA.length);
    expect(audit.prefixContent).toBe(STABLE_PERSONA);
    expect(audit.postBoundaryContent).toBe(BASE_SYSTEM);
  });

  it("returns boundaryFound=false when marker is absent", () => {
    const prompt = "Just a plain prompt with no boundary.";
    const audit = auditCacheBoundary(prompt);

    expect(audit.boundaryFound).toBe(false);
    expect(audit.boundaryIndex).toBe(-1);
    expect(audit.cacheableRatio).toBe(0);
    // Post-boundary = entire prompt when no boundary exists
    expect(audit.postBoundaryContent).toBe(prompt);
  });

  it("supports custom boundary markers", () => {
    const custom = "[[CACHE_END]]";
    const prompt = `prefix${custom}suffix`;
    const audit = auditCacheBoundary(prompt, custom);

    expect(audit.boundaryFound).toBe(true);
    expect(audit.prefixContent).toBe("prefix");
    expect(audit.postBoundaryContent).toBe("suffix");
  });

  it("computes cacheable ratio correctly", () => {
    // 100 chars prefix + 23 chars CACHE_BOUNDARY + 100 chars post = 223 total
    // cacheable ratio = 100/223 ≈ 0.448
    const prefix = "A".repeat(100);
    const dynamic = "B".repeat(100);
    const prompt = makeSystemPrompt(prefix, dynamic);
    const audit = auditCacheBoundary(prompt);

    expect(audit.prefixLength).toBe(100);
    expect(audit.postBoundaryLength).toBe(100);
    expect(audit.totalLength).toBe(223);
    expect(audit.cacheableRatio).toBeCloseTo(0.448, 2);
  });

  it("handles CACHE_BOUNDARY at position 0 (empty prefix)", () => {
    const prompt = `${DEFAULT_CACHE_BOUNDARY}only dynamic`;
    const audit = auditCacheBoundary(prompt);

    expect(audit.boundaryFound).toBe(true);
    expect(audit.boundaryIndex).toBe(0);
    expect(audit.prefixContent).toBe("");
    expect(audit.cacheableRatio).toBe(0);
  });

  it("handles CACHE_BOUNDARY at end (no post-content)", () => {
    // "all cacheable" (13 chars) + CACHE_BOUNDARY (23 chars) = 36 total
    // ratio = 13/36 ≈ 0.361
    const prompt = `all cacheable${DEFAULT_CACHE_BOUNDARY}`;
    const audit = auditCacheBoundary(prompt);

    expect(audit.boundaryFound).toBe(true);
    expect(audit.postBoundaryContent).toBe("");
    expect(audit.prefixLength).toBe(13);
    expect(audit.totalLength).toBe(36);
    expect(audit.cacheableRatio).toBeCloseTo(0.361, 2);
  });
});

describe("formatAuditSummary", () => {
  it("generates readable summary for valid boundary", () => {
    const prompt = makeSystemPrompt("prefix-content", "dynamic-content");
    const audit = auditCacheBoundary(prompt);
    const summary = formatAuditSummary(audit);

    expect(summary).toContain("CACHE_BOUNDARY at offset");
    expect(summary).toContain("14 chars");
    expect(summary).toContain("cacheable");
  });

  it("generates clear warning when boundary not found", () => {
    const audit = auditCacheBoundary("no boundary here");
    const summary = formatAuditSummary(audit);

    expect(summary).toContain("NOT FOUND");
    expect(summary).toContain("uncacheable");
  });
});

describe("hasCacheBoundary", () => {
  it("returns true when marker present", () => {
    expect(hasCacheBoundary(`hello${DEFAULT_CACHE_BOUNDARY}world`)).toBe(true);
  });

  it("returns false when marker absent", () => {
    expect(hasCacheBoundary("hello world")).toBe(false);
  });
});

describe("detectPrefixLeaks", () => {
  const safePrefix = "stable persona content only";

  it("returns empty array when no dynamic content leaks", () => {
    const dynamic = ["episodic memory 1", "instruction memory 2"];
    expect(detectPrefixLeaks(safePrefix, dynamic)).toEqual([]);
  });

  it("detects when dynamic content appears in prefix", () => {
    const prefix = "prefix with episodic memory 1 leaked";
    const dynamic = ["episodic memory 1", "safe content"];
    const leaks = detectPrefixLeaks(prefix, dynamic);

    expect(leaks).toHaveLength(1);
    expect(leaks[0]).toBe("episodic memory 1");
  });

  it("detects multiple leaks in a single check", () => {
    const prefix = "prefix with leak_a and leak_b together";
    const dynamic = ["leak_a", "leak_b", "safe"];
    const leaks = detectPrefixLeaks(prefix, dynamic);

    expect(leaks).toHaveLength(2);
    expect(leaks).toContain("leak_a");
    expect(leaks).toContain("leak_b");
  });
});

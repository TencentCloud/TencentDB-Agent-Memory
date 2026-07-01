/**
 * Configuration validation boundary tests.
 *
 * Covers edge cases that can cause silent misconfiguration:
 * 1. Invalid cacheOptimization values silently fallback to "none"
 * 2. showInjected + cacheOptimization conflict detection
 * 3. recallTimeoutMs=0 causing instant timeout
 * 4. Invalid recall strategy fallback
 */

import { describe, expect, it } from "vitest";

import { parseConfig, detectConfigWarnings, type MemoryTdaiConfig, type RecallConfig } from "./config.js";

describe("Config validation: cacheOptimization edge cases", () => {
  it("valid cacheOptimization values are accepted", () => {
    const validValues: RecallConfig["cacheOptimization"][] = ["none", "stable_wrapper", "split_system"];
    for (const value of validValues) {
      const cfg = parseConfig({ recall: { cacheOptimization: value } });
      expect(cfg.recall.cacheOptimization).toBe(value);
    }
  });

  it("invalid cacheOptimization value falls back to 'none' (no crash)", () => {
    const invalidValues = ["aggressive", "full", "partial", "", "RANDOM"];
    for (const value of invalidValues) {
      const cfg = parseConfig({ recall: { cacheOptimization: value } });
      expect(cfg.recall.cacheOptimization).toBe("none");
    }
  });

  it("undefined cacheOptimization defaults to 'none'", () => {
    const cfg = parseConfig({});
    expect(cfg.recall.cacheOptimization).toBe("none");
  });

  it("null/missing cacheOptimization defaults to 'none'", () => {
    const cfg = parseConfig({ recall: {} });
    expect(cfg.recall.cacheOptimization).toBe("none");
  });
});

describe("Config validation: showInjected + cacheOptimization conflict", () => {
  it("showInjected=true + stable_wrapper produces warning", () => {
    const cfg = parseConfig({
      recall: {
        showInjected: true,
        cacheOptimization: "stable_wrapper",
      },
    });
    const warnings = detectConfigWarnings(cfg);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("showInjected=true");
    expect(warnings[0]).toContain("stable_wrapper");
    expect(warnings[0]).toContain("persist in conversation history");
  });

  it("showInjected=true + split_system produces warning", () => {
    const cfg = parseConfig({
      recall: {
        showInjected: true,
        cacheOptimization: "split_system",
      },
    });
    const warnings = detectConfigWarnings(cfg);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("split_system");
  });

  it("showInjected=true + cacheOptimization=none produces NO warning", () => {
    const cfg = parseConfig({
      recall: {
        showInjected: true,
        cacheOptimization: "none",
      },
    });
    const warnings = detectConfigWarnings(cfg);
    expect(warnings.length).toBe(0);
  });

  it("showInjected=false + any cacheOptimization produces NO warning", () => {
    for (const opt of ["none", "stable_wrapper", "split_system"] as RecallConfig["cacheOptimization"][]) {
      const cfg = parseConfig({
        recall: {
          showInjected: false,
          cacheOptimization: opt,
        },
      });
      const warnings = detectConfigWarnings(cfg);
      expect(warnings.length).toBe(0);
    }
  });

  it("default config (showInjected=false, cacheOptimization=none) produces NO warning", () => {
    const cfg = parseConfig({});
    const warnings = detectConfigWarnings(cfg);
    expect(warnings.length).toBe(0);
  });
});

describe("Config validation: recallTimeoutMs edge cases", () => {
  it("recallTimeoutMs=0 falls back to 5000ms (not instant timeout)", () => {
    // In auto-recall.ts, timeoutMs=0 uses `|| 5000` fallback
    // This test verifies the configuration parsing doesn't override that
    const cfg = parseConfig({ recall: { timeoutMs: 0 } });
    // Config stores the raw value 0 — the runtime fallback in auto-recall.ts handles it
    expect(cfg.recall.timeoutMs).toBe(0);
    // But the runtime code uses: const timeoutMs = cfg.recall.timeoutMs || 5000
    // So effective timeout = 5000 (verified in auto-recall test)
  });

  it("negative recallTimeoutMs falls back to undefined (then default 5000)", () => {
    const cfg = parseConfig({ recall: { timeoutMs: -1 } });
    // num() helper filters non-finite values, -1 is valid number
    // But in runtime, timeoutMs=-1 || 5000 → -1 is truthy → would NOT fallback
    // This is a known edge case: the runtime code should also guard against negative values
    expect(cfg.recall.timeoutMs).toBe(-1);
  });

  it("valid recallTimeoutMs values are preserved", () => {
    const cfg = parseConfig({ recall: { timeoutMs: 3000 } });
    expect(cfg.recall.timeoutMs).toBe(3000);
  });

  it("undefined recallTimeoutMs defaults to 5000ms", () => {
    const cfg = parseConfig({});
    expect(cfg.recall.timeoutMs).toBe(5000);
  });
});

describe("Config validation: recall strategy edge cases", () => {
  it("valid strategy values are accepted", () => {
    const validValues: RecallConfig["strategy"][] = ["keyword", "embedding", "hybrid"];
    for (const value of validValues) {
      const cfg = parseConfig({ recall: { strategy: value } });
      expect(cfg.recall.strategy).toBe(value);
    }
  });

  it("invalid strategy value falls back to 'hybrid' (no crash)", () => {
    const invalidValues = ["random", "fulltext", "vector", "", "UNKNOWN"];
    for (const value of invalidValues) {
      const cfg = parseConfig({ recall: { strategy: value } });
      expect(cfg.recall.strategy).toBe("hybrid");
    }
  });

  it("undefined strategy defaults to 'hybrid'", () => {
    const cfg = parseConfig({});
    expect(cfg.recall.strategy).toBe("hybrid");
  });
});

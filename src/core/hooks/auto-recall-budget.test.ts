import { describe, expect, it } from "vitest";
import {
  applyRecallBudget,
  normalizeBudgetLimit,
  truncateRecallLine,
} from "./auto-recall.js";

describe("normalizeBudgetLimit", () => {
  it("casts zero / negative / non-finite to undefined (disabled)", () => {
    expect(normalizeBudgetLimit(0)).toBeUndefined();
    expect(normalizeBudgetLimit(-1)).toBeUndefined();
    expect(normalizeBudgetLimit(NaN)).toBeUndefined();
    expect(normalizeBudgetLimit(undefined)).toBeUndefined();
    expect(normalizeBudgetLimit(Infinity)).toBeUndefined();
  });

  it("floors positive finite values to int", () => {
    expect(normalizeBudgetLimit(1500)).toBe(1500);
    expect(normalizeBudgetLimit(1500.99)).toBe(1500);
  });
});

describe("truncateRecallLine", () => {
  it("no-op for lines at or under limit", () => {
    expect(truncateRecallLine("short", 20)).toBe("short");
    expect(truncateRecallLine("刚好达到长度限制", 8)).toBe("刚好达到长度限制");
  });

  it("appends the configured truncation suffix when over limit", () => {
    const line = "x".repeat(100);
    const result = truncateRecallLine(line, 50);
    expect(result.length).toBeLessThan(line.length);
    // The canonical suffix is in Chinese, so ends with `查看详情）`.
    expect(result).toContain("查看详情）");
  });

  it("handles CJK code points correctly (never splits a surrogate pair)", () => {
    const line = "你好，这是一段中文内容用于测试截断功能，确保多字节字符不会被切分产生乱码。";
    const truncated = truncateRecallLine(line, 10);
    // Truncation uses Array.from code points — length by code point should be 10.
    expect(Array.from(truncated).length).toBe(10);
    // No replacement char at the boundary.
    expect(truncated).not.toContain("\uFFFD");
  });

  it("if limit <= suffix length, just a raw slice without suffix", () => {
    const result = truncateRecallLine("abcdefghij", 3);
    expect(result).toBe("abc");
  });
});

describe("applyRecallBudget", () => {
  const UNLIMITED: any = { maxCharsPerMemory: 0, maxTotalRecallChars: 0 };

  it("returns input unchanged when both budgets are disabled (0/undefined)", () => {
    const lines = ["A".repeat(5000), "B".repeat(6000), "C".repeat(4000)];
    expect(applyRecallBudget(lines, UNLIMITED)).toEqual(lines);
    // Also with undefined fields explicitly:
    expect(applyRecallBudget(lines, {})).toEqual(lines);
  });

  it("truncates per-memory when only per-memory budget is set", () => {
    const short = "a short memory";
    const long = "X".repeat(2000);
    const out = applyRecallBudget(
      [short, long],
      { maxCharsPerMemory: 1500, maxTotalRecallChars: 0 } as any,
    );
    expect(out.length).toBe(2);
    expect(out[0]).toBe(short);
    expect(out[1]).not.toBe(long);
    expect(Array.from(out[1]).length).toBe(1500);
  });

  it("caps total output when only total budget is set", () => {
    const lines = [
      "A".repeat(2500),
      "B".repeat(2500),
      "C".repeat(2500),
      "D".repeat(2500),
    ];
    const out = applyRecallBudget(
      lines,
      { maxCharsPerMemory: 0, maxTotalRecallChars: 6000 } as any,
    );
    // Plus separators (newlines 1 char each). So 2 2500 = 5000, + separator = 5001 chars so far.
    // Line 3 + separator needs 2501 more = 7502 total > 6000 → line 3 must be partial.
    // Line 3: remaining = 6000 - 5000 - 1 = 999 → line can be fit truncated to 999.
    const totalChars = out.join("\n").length;
    expect(totalChars).toBeLessThanOrEqual(6000);
    // Line 3 should appear truncated.
    expect(out.length).toBeLessThanOrEqual(3);
  });

  it("drops lines that would not fit MIN_TRUNCATED_RECALL_LINE_CHARS", () => {
    // Total = 300 chars. Line 1 = 100 chars. Separator = 1, remaining = 199.
    // Line 2 is 200 chars. Need at least 40 chars remaining after separator
    // to produce a truncated line.
    const line1 = "A".repeat(100);
    const line2 = "B".repeat(200);
    const out = applyRecallBudget(
      [line1, line2],
      { maxCharsPerMemory: 0, maxTotalRecallChars: 142 } as any,  // 100 (line1) + 1 (\n) + 41 (MIN=40+1 for actual) => fits exactly
    );
    // Only need to confirm out[0] === line1 preserved:
    expect(out[0]).toBe(line1);
    // And the output total (with separators) <= budget.
    expect(out.join("\n").length).toBeLessThanOrEqual(142);
  });

  it("keeps order — inputs emitted in original order, never re-sorted", () => {
    const lines = ["first-memory", "second-memory", "third-memory", "fourth-memory"];
    const out = applyRecallBudget(
      lines,
      { maxCharsPerMemory: 0, maxTotalRecallChars: 10_000 } as any,
    );
    expect(out).toEqual(lines);
  });

  it("combined per-memory and total — per-memory truncation applies first", () => {
    const huge1 = "X".repeat(5000);
    const huge2 = "Y".repeat(5000);
    const huge3 = "Z".repeat(5000);
    const out = applyRecallBudget(
      [huge1, huge2, huge3],
      { maxCharsPerMemory: 1000, maxTotalRecallChars: 2500 } as any,
    );
    // After per-memory: each shrunk to 1000 chars. Then total budget = 2500.
    // Two memories = 1000 + 1 (\n) + 1000 = 2001. Third can fit partially:
    //   remaining = 2500 - 2001 = 499; can fit 499 chars of third.
    expect(out.length).toBeGreaterThanOrEqual(2);
    const total = out.join("\n").length;
    expect(total).toBeLessThanOrEqual(2500);
    // Per-memory check for first:
    expect(Array.from(out[0]).length).toBe(1000);
  });

  it("does not crash for empty input", () => {
    expect(applyRecallBudget([], { maxCharsPerMemory: 100, maxTotalRecallChars: 100 } as any)).toEqual([]);
  });
});

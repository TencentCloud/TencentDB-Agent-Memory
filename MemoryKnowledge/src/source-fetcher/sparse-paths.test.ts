import { describe, expect, it } from "vitest";
import { normalizeSparsePaths } from "./sparse-paths.js";

describe("normalizeSparsePaths", () => {
  it("normalizes, deduplicates, and preserves the first-seen order", () => {
    expect(normalizeSparsePaths([" src/", "src", "docs/api", "docs/api/changes.md "])).toEqual([
      "src",
      "docs/api",
      "docs/api/changes.md",
    ]);
  });

  it("accepts an empty array as full checkout", () => {
    expect(normalizeSparsePaths([])).toEqual([]);
  });

  it.each([
    ["absolute path", ["/src"]],
    ["parent traversal", ["src/../docs"]],
    ["dot path", ["."]],
    ["empty segment", ["src//generated"]],
    ["trailing empty segment", ["src//"]],
    ["backslash path", ["src\\generated"]],
    ["blank path", ["   "]],
  ])("rejects %s", (_label, value) => {
    expect(() => normalizeSparsePaths(value)).toThrow(/sparse_paths/);
  });

  it("rejects non-array input", () => {
    expect(() => normalizeSparsePaths("src")).toThrow(/sparse_paths/);
  });
});

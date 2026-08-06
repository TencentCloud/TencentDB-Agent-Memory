import { describe, it, expect } from "vitest";
import { captureShape, compareShape, type PrefixShape } from "./cache-diagnostics";

describe("captureShape", () => {
  it("produces deterministic hashes for identical inputs", () => {
    const a = captureShape("you are a helpful assistant", [{ name: "read_file" }]);
    const b = captureShape("you are a helpful assistant", [{ name: "read_file" }]);
    expect(a.systemHash).toBe(b.systemHash);
    expect(a.toolsHash).toBe(b.toolsHash);
    expect(a.prefixHash).toBe(b.prefixHash);
  });

  it("produces different hashes when system prompt changes", () => {
    const a = captureShape("you are a helpful assistant");
    const b = captureShape("you are a coding agent");
    expect(a.systemHash).not.toBe(b.systemHash);
    expect(a.prefixHash).not.toBe(b.prefixHash);
  });

  it("handles empty inputs", () => {
    const s = captureShape("");
    expect(s.systemHash).toBeTruthy();
    expect(typeof s.systemHash).toBe("string");
  });

  it("estimates tool schema tokens", () => {
    const s = captureShape("", [{ name: "a".repeat(100) }]);
    expect(s.toolSchemaTokens).toBeGreaterThan(0);
  });
});

describe("compareShape", () => {
  const stable: PrefixShape = captureShape("you are helpful");

  it("reports no change when shapes are identical", () => {
    const d = compareShape(stable, stable);
    expect(d.prefixChanged).toBe(false);
    expect(d.prefixChangeReasons).toEqual([]);
  });

  it("reports system change when system hash differs", () => {
    const changed = captureShape("different system prompt");
    const d = compareShape(stable, changed);
    expect(d.prefixChanged).toBe(true);
    expect(d.prefixChangeReasons).toContain("system");
  });

  it("reports no change on first turn (prev = null)", () => {
    const d = compareShape(null, stable);
    expect(d.prefixChanged).toBe(false);
  });

  it("prefix hash is deterministic", () => {
    const d1 = compareShape(null, stable);
    const d2 = compareShape(null, captureShape("you are helpful"));
    expect(d1.prefixHash).toBe(d2.prefixHash);
  });
});

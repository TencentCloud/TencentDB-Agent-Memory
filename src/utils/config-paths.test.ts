import { describe, it, expect } from "vitest";
import { resolve, isAbsolute } from "node:path";

function resolveOffloadDataDir(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (isAbsolute(trimmed)) return trimmed;
  return resolve(trimmed);
}

describe("resolveOffloadDataDir", () => {
  it("returns undefined for undefined input", () => {
    expect(resolveOffloadDataDir(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(resolveOffloadDataDir("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only string", () => {
    expect(resolveOffloadDataDir("   ")).toBeUndefined();
  });

  it("returns absolute paths unchanged", () => {
    const abs = "/data/my-offload";
    expect(resolveOffloadDataDir(abs)).toBe(abs);
  });

  it("resolves relative paths against cwd", () => {
    const rel = "my-data";
    const result = resolveOffloadDataDir(rel);
    expect(isAbsolute(result!)).toBe(true);
    expect(result).toBe(resolve(rel));
  });

  it("resolves relative paths with ../ segments", () => {
    const rel = "../shared-data";
    const result = resolveOffloadDataDir(rel);
    expect(isAbsolute(result!)).toBe(true);
    expect(result).toBe(resolve(rel));
  });

  it("trims whitespace around paths", () => {
    expect(resolveOffloadDataDir("  /abs/path  ")).toBe("/abs/path");
    expect(resolveOffloadDataDir("  rel/path  ")).toBe(resolve("rel/path"));
  });

  it("treats empty-after-trim as unset", () => {
    expect(resolveOffloadDataDir("\n\t")).toBeUndefined();
  });

  describe("Windows-style paths", () => {
    it("preserves Windows absolute paths", () => {
      const win = "C:\\data\\offload";
      const result = resolveOffloadDataDir(win);
      expect(result).toBe(win);
    });

    it("resolves Windows relative paths", () => {
      const winRel = "data\\offload";
      const result = resolveOffloadDataDir(winRel);
      expect(isAbsolute(result!)).toBe(true);
    });
  });
});
/**
 * isMainModule unit tests — the Windows-backslash normalization is the whole
 * point: adapter entry suffixes contain a "/", which a raw endsWith() check
 * can never match against a backslash argv[1].
 */

import { describe, expect, it } from "vitest";

import { isMainModule } from "./is-main.js";

const SUFFIXES = ["claude-code/main.ts", "claude-code/main.js"];

describe("isMainModule", () => {
  it("matches POSIX argv[1] paths (source run via tsx)", () => {
    expect(isMainModule("/repo/src/adapters/claude-code/main.ts", SUFFIXES)).toBe(true);
  });

  it("matches Windows backslash argv[1] paths", () => {
    expect(isMainModule("C:\\repo\\src\\adapters\\claude-code\\main.ts", SUFFIXES)).toBe(true);
  });

  it("matches compiled output (.js suffix), including on Windows", () => {
    expect(isMainModule("/repo/dist/adapters/claude-code/main.js", SUFFIXES)).toBe(true);
    expect(isMainModule("C:\\repo\\dist\\adapters\\claude-code\\main.js", SUFFIXES)).toBe(true);
  });

  it("rejects other entrypoints and a missing argv[1]", () => {
    expect(isMainModule("/repo/node_modules/vitest/dist/cli.js", SUFFIXES)).toBe(false);
    expect(isMainModule("/repo/src/adapters/dify/main.ts", SUFFIXES)).toBe(false);
    expect(isMainModule(undefined, SUFFIXES)).toBe(false);
  });
});

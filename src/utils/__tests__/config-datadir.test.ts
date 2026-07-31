import { describe, expect, it } from "vitest";
import { normalizeDataDir, parseConfig } from "../../config.js";

describe("normalizeDataDir (offload.dataDir validator)", () => {
  it("returns undefined for undefined (omitted)", () => {
    expect(normalizeDataDir(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string (treats empty as omitted, per issue #521)", () => {
    expect(normalizeDataDir("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only strings", () => {
    expect(normalizeDataDir("   ")).toBeUndefined();
    expect(normalizeDataDir("\t\n ")).toBeUndefined();
  });

  it("returns undefined for relative paths (issue #521)", () => {
    expect(normalizeDataDir(".")).toBeUndefined();
    expect(normalizeDataDir("..")).toBeUndefined();
    expect(normalizeDataDir("./data")).toBeUndefined();
    expect(normalizeDataDir("../data")).toBeUndefined();
    expect(normalizeDataDir("data/offload")).toBeUndefined();
    // Windows-style relative (still not absolute on any platform)
    expect(normalizeDataDir("C:not/absolute")).toBeUndefined();
  });

  it("keeps trimmed absolute paths on macOS/Linux", () => {
    expect(normalizeDataDir("/Users/alice/.openclaw/offload")).toBe("/Users/alice/.openclaw/offload");
    expect(normalizeDataDir("/var/lib/tdai-offload")).toBe("/var/lib/tdai-offload");
    // Trailing whitespace is trimmed, but the path remains absolute & kept
    expect(normalizeDataDir("  /var/lib/tdai-offload  ")).toBe("/var/lib/tdai-offload");
  });

  it("keeps Windows-style absolute paths (when running on any host)", () => {
    // `isAbsolute('C:\\Users\\...')` returns true on Windows, but it's
    // platform-dependent. We only assert the shape here.
    if (process.platform === "win32") {
      expect(normalizeDataDir("C:\\Users\\alice\\.openclaw\\offload")).toBe(
        "C:\\Users\\alice\\.openclaw\\offload",
      );
    } else {
      // On non-Windows hosts, `C:\...` is treated as a relative path, so
      // the validator correctly rejects it (undefined) since we only accept
      // platform-native absolute paths.
      expect(normalizeDataDir("C:\\Users\\alice\\offload")).toBeUndefined();
    }
  });
});

describe("parseConfig offload.dataDir — exact issue #521 reproducer", () => {
  it("treats an empty offload.dataDir as omitted (dataDir = undefined)", () => {
    expect(parseConfig({ offload: { dataDir: "" } }).offload.dataDir).toBeUndefined();
  });

  it("treats a relative offload.dataDir as omitted (dataDir = undefined)", () => {
    expect(parseConfig({ offload: { dataDir: "./local-data" } }).offload.dataDir).toBeUndefined();
    expect(parseConfig({ offload: { dataDir: "../relative-data" } }).offload.dataDir).toBeUndefined();
    expect(parseConfig({ offload: { dataDir: "just-a-name" } }).offload.dataDir).toBeUndefined();
  });

  it("preserves absolute offload.dataDir", () => {
    const abs = process.platform === "win32" ? "C:\\tdai-data" : "/tmp/tdai-offload";
    expect(parseConfig({ offload: { dataDir: abs } }).offload.dataDir).toBe(abs);
  });
});

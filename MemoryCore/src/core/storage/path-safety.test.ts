import { resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSafeRelativePath } from "./path-safety.js";

const ROOT = "/tmp/path-safety-fixture-root";

describe("resolveSafeRelativePath", () => {
  it("resolves a simple relative key", () => {
    expect(resolveSafeRelativePath(ROOT, "a.md")).toBe("a.md");
  });

  it("resolves a nested relative key using OS separators", () => {
    expect(resolveSafeRelativePath(ROOT, "scene_blocks/a.md")).toBe(`scene_blocks${sep}a.md`);
  });

  it("collapses '.' segments to the empty relative path", () => {
    expect(resolveSafeRelativePath(ROOT, ".")).toBe("");
  });

  it("round-trips with resolve(rootDir, result) back to the same absolute path", () => {
    const rel = resolveSafeRelativePath(ROOT, "conversations/2026-08-15.jsonl");
    expect(resolve(ROOT, rel)).toBe(resolve(ROOT, "conversations", "2026-08-15.jsonl"));
  });

  const badKeys: Array<[string, string]> = [
    ["empty string", ""],
    ["NUL byte", "records/\0evil"],
    ["leading slash (absolute)", "/etc/passwd"],
    ["leading backslash", "\\evil"],
    ["parent traversal", "../../../etc/passwd"],
    ["parent traversal with valid prefix", "scene_blocks/../../../etc/passwd"],
    ["sibling-directory-name bypass", `../${ROOT.split("/").pop()}-evil/x.md`],
  ];

  for (const [label, key] of badKeys) {
    it(`rejects ${label}`, () => {
      expect(() => resolveSafeRelativePath(ROOT, key)).toThrow();
    });
  }

  it("rejects a non-string key", () => {
    // @ts-expect-error — deliberately passing a bad type to prove the runtime guard
    expect(() => resolveSafeRelativePath(ROOT, null)).toThrow();
  });
});

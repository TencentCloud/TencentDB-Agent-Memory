import { describe, it, expect, vi, afterEach } from "vitest";
import { validateBundle, BundleValidationError } from "../src/engines/wiki/okf-bundle-validation.js";

const page = "---\ntype: Custom Concept\nextra: null\n---\nFact[^source]";
afterEach(() => vi.restoreAllMocks());

describe("pure OKF exchange preflight", () => {
  it("accepts nested concepts, indexes, logs and opaque attachments without rewriting input", () => {
    const files = [{ path: "index.md", content: '---\nokf_version: "0.2"\n---\n# Index' },
      { path: "nested/index.md", content: "# Nested" }, { path: "log.md", content: "## 2026-10-14\nUpdate" },
      { path: "nested/a.md", content: page }, { path: "attachment.bin", content: "AP8=", encoding: "base64" as const }];
    const before = structuredClone(files);
    expect(validateBundle(files)).toEqual({ files: 5, concepts: 1, warnings: [] });
    expect(files).toEqual(before);
  });
  it("warns about unknown root version and nonstandard log headings", () => {
    expect(validateBundle([{ path: "index.md", content: '---\nokf_version: "9.9"\n---' },
      { path: "log.md", content: "## yesterday" }]).warnings).toHaveLength(2);
  });
  it.each(["../a.md", "/a.md", "a//b.md", "a/./b.md", ".private/a.md", "a\\b.md", "a:b.md", "a\0.md", "a\n.md"])("rejects unsafe path %j", path => {
    expect(() => validateBundle([{ path, content: page }])).toThrow(BundleValidationError);
  });
  it.each([
    ["a.md", "a.md"], ["A.md", "a.md"], ["é.md", "e\u0301.md"],
    ["a.md", "a.md/b.md"], ["Dir/a.md", "dir/b.md"],
  ])("rejects duplicate/alias/file-directory collisions %j", (a, b) => {
    expect(() => validateBundle([{ path: a, content: page }, { path: b, content: page }])).toThrow(BundleValidationError);
  });
  it.each(["====", "A===", "Zg", "Zg=", "Z g=", "!!=="])("rejects malformed base64 %j", content => {
    expect(() => validateBundle([{ path: "a.bin", content, encoding: "base64" }])).toThrow(BundleValidationError);
  });
  it.each(["plain body", "---\ntype: []\n---\nBody", "---\ntype: [broken\n---\nBody"])("rejects invalid concept frontmatter", content => {
    expect(() => validateBundle([{ path: "a.md", content }])).toThrow(BundleValidationError);
  });
  it("rejects invalid UTF-8 markdown while preserving opaque binary attachments", () => {
    expect(() => validateBundle([{ path: "a.md", content: "/w==", encoding: "base64" }])).toThrow(BundleValidationError);
    expect(validateBundle([{ path: "a.bin", content: "/w==", encoding: "base64" }]).concepts).toBe(0);
  });
  it.each(["---\n[]\n---", "---\nother: value\n---"])("rejects nonmapping or extra root index metadata", content => {
    expect(() => validateBundle([{ path: "index.md", content }])).toThrow(BundleValidationError);
  });
  it("rejects frontmatter in nonroot indexes", () => {
    expect(() => validateBundle([{ path: "nested/index.md", content: '---\nokf_version: "0.2"\n---' }])).toThrow(BundleValidationError);
  });
  it("rejects empty bundles and more than 1000 files", () => {
    expect(() => validateBundle([])).toThrow(BundleValidationError);
    expect(() => validateBundle(Array.from({ length: 1001 }, (_, i) => ({ path: `${i}.bin`, content: "" })))).toThrow(BundleValidationError);
  });
  it("counts UTF-8 bytes and refuses oversized text before decoding allocation", () => {
    const content = "中".repeat(Math.ceil(10 * 1024 * 1024 / 3));
    const decode = vi.spyOn(Buffer, "from");
    expect(() => validateBundle([{ path: "a.bin", content }])).toThrow("10 MiB");
    expect(decode).not.toHaveBeenCalled();
  });
  it("refuses oversized base64 before decoding allocation", () => {
    const content = Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64");
    const decode = vi.spyOn(Buffer, "from");
    expect(() => validateBundle([{ path: "a.bin", content, encoding: "base64" }])).toThrow("10 MiB");
    expect(decode).not.toHaveBeenCalled();
  });
  it("accepts exact byte limits in either encoding and rejects aggregate overflow", () => {
    const content = "x".repeat(10 * 1024 * 1024);
    expect(validateBundle([{ path: "a.bin", content }]).files).toBe(1);
    expect(validateBundle([{ path: "a.bin", content: Buffer.from(content).toString("base64"), encoding: "base64" }]).files).toBe(1);
    expect(() => validateBundle([{ path: "a.bin", content }, { path: "b.bin", content: "x" }])).toThrow("10 MiB");
  });
});

// A valid surrogate pair encodes one scalar; lone halves collapse to U+FFFD in Node filesystem paths.
it.each(["\ud800.bin", "\udfff.bin", "dir/\ud801.bin", "x\ud800y.bin"])("rejects lossy Unicode path %j", path => {
  expect(() => validateBundle([{ path, content: "synthetic" }])).toThrow(BundleValidationError);
});
it("accepts valid astral and replacement-character paths without rewriting", () => {
  const files = [{ path: "\ud83d\ude00.bin", content: "astral" }, { path: "\ufffd.bin", content: "replacement" }];
  const before = structuredClone(files);
  expect(validateBundle(files).files).toBe(2); expect(files).toEqual(before);
});

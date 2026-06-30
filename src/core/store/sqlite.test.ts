/**
 * Tests for FTS5 query sanitization in buildFtsQuery() — issue #160.
 *
 * These tests run against the fallback (regex) tokenizer path. The jieba
 * path is lazy-loaded and not available in this test environment, but the
 * sanitize step runs before either tokenizer is selected, so the
 * sanitization contract is the same for both paths.
 */

import { describe, expect, it } from "vitest";

import { buildFtsQuery } from "./sqlite.js";

/** Return the per-token quoted terms that buildFtsQuery() emits. */
function quotedTerms(out: string): string[] {
  return out.match(/"[^"]*"/g) ?? [];
}

describe("buildFtsQuery() — FTS5 operator sanitization (issue #160)", () => {
  it("strips AND/OR/NOT/NEAR operators so they cannot alter query semantics", () => {
    const out = buildFtsQuery("foo AND bar OR baz NOT qux NEAR hello");
    expect(out).not.toBeNull();
    // None of the operator keywords may appear as quoted tokens in the output.
    // (The ` OR ` join separator is fine — we only care that the operator
    // words from user input didn't survive tokenization.)
    const tokens = quotedTerms(out!);
    expect(tokens.map((t) => t.toUpperCase())).not.toContain('"AND"');
    expect(tokens.map((t) => t.toUpperCase())).not.toContain('"OR"');
    expect(tokens.map((t) => t.toUpperCase())).not.toContain('"NOT"');
    expect(tokens.map((t) => t.toUpperCase())).not.toContain('"NEAR"');
    // Real content terms survive
    expect(out).toContain('"foo"');
    expect(out).toContain('"bar"');
    expect(out).toContain('"baz"');
    expect(out).toContain('"qux"');
    expect(out).toContain('"hello"');
  });

  it("strips operators case-insensitively", () => {
    const out = buildFtsQuery("foo and bar Or baz not qux");
    expect(out).not.toBeNull();
    const tokens = quotedTerms(out!);
    expect(tokens.map((t) => t.toUpperCase())).not.toContain('"AND"');
    expect(tokens.map((t) => t.toUpperCase())).not.toContain('"OR"');
    expect(tokens.map((t) => t.toUpperCase())).not.toContain('"NOT"');
  });

  it("strips single quotes and asterisks (defense-in-depth)", () => {
    const out = buildFtsQuery("foo's bar* baz");
    expect(out).not.toBeNull();
    expect(out).not.toContain("'");
    expect(out).not.toContain("*");
    expect(out).toContain('"foo"');
    expect(out).toContain('"bar"');
    expect(out).toContain('"baz"');
  });

  it("preserves normal Chinese / English text without operators", () => {
    const out = buildFtsQuery("用户 喜欢 TypeScript 编程");
    expect(out).not.toBeNull();
    expect(out).toContain('"用户"');
    expect(out).toContain('"喜欢"');
    expect(out).toContain('"TypeScript"');
    expect(out).toContain('"编程"');
  });

  it("does not treat operator substrings as operators (word-boundary)", () => {
    // "ANDROID" contains "AND" but is a real word, not the FTS5 operator.
    // The regex uses \b so it must NOT strip it.
    const out = buildFtsQuery("ANDROID scanner");
    expect(out).not.toBeNull();
    expect(out).toContain('"ANDROID"');
    expect(out).toContain('"scanner"');
  });
});

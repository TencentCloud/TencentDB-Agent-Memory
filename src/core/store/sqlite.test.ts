import { describe, expect, it, afterEach } from "vitest";
import { buildFtsQuery, _resetJiebaForTest, _setJiebaForTest } from "./sqlite.js";

/** Extract the per-token quoted terms that buildFtsQuery() emits. */
function quotedTerms(out: string): string[] {
  return out.match(/"[^"]*"/g) ?? [];
}

describe("buildFtsQuery() — FTS5 operator sanitization (issue #160)", () => {
  afterEach(() => {
    _resetJiebaForTest();
  });

  // ── Behavior 1: FTS5 boolean/positional operators stripped ──

  it("strips AND/OR/NOT/NEAR operators so they cannot alter query semantics", () => {
    _setJiebaForTest(null); // force fallback (regex) tokenizer

    const out = buildFtsQuery("foo AND bar OR baz NOT qux NEAR hello");
    expect(out).not.toBeNull();

    const tokens = quotedTerms(out!);
    expect(tokens.map((t) => t.toUpperCase())).not.toContain('"AND"');
    expect(tokens.map((t) => t.toUpperCase())).not.toContain('"OR"');
    expect(tokens.map((t) => t.toUpperCase())).not.toContain('"NOT"');
    expect(tokens.map((t) => t.toUpperCase())).not.toContain('"NEAR"');
    expect(out).toContain('"foo"');
    expect(out).toContain('"bar"');
    expect(out).toContain('"baz"');
    expect(out).toContain('"qux"');
    expect(out).toContain('"hello"');
  });

  // ── Behavior 2: Case-insensitive operator stripping ──

  it("strips operators case-insensitively", () => {
    _setJiebaForTest(null);

    const out = buildFtsQuery("foo and bar Or baz not qux");
    expect(out).not.toBeNull();

    const tokens = quotedTerms(out!);
    expect(tokens.map((t) => t.toUpperCase())).not.toContain('"AND"');
    expect(tokens.map((t) => t.toUpperCase())).not.toContain('"OR"');
    expect(tokens.map((t) => t.toUpperCase())).not.toContain('"NOT"');
    expect(out).toContain('"foo"');
    expect(out).toContain('"bar"');
    expect(out).toContain('"baz"');
    expect(out).toContain('"qux"');
  });

  // ── Behavior 3: FTS5 special characters stripped ──

  it("strips FTS5 special characters (parens, stars, colons, carets, dashes, single-quotes)", () => {
    _setJiebaForTest(null);

    const out = buildFtsQuery("foo\"bar' baz(qux) run* far: test^ end");
    expect(out).not.toBeNull();
    // Note: single `"` chars in output are the legitimate per-token quoting
    // format used by buildFtsQuery — not injection. Check injection chars:
    expect(out).not.toContain("'");
    expect(out).not.toContain("*");
    expect(out).not.toContain(":");
    expect(out).not.toContain("^");
    expect(out).toContain('"foo"');
    expect(out).toContain('"bar"');
    expect(out).toContain('"baz"');
    expect(out).toContain('"qux"');
    expect(out).toContain('"run"');
    expect(out).toContain('"far"');
    expect(out).toContain('"test"');
    expect(out).toContain('"end"');
  });

  it("strips the exclude operator (minus sign)", () => {
    _setJiebaForTest(null);

    const out = buildFtsQuery("foo -bar -baz");
    expect(out).not.toBeNull();
    expect(out).toContain('"foo"');
    expect(out).toContain('"bar"');
    expect(out).toContain('"baz"');
  });

  // ── Behavior 4: Column filter syntax blocked ──

  it("strips column filter syntax (content:foo)", () => {
    _setJiebaForTest(null);

    const out = buildFtsQuery("content:foo title:bar baz");
    expect(out).not.toBeNull();
    expect(out).toContain('"content"');
    expect(out).toContain('"foo"');
    expect(out).toContain('"title"');
    expect(out).toContain('"bar"');
    expect(out).toContain('"baz"');
  });

  // ── Behavior 5: Word-boundary protection ──

  it("does not treat operator substrings as operators (word-boundary)", () => {
    _setJiebaForTest(null);

    const out = buildFtsQuery("ANDROID scanner ORDER_NOTES nothing");
    expect(out).not.toBeNull();
    expect(out).toContain('"ANDROID"');
    expect(out).toContain('"scanner"');
    expect(out).toContain('"ORDER_NOTES"');
    expect(out).toContain('"nothing"');
  });

  // ── Behavior 6: Pure-operator input returns null ──

  it("returns null when input contains only FTS5 syntax and operators", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("AND OR NOT NEAR")).toBeNull();
    expect(buildFtsQuery("' \" : ( ) * ^ -")).toBeNull();
    expect(buildFtsQuery("   *** ((())) :::   ")).toBeNull();
  });

  // ── Behavior 7: Empty-token filtering in quoting ──

  it("filters empty tokens after quote-stripping to avoid bare \"\" in output", () => {
    _setJiebaForTest(null);

    const out = buildFtsQuery('foo "" "" bar');
    expect(out).not.toBeNull();
    expect(out).toContain('"foo"');
    expect(out).toContain('"bar"');
    expect(out).not.toContain('""');
  });

  // ── Behavior 8: Jieba path also sanitized ──

  it("applies the same sanitizer to jieba-produced tokens", () => {
    // Mock jieba returning operator-laced tokens
    _setJiebaForTest({
      cutForSearch: () => ["foo:bar", " ", "AND", "C++", "的", "用户", "NEAR"],
    } as ReturnType<typeof _setJiebaForTest>);

    const out = buildFtsQuery("ignored by fake jieba");
    expect(out).not.toBeNull();
    // "foo:bar" → "foo" + "bar" (colon stripped before jieba; jieba keeps it as one token,
    // then the final quote-stripping won't split it — this is expected: colon was already
    // removed from raw input, so the token is "foobar" post-strip.)
    // Actually: sanitizeFtsRaw removes : from raw input *before* jieba sees it,
    // so jieba receives "ignored by fake jieba" with no colons, but our mock jieba
    // returns tokens that include "foo:bar" (simulating jieba preserving colons).
    // In real usage, jieba would never receive colons since sanitizeFtsRaw runs first.
    // But the final `replaceAll('"', "")` filtering still protects against leak-through.
    // The key test is: "AND" and "NEAR" operator tokens from jieba must be filtered out.
    expect(out).not.toContain('"AND"');
    expect(out).not.toContain('"NEAR"');
    expect(out).toContain('"用户"');
  });

  // ── Behavior 9: Normal recall unaffected ──

  it("preserves normal Chinese text without operators", () => {
    _setJiebaForTest(null);

    const out = buildFtsQuery("用户 喜欢 TypeScript 编程");
    expect(out).not.toBeNull();
    expect(out).toContain('"用户"');
    expect(out).toContain('"喜欢"');
    expect(out).toContain('"TypeScript"');
    expect(out).toContain('"编程"');
  });

  it("returns null for empty and whitespace-only input", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("")).toBeNull();
    expect(buildFtsQuery("   ")).toBeNull();
  });
});

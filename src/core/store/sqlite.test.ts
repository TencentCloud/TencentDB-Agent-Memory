import { afterEach, describe, expect, it } from "vitest";
import { buildFtsQuery, _resetJiebaForTest, _setJiebaForTest } from "./sqlite.js";

describe("buildFtsQuery FTS5 sanitization", () => {
  afterEach(() => {
    _resetJiebaForTest();
  });

  // ─── Basic operator stripping (also covered by #178) ───

  it("strips FTS5 boolean operators before fallback tokenization", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("alpha AND beta OR NOT gamma NEAR delta")).toBe(
      '"alpha" OR "beta" OR "gamma" OR "delta"',
    );
  });

  it("does not strip operator words embedded inside normal tokens", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("android origin notable nearby")).toBe(
      '"android" OR "origin" OR "notable" OR "nearby"',
    );
  });

  it("strips FTS5 operators before jieba tokenization", () => {
    const seen: string[] = [];
    _setJiebaForTest({
      cutForSearch(text: string): string[] {
        seen.push(text);
        return text.split(/\s+/);
      },
    });

    expect(buildFtsQuery("用户 AND TypeScript OR 记忆")).toBe(
      '"用户" OR "TypeScript" OR "记忆"',
    );
    expect(seen).toEqual(["用户 TypeScript 记忆"]);
  });

  // ─── Additional sanitization beyond #178 ───

  // Column prefix specifiers (colname:term)
  it("strips FTS5 column prefix specifiers", () => {
    _setJiebaForTest(null);

    // "content:secret" → just "secret", the "content:" prefix is FTS5 syntax
    expect(buildFtsQuery("content:secret project")).toBe(
      '"secret" OR "project"',
    );
  });

  it("strips column prefixes with mixed case", () => {
    _setJiebaForTest(null);
    // Case-insensitive column prefix stripping
    expect(buildFtsQuery("Title:hello Body:world")).toBe(
      '"hello" OR "world"',
    );
  });

  it("preserves URLs (column prefix regex excludes ://)", () => {
    _setJiebaForTest(null);
    // "https://example.com" should NOT have "https" stripped (:// exclusion)
    const result = buildFtsQuery("visit https://example.com for docs");
    expect(result).toContain("https");
    expect(result).toContain("example");
    expect(result).toContain("com");
  });

  // Wildcard operators
  it("strips FTS5 prefix wildcards (*)", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("hello* world")).toBe(
      '"hello" OR "world"',
    );
  });

  it("strips FTS5 suffix wildcards (^)", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("test^ query")).toBe(
      '"test" OR "query"',
    );
  });

  it("strips mixed wildcards and operators", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("prefix* AND suffix^ OR NEAR mid*word")).toBe(
      '"prefix" OR "suffix" OR "mid" OR "word"',
    );
  });

  // Parentheses grouping
  it("strips FTS5 grouping parentheses", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("(alpha OR beta) AND gamma")).toBe(
      '"alpha" OR "beta" OR "gamma"',
    );
  });

  it("strips nested parentheses", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("((nested)) query")).toBe(
      '"nested" OR "query"',
    );
  });

  // Double-quote escaping
  it("strips double-quotes that could escape the quoting wrapper", () => {
    _setJiebaForTest(null);

    // Input contains unbalanced quotes trying to break out
    expect(buildFtsQuery('safe" OR "1"="1')).toBe(
      '"safe" OR "1" OR "1"',
    );
  });

  it("strips double-quotes in phrase attempts", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery('"exact phrase" query')).toBe(
      '"exact" OR "phrase" OR "query"',
    );
  });

  // Combined attacks
  it("handles combined FTS5 injection attempt", () => {
    _setJiebaForTest(null);

    // Realistic injection: column prefix + operators + parentheses + wildcards
    const malicious = "content:secret AND (admin* OR user^) NOT public";
    expect(buildFtsQuery(malicious)).toBe(
      '"secret" OR "admin" OR "user" OR "public"',
    );
  });

  it("handles quoted column prefix injection", () => {
    _setJiebaForTest(null);

    // Quotes wrapping a column prefix expression — "title:admin" becomes
    // just "admin" after quote and column-prefix stripping
    const malicious = '"title:admin" OR 1=1';
    expect(buildFtsQuery(malicious)).toBe(
      '"admin" OR "1" OR "1"',
    );
  });

  // Edge cases
  it("returns null for empty string after sanitization", () => {
    _setJiebaForTest(null);

    // Only operators/syntax → nothing left
    expect(buildFtsQuery("AND OR NOT")).toBeNull();
  });

  it("returns null for whitespace-only input", () => {
    _setJiebaForTest(null);
    expect(buildFtsQuery("   ")).toBeNull();
  });

  it("handles already-clean input unchanged", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("simple clean query")).toBe(
      '"simple" OR "clean" OR "query"',
    );
  });
});

import { afterEach, describe, expect, it } from "vitest";

import {
  _resetJiebaForTest,
  _setJiebaForTest,
  buildFtsQuery,
  sanitizeFtsInput,
} from "./sqlite.js";

/**
 * Unit tests for `buildFtsQuery` — pure function, no SQLite required.
 *
 * Covers the FTS5-operator sanitization fix (issue #160): user input
 * containing the reserved keywords AND / OR / NOT / NEAR must not alter
 * the connective of the compiled MATCH expression.
 *
 * Semantics follow the SQLite FTS5 grammar (§3 Full-text Query Syntax):
 * the four keywords are **case-sensitive** — only UPPERCASE forms act as
 * operators. Lowercase `and` / `or` / `not` / `near` are ordinary
 * English barewords and MUST be preserved for recall.
 */

afterEach(() => {
  _resetJiebaForTest();
});

describe("sanitizeFtsInput", () => {
  it("strips uppercase FTS5 reserved keywords as whole words", () => {
    expect(sanitizeFtsInput("cats AND dogs")).toBe("cats   dogs");
    expect(sanitizeFtsInput("cats OR dogs")).toBe("cats   dogs");
    expect(sanitizeFtsInput("cats NOT dogs")).toBe("cats   dogs");
    expect(sanitizeFtsInput("foo NEAR bar")).toBe("foo   bar");
  });

  it("preserves lowercase forms — they are not FTS5 operators", () => {
    // Per FTS5 grammar §3: keywords are case-sensitive.
    expect(sanitizeFtsInput("cats and dogs")).toBe("cats and dogs");
    expect(sanitizeFtsInput("cats or dogs")).toBe("cats or dogs");
    expect(sanitizeFtsInput("apples and oranges near me")).toBe(
      "apples and oranges near me",
    );
  });

  it("preserves mixed-case forms — only fully-uppercase is reserved", () => {
    expect(sanitizeFtsInput("cats And dogs")).toBe("cats And dogs");
    expect(sanitizeFtsInput("foo Near bar")).toBe("foo Near bar");
    expect(sanitizeFtsInput("aNd oR nOt")).toBe("aNd oR nOt");
  });

  it("preserves substrings that only contain a keyword", () => {
    // "ANDROID" must not become " ROID".
    expect(sanitizeFtsInput("ANDROID notation nearby")).toBe(
      "ANDROID notation nearby",
    );
    expect(sanitizeFtsInput("NEARBY signal")).toBe("NEARBY signal");
  });

  it("handles multiple operators and adjacent punctuation", () => {
    expect(sanitizeFtsInput("A AND B OR C NOT D")).toBe("A   B   C   D");
    // Word boundary in JS regex uses \w which is ASCII-only, so ASCII
    // punctuation around ASCII keywords is treated as a boundary.
    expect(sanitizeFtsInput("(AND)")).toBe("( )");
    expect(sanitizeFtsInput("foo,AND,bar")).toBe("foo, ,bar");
  });

  it("leaves non-keyword text unchanged", () => {
    expect(sanitizeFtsInput("hello world")).toBe("hello world");
    expect(sanitizeFtsInput("北京烤鸭")).toBe("北京烤鸭");
    expect(sanitizeFtsInput("")).toBe("");
  });
});

describe("buildFtsQuery — fallback (jieba unavailable)", () => {
  const withFallback = () => _setJiebaForTest(null);

  it("returns null for empty / punctuation-only input", () => {
    withFallback();
    expect(buildFtsQuery("")).toBeNull();
    expect(buildFtsQuery("   ")).toBeNull();
    expect(buildFtsQuery("???")).toBeNull();
  });

  it("OR-joins quoted tokens for plain input", () => {
    withFallback();
    expect(buildFtsQuery("travel plan API")).toBe(
      '"travel" OR "plan" OR "API"',
    );
  });

  it("drops uppercase FTS5 reserved operators from raw input (issue #160)", () => {
    withFallback();
    expect(buildFtsQuery("cats AND dogs")).toBe('"cats" OR "dogs"');
    expect(buildFtsQuery("cats OR dogs")).toBe('"cats" OR "dogs"');
    expect(buildFtsQuery("cats NOT dogs")).toBe('"cats" OR "dogs"');
    expect(buildFtsQuery("foo NEAR bar")).toBe('"foo" OR "bar"');
  });

  it("neutralizes bare NEAR(...) group syntax", () => {
    withFallback();
    // Attacker attempt: "coffee NEAR(tea, 3)". The NEAR keyword is the
    // trigger; parentheses and comma are stripped by the regex tokenizer.
    // After sanitization the query should be safely OR-joined.
    expect(buildFtsQuery("coffee NEAR(tea, 3)")).toBe(
      '"coffee" OR "tea" OR "3"',
    );
  });

  it("preserves lowercase `and` / `or` / `not` / `near` (recall)", () => {
    withFallback();
    expect(buildFtsQuery("cats and dogs")).toBe(
      '"cats" OR "and" OR "dogs"',
    );
    expect(buildFtsQuery("apples or oranges near me")).toBe(
      '"apples" OR "or" OR "oranges" OR "near" OR "me"',
    );
  });

  it("preserves mixed-case forms — only fully-uppercase is stripped", () => {
    withFallback();
    // Neither `And` nor `aNd` is an FTS5 operator, so both must remain.
    expect(buildFtsQuery("cats And dogs")).toBe(
      '"cats" OR "And" OR "dogs"',
    );
    expect(buildFtsQuery("foo Near bar")).toBe(
      '"foo" OR "Near" OR "bar"',
    );
  });

  it("keeps words that merely contain an operator substring", () => {
    withFallback();
    expect(buildFtsQuery("ANDROID phone")).toBe('"ANDROID" OR "phone"');
    expect(buildFtsQuery("notation only")).toBe('"notation" OR "only"');
    expect(buildFtsQuery("NEARBY signal")).toBe('"NEARBY" OR "signal"');
  });

  it("returns null when input reduces to nothing after sanitization", () => {
    withFallback();
    expect(buildFtsQuery("AND OR NOT NEAR")).toBeNull();
  });

  it("strips embedded double quotes so tokens never emit a nested quote", () => {
    withFallback();
    // The regex fallback splits on non-\p{L}\p{N}_, so `"` is already a
    // separator — assert the invariant explicitly.
    expect(buildFtsQuery('a"b c')).toBe('"a" OR "b" OR "c"');
  });
});

describe("buildFtsQuery — jieba path", () => {
  it("filters residual UPPERCASE reserved-keyword tokens from the tokenizer", () => {
    // Defensive: our own sanitization already removed operators from the
    // raw string, but this guards against tokenizer changes that might
    // re-emit an operator after segmentation.
    _setJiebaForTest({
      cutForSearch: (text: string) => text.split(/\s+/),
    });
    expect(buildFtsQuery("alpha AND beta")).toBe('"alpha" OR "beta"');
    expect(buildFtsQuery("alpha  beta  NOT  gamma")).toBe(
      '"alpha" OR "beta" OR "gamma"',
    );
  });

  it("preserves lowercase tokens from the tokenizer output", () => {
    _setJiebaForTest({
      cutForSearch: (text: string) => text.split(/\s+/),
    });
    expect(buildFtsQuery("alpha and beta")).toBe(
      '"alpha" OR "and" OR "beta"',
    );
  });

  it("de-duplicates and OR-joins jieba output", () => {
    _setJiebaForTest({
      cutForSearch: () => ["北京", "烤鸭", "北京", "北京烤鸭"],
    });
    expect(buildFtsQuery("北京烤鸭")).toBe(
      '"北京" OR "烤鸭" OR "北京烤鸭"',
    );
  });
});

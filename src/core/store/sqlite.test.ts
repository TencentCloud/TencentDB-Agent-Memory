/**
 * Unit tests for FTS5 sanitization in `src/core/store/sqlite.ts`.
 *
 * These tests exercise `sanitizeFtsInput()`, `sanitizeFtsToken()` and
 * `buildFtsQuery()` (in fallback mode — jieba stubbed to null).
 *
 * The behavior under test corresponds to the four acceptance levels of
 * issue #160:
 *   1. Basic escape — special characters are neutralized.
 *   2. Complete coverage — every FTS5 operator / syntax character / colset
 *      abuse has an explicit test, including NFKC full-width variants and
 *      word-boundary safe substrings (ANDROID, ORACLE, NEARBY, SCANNER).
 *   3. Recall — exercised in `sqlite.recall.test.ts` with a real FTS5 table.
 *   4. Whitelist / parameterization — `sanitizeFtsToken()` is the per-token
 *      unicode-letter whitelist; downstream `searchL1Fts()` uses prepared
 *      statements with `MATCH ?` placeholder (verified in the recall suite).
 *
 * Golden outputs here were produced by inspecting `scripts/temp-probe.mjs` so
 * any change to `sanitizeFtsInput()` that affects whitespace counts will
 * surface as a failing test (and force a deliberate update of the fixture).
 */

import { describe, expect, it, beforeEach } from "vitest";

import {
  _setJiebaForTest,
  buildFtsQuery,
  sanitizeFtsInput,
  sanitizeFtsToken,
} from "./sqlite.js";

beforeEach(() => {
  // Force fallback (regex) tokenizer for determinism in this suite.
  _setJiebaForTest(null);
});

describe("sanitizeFtsInput (sanitization layer 1)", () => {
  it("returns empty string for empty input", () => {
    expect(sanitizeFtsInput("")).toBe("");
  });

  it("preserves benign Chinese / English / digits", () => {
    expect(sanitizeFtsInput("用户 编程 TypeScript 2026")).toBe(
      "用户 编程 TypeScript 2026",
    );
  });

  it("preserves FTS5 reserved words as literal search text", () => {
    expect(sanitizeFtsInput("alpha \uFF21\uFF2E\uFF24 beta")).toBe(
      "alpha AND beta",
    );
    expect(sanitizeFtsInput("alpha Or beta")).toBe("alpha Or beta");
    expect(sanitizeFtsInput("alpha not beta")).toBe("alpha not beta");
    expect(sanitizeFtsInput("alpha Near beta")).toBe("alpha Near beta");
  });

  it("does NOT touch substrings that contain reserved words", () => {
    expect(sanitizeFtsInput("ANDROID")).toBe("ANDROID");
    expect(sanitizeFtsInput("SCANNER")).toBe("SCANNER");
    expect(sanitizeFtsInput("ORACLE")).toBe("ORACLE");
    expect(sanitizeFtsInput("NEARBY")).toBe("NEARBY");
    expect(sanitizeFtsInput("android 12")).toBe("android 12");
  });

  it("strips FTS5 syntax chars: \" ' * ( )", () => {
    // Syntax characters become separators and are collapsed by token extraction.
    expect(sanitizeFtsInput('alpha "beta" gamma')).toBe("alpha beta gamma");
    expect(sanitizeFtsInput("alpha'beta")).toBe("alpha beta");
    expect(sanitizeFtsInput("alpha*")).toBe("alpha");
    expect(sanitizeFtsInput("(alpha) (beta)")).toBe("alpha beta");
  });

  it("turns column-filter syntax into literal tokens", () => {
    expect(sanitizeFtsInput("content:foo")).toBe("content foo");
    expect(sanitizeFtsInput("-content:foo")).toBe("content foo");
    expect(sanitizeFtsInput("message:hello world")).toBe("message hello world");
    expect(sanitizeFtsInput("-session:abc")).toBe("session abc");
    expect(sanitizeFtsInput("actor:user1 topic:food")).toBe(
      "actor user1 topic food",
    );
  });

  it("normalizes full-width Unicode variants via NFKC", () => {
    expect(sanitizeFtsInput("alpha \uFF21\uFF2E\uFF24 beta")).toBe("alpha AND beta");
    expect(sanitizeFtsInput("alpha \uFF21\uFF2E\uFF24ROID beta")).toBe(
      "alpha ANDROID beta",
    );
  });

  it("handles tricky mixed inputs", () => {
    expect(sanitizeFtsInput('"alpha" OR "beta"')).toBe("alpha OR beta");
    expect(sanitizeFtsInput("(content:foo) OR (message:bar)")).toBe(
      "content foo OR message bar",
    );
  });

  it("collapses separators into single spaces", () => {
    expect(sanitizeFtsInput("hello    world")).toBe("hello world");
  });
});

describe("sanitizeFtsToken (sanitization layer 2 — per-token)", () => {
  it("returns null for empty input", () => {
    expect(sanitizeFtsToken("")).toBeNull();
  });

  it("wraps ASCII letters in phrase quotes", () => {
    expect(sanitizeFtsToken("alpha")).toBe('"alpha"');
  });

  it("preserves unicode letters and digits", () => {
    expect(sanitizeFtsToken("用户2026")).toBe('"用户2026"');
    expect(sanitizeFtsToken("東京_タワー")).toBe('"東京_タワー"');
  });

  it("drops pure-punctuation tokens", () => {
    expect(sanitizeFtsToken("***")).toBeNull();
    expect(sanitizeFtsToken("...")).toBeNull();
    expect(sanitizeFtsToken("()")).toBeNull();
  });

  it("quotes FTS5 reserved words as ordinary phrase tokens", () => {
    expect(sanitizeFtsToken("AND")).toBe('"AND"');
    expect(sanitizeFtsToken("or")).toBe('"or"');
    expect(sanitizeFtsToken("Not")).toBe('"Not"');
    expect(sanitizeFtsToken("near")).toBe('"near"');
  });

  it("strips embedded punctuation but keeps word fragments", () => {
    expect(sanitizeFtsToken("foo:bar")).toBe('"foo" OR "bar"');
    expect(sanitizeFtsToken("C++")).toBe('"C"');
  });

  it("filters embedded double-quotes via the unicode whitelist", () => {
    // Quotes are filtered out by the unicode-letter/number whitelist; only
    // the letters around them survive.  This is intentional — quotes do not
    // survive into the index token stream because they are FTS5 syntax.
    expect(sanitizeFtsToken('a"b')).toBe('"a" OR "b"');
    expect(sanitizeFtsToken('he said "hi"')).toBe('"he" OR "said" OR "hi"');
  });
});

describe("buildFtsQuery (fallback mode)", () => {
  it("returns null for empty / null / undefined input", () => {
    expect(buildFtsQuery("")).toBeNull();
    expect(buildFtsQuery(null)).toBeNull();
    expect(buildFtsQuery(undefined)).toBeNull();
  });

  it("returns null when nothing survives sanitization", () => {
    expect(buildFtsQuery("***")).toBeNull();
    expect(buildFtsQuery("(())")).toBeNull();
  });

  it("searches reserved operators as literal user terms", () => {
    expect(buildFtsQuery("AND")).toBe('"AND"');
    expect(buildFtsQuery("AND OR NOT NEAR")).toBe(
      '"AND" OR "OR" OR "NOT" OR "NEAR"',
    );
  });

  it("quotes reserved operators instead of letting them control MATCH", () => {
    expect(buildFtsQuery("alpha AND NOT beta")).toBe(
      '"alpha" OR "AND" OR "NOT" OR "beta"',
    );
    expect(buildFtsQuery("alpha Or beta")).toBe('"alpha" OR "Or" OR "beta"');
  });

  it("escapes phrase-quote injection", () => {
    expect(buildFtsQuery('alpha" OR "beta')).toBe(
      '"alpha" OR "OR" OR "beta"',
    );
  });

  it("neutralizes the prefix-wildcard abuse path", () => {
    expect(buildFtsQuery("alpha*")).toBe('"alpha"');
  });

  it("neutralizes parenthesized group expressions", () => {
    expect(buildFtsQuery("(alpha) OR (beta)")).toBe(
      '"alpha" OR "OR" OR "beta"',
    );
  });

  it("neutralizes column-filter syntax", () => {
    // `content:` is stripped — its letters also leak in via the regex via
    // the whitespace separator, but the unicode-letter whitelist inside
    // sanitizeFtsToken filters `content` back out ONLY when it is a
    // stand-alone token.  In this query `content:` is collapsed to a space
    // by `sanitizeFtsInput` so we only ever see `foo` and `bar`.
    expect(buildFtsQuery("content:foo bar")).toBe(
      '"content" OR "foo" OR "bar"',
    );
    expect(buildFtsQuery("-content:foo")).toBe('"content" OR "foo"');
  });

  it("handles NFKC full-width operator variants", () => {
    expect(buildFtsQuery("alpha \uFF21\uFF2E\uFF24 beta")).toBe(
      '"alpha" OR "AND" OR "beta"',
    );
  });

  it("does NOT over-strip benign substrings (word-boundary safe)", () => {
    expect(buildFtsQuery("ANDROID")).toBe('"ANDROID"');
    expect(buildFtsQuery("ORACLE")).toBe('"ORACLE"');
    expect(buildFtsQuery("NEARBY")).toBe('"NEARBY"');
  });

  it("returns Chinese / mixed language query verbatim (only stripped syntax)", () => {
    expect(buildFtsQuery("用户 TypeScript 编程")).toBe(
      '"用户" OR "TypeScript" OR "编程"',
    );
  });

  it("deduplicates tokens after sanitization", () => {
    expect(buildFtsQuery("alpha alpha alpha")).toBe('"alpha"');
  });

  it("preserves reserved words even when surrounded by other tokens", () => {
    expect(buildFtsQuery("foo AND bar AND baz")).toBe(
      '"foo" OR "AND" OR "bar" OR "baz"',
    );
  });

  it("literalizes a long chain of mixed operators / syntax / junk", () => {
    // All user text becomes quoted literal tokens; no FTS5 operator survives.
    expect(buildFtsQuery('alpha AND NOT "beta" OR (gamma) NEAR hello')).toBe(
      [
        '"alpha"',
        '"AND"',
        '"NOT"',
        '"beta"',
        '"OR"',
        '"gamma"',
        '"NEAR"',
        '"hello"',
      ].join(" OR "),
    );
  });
});

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import {
  buildFtsQuery,
  sanitizeFtsToken,
  _setJiebaForTest,
  _resetJiebaForTest,
} from "./sqlite.js";

// ============================================================
// Test helpers: pin jieba state so behaviour is deterministic.
//   - useFallback():  force the Unicode-regex branch (no jieba).
//   - useMockJieba(): inject a controllable segmenter to exercise the
//     jieba branch, including tokens that still contain special chars.
// ============================================================
const useFallback = (): void => _setJiebaForTest(null);
const useMockJieba = (cut: (t: string) => string[]): void =>
  _setJiebaForTest({ cutForSearch: (t: string, _hmm: boolean) => cut(t) });

beforeEach(() => _resetJiebaForTest());
afterEach(() => _resetJiebaForTest());

// ============================================================
// sanitizeFtsToken — the core injection defence, tested in isolation.
// Every reserved FTS5 character/keyword must collapse to a literal.
// ============================================================
describe("sanitizeFtsToken — single-token injection defence", () => {
  it("wraps a normal token as a literal phrase", () => {
    expect(sanitizeFtsToken("foo")).toBe('"foo"');
    expect(sanitizeFtsToken("固态电池")).toBe('"固态电池"');
  });

  it("escapes double quotes as \"\" (NOT stripped) — preserves literal content", () => {
    // Core fix: the old inline `replaceAll('"', "")` turned a"b into ab,
    // silently dropping a character and hurting recall.
    expect(sanitizeFtsToken('a"b')).toBe('"a""b"');
    expect(sanitizeFtsToken('"quoted"')).toBe('"""quoted"""');
    expect(sanitizeFtsToken('a""b')).toBe('"a""""b"');
  });

  it("neutralises every FTS5 operator to a literal inside the phrase", () => {
    expect(sanitizeFtsToken("foo*")).toBe('"foo*"'); // prefix wildcard
    expect(sanitizeFtsToken("(a")).toBe('"(a"'); // unbalanced grouping
    expect(sanitizeFtsToken(")")).toBe('")"'); // grouping
    expect(sanitizeFtsToken("OR")).toBe('"OR"'); // boolean keyword
    expect(sanitizeFtsToken("NEAR")).toBe('"NEAR"'); // proximity keyword
    expect(sanitizeFtsToken("a:b")).toBe('"a:b"'); // column qualifier
    expect(sanitizeFtsToken("^a")).toBe('"^a"'); // caret
    expect(sanitizeFtsToken("-a")).toBe('"-a"'); // negation
  });

  it("leaves single quotes untouched (literal inside a double-quoted phrase)", () => {
    expect(sanitizeFtsToken("it's")).toBe('"it\'s"');
  });

  it("always produces a balanced phrase (even quote count) — never breaks FTS5 syntax", () => {
    const cases = ['a"b', "foo*", "(x", "OR", "", 'a""b', '"', '""'];
    for (const c of cases) {
      const out = sanitizeFtsToken(c);
      expect(out.startsWith('"')).toBe(true);
      expect(out.endsWith('"')).toBe(true);
      const quoteCount = (out.match(/"/g) ?? []).length;
      // 2 wrapping quotes + 2 per escaped inner quote ⇒ always even.
      expect(quoteCount % 2).toBe(0);
    }
  });
});

// ============================================================
// buildFtsQuery — fallback path (jieba unavailable).
// The `[\p{L}\p{N}_]+` whitelist split strips most operators at the
// tokenisation stage; quoting is the second line of defence.
// ============================================================
describe("buildFtsQuery — fallback mode (no jieba)", () => {
  beforeEach(useFallback);

  it("joins normal keywords with OR", () => {
    expect(buildFtsQuery("hello world")).toBe('"hello" OR "world"');
  });

  it("handles a single keyword", () => {
    expect(buildFtsQuery("foo")).toBe('"foo"');
  });

  it("returns null for empty / whitespace / punctuation-only input (avoids empty MATCH)", () => {
    expect(buildFtsQuery("")).toBeNull();
    expect(buildFtsQuery("   ")).toBeNull();
    expect(buildFtsQuery("\t\n")).toBeNull();
    expect(buildFtsQuery("!!! ??? ***")).toBeNull();
  });

  it("neutralises boolean OR (old split+join would have changed semantics)", () => {
    expect(buildFtsQuery("a OR b")).toBe('"a" OR "OR" OR "b"');
  });

  it("strips prefix wildcard `*` so `foo*` cannot match every foo-prefixed token", () => {
    expect(buildFtsQuery("foo*")).toBe('"foo"');
    expect(buildFtsQuery("foo* bar")).toBe('"foo" OR "bar"');
  });

  it("survives unbalanced parentheses (no MATCH syntax error)", () => {
    expect(buildFtsQuery("(test")).toBe('"test"');
    expect(buildFtsQuery("a) b")).toBe('"a" OR "b"');
  });

  it("breaks the column qualifier `:` so `title:secret` cannot target a column", () => {
    expect(buildFtsQuery("title:secret")).toBe('"title" OR "secret"');
  });

  it("fully neutralises a combined payload", () => {
    // `*`, spaces, `(`, `)` are all separators under the whitelist split;
    // AND/OR become literal quoted tokens.
    expect(buildFtsQuery("a* OR (b AND c)")).toBe(
      '"a" OR "OR" OR "b" OR "AND" OR "c"',
    );
  });

  it("keeps CJK runs as single tokens in fallback mode", () => {
    expect(buildFtsQuery("固态电池")).toBe('"固态电池"');
    expect(buildFtsQuery("固态 电池")).toBe('"固态" OR "电池"');
  });
});

// ============================================================
// buildFtsQuery — jieba path.
// jieba's filter only requires "contains a letter/digit"; it does NOT
// strip special chars, so these cases are where sanitizeFtsToken matters
// most.
// ============================================================
describe("buildFtsQuery — jieba mode (mocked segmenter)", () => {
  it("wraps segmented CJK tokens with OR", () => {
    useMockJieba(() => ["用户", "喜欢", "编程"]);
    expect(buildFtsQuery("用户喜欢编程")).toBe('"用户" OR "喜欢" OR "编程"');
  });

  it("core: tokens containing special chars are still made safe by sanitize", () => {
    // Simulate jieba returning tokens that still embed " and * and a boolean.
    useMockJieba(() => ['a"b', "foo*", "OR"]);
    expect(buildFtsQuery('a"b foo* OR')).toBe('"a""b" OR "foo*" OR "OR"');
  });

  it("filters Chinese stop-words", () => {
    useMockJieba(() => ["用户", "的", "编程"]); // "的" is a stop-word
    expect(buildFtsQuery("用户的编程")).toBe('"用户" OR "编程"');
  });

  it("deduplicates tokens (cutForSearch may emit sub-words twice)", () => {
    useMockJieba(() => ["北京", "烤鸭", "北京烤鸭", "北京"]);
    expect(buildFtsQuery("北京烤鸭")).toBe('"北京" OR "烤鸭" OR "北京烤鸭"');
  });

  it("returns null when every token is a stop-word / punctuation", () => {
    useMockJieba(() => ["的", "了"]);
    expect(buildFtsQuery("的了")).toBeNull();
  });
});

// ============================================================
// Recall — escaping must not shrink the match set for normal queries.
// ============================================================
describe("recall — escaping does not degrade matching", () => {
  beforeEach(useFallback);

  it("every segment of a normal query is still a literal phrase match", () => {
    const cases = ["react vue", "error handling", "数据库 索引"];
    for (const c of cases) {
      const q = buildFtsQuery(c);
      expect(q).not.toBeNull();
      for (const seg of q!.split(" OR ")) {
        expect(seg.startsWith('"')).toBe(true);
        expect(seg.endsWith('"')).toBe(true);
      }
    }
  });

  it("double-quote content is preserved (escape) rather than merged (strip)", () => {
    // Escape:  say"hi  →  "say""hi"   → FTS5 matches phrase [say, hi]
    // Old strip: say"hi →  "sayhi"     → matches non-existent token "sayhi" (recall loss)
    useMockJieba(() => ['say"hi']);
    expect(buildFtsQuery('say"hi')).toBe('"say""hi"');
  });
});

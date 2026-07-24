import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { buildFtsQuery, _resetJiebaForTest, _setJiebaForTest } from "./sqlite.js";

/**
 * Security regression tests for `buildFtsQuery()` — issue #160.
 *
 * `buildFtsQuery()` turns raw user text into an FTS5 MATCH expression that is
 * bound as a parameter to `... WHERE l1_fts MATCH ?` (see `searchL1Fts` /
 * `searchL0Fts` below). Because SQLite treats the *value* of a MATCH
 * parameter as its own mini query language, binding it via `?` prevents SQL
 * injection but does NOT prevent FTS5 *query-syntax* injection: a user who
 * types `AND`, `OR`, `NOT`, `NEAR`, parentheses, `:`, `^` or `*` can still
 * change the boolean structure of the search (or crash it with a syntax
 * error) unless every token is escaped before being joined.
 *
 * `buildFtsQuery()` currently neutralizes this by wrapping every token in
 * double quotes and OR-joining them. The canonical hardening in PR #178 may
 * additionally remove standalone operators before tokenization. This suite
 * intentionally accepts either safe outcome and verifies it for every FTS5
 * reserved word, syntax character, nested/combined attempt, and assorted
 * boundary input — both through direct assertions on the generated query and
 * by running it against a real in-memory FTS5 table. That checks "doesn't
 * throw" and "doesn't over-match" against SQLite's actual parser rather than
 * only against our assumptions about it.
 */

afterEach(() => {
  _resetJiebaForTest();
});

// ── Test harness ────────────────────────────────────────────────────────

/**
 * Deterministic fake jieba: splits on any run of non-word characters,
 * approximating how the real `@node-rs/jieba` addon treats ASCII
 * punctuation (verified empirically: it splits `"content:cat"` into
 * `["content", ":", "cat"]`, same boundary behavior as the regex fallback).
 * Used so the "jieba available" code path is exercised without depending on
 * the native addon being installed in every CI environment — the addon's
 * Chinese segmentation quality isn't what's under test here, the downstream
 * escaping logic is.
 */
function useFakeJieba(): void {
  _setJiebaForTest({
    cutForSearch: (text: string) => text.split(/[^\p{L}\p{N}_]+/u).filter(Boolean),
  });
}

function useFallbackTokenizer(): void {
  _setJiebaForTest(null);
}

/**
 * Strips every quoted phrase out of a generated FTS5 query, leaving behind
 * only what `buildFtsQuery()` did NOT escape. In a correctly-escaped query
 * the only thing left should be the literal " OR " joiners it inserts
 * between phrases — any other bareword (AND/NOT/NEAR) or syntax character
 * (`(` `)` `:` `^` `*`) means an operator or special character leaked
 * outside of quotes and could still be interpreted as FTS5 syntax.
 */
function unquotedRemainder(ftsQuery: string): string {
  return ftsQuery.replace(/"[^"]*"/g, " ").trim();
}

function expectFullyEscaped(ftsQuery: string): void {
  const remainder = unquotedRemainder(ftsQuery);
  const strayTokens = remainder.split(/\s+/).filter(Boolean);
  for (const tok of strayTokens) {
    expect(tok, `bare unescaped token "${tok}" leaked in: ${ftsQuery}`).toBe("OR");
  }
  expect(remainder, `stray FTS5 syntax character leaked in: ${ftsQuery}`).not.toMatch(/[()^*:]/);
  // Quotes must be balanced — an odd count means a phrase never closed,
  // which would let everything after it be parsed as bare syntax.
  expect((ftsQuery.match(/"/g) ?? []).length % 2, `unbalanced quotes in: ${ftsQuery}`).toBe(0);
}

/**
 * Runs `ftsQuery` as a real `MATCH` against an in-memory FTS5 table seeded
 * with `docs`, mirroring the `content MATCH ?` pattern used by
 * `stmtL1FtsSearch` / `stmtL0FtsSearch` in production. Throws if SQLite's
 * own FTS5 parser rejects the query — i.e. exactly the failure mode that
 * `VectorStore.searchL1Fts()` silently swallows (logs + returns `[]`) in
 * production, which is why we assert directly against the engine here
 * instead of only against the fault-tolerant wrapper.
 */
function runAgainstRealFts(ftsQuery: string, docs: string[]): string[] {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE VIRTUAL TABLE t USING fts5(content)");
    const insert = db.prepare("INSERT INTO t(content) VALUES (?)");
    for (const doc of docs) insert.run(doc);
    const rows = db.prepare("SELECT content FROM t WHERE t MATCH ? ORDER BY content").all(ftsQuery) as Array<{
      content: string;
    }>;
    return rows.map((r) => r.content);
  } finally {
    db.close();
  }
}

const MODES: Array<{ name: string; setup: () => void }> = [
  { name: "fallback (no jieba)", setup: useFallbackTokenizer },
  { name: "jieba (fake, deterministic tokenization)", setup: useFakeJieba },
];

// ── A/B: every FTS5 operator, alone and case-varied ─────────────────────

describe.each(MODES)("buildFtsQuery — reserved operators alone [$name]", ({ setup }) => {
  it.each(["AND", "and", "And", "aNd", "OR", "or", "NOT", "not", "NEAR", "near", "NeAr"])(
    "safely neutralizes bare operator %j",
    (raw) => {
      setup();
      const query = buildFtsQuery(raw);
      // Current main quotes the operator as a literal term. PR #178 strips it
      // before tokenization, producing null. Both outcomes keep raw FTS5
      // syntax from crossing the MATCH boundary.
      if (query === null) return;
      expectFullyEscaped(query);
      expect(query).toBe(`"${raw}"`);
    },
  );
});

describe.each(MODES)("buildFtsQuery — operator combinations & nesting [$name]", ({ setup }) => {
  const cases = [
    "a AND b OR NOT c",
    "(a OR b) AND NOT c",
    "a NEAR/5 b",
    "a NEAR/10 (b OR c)",
    "NOT NOT NOT a",
    "a AND AND b",
    "a OR OR OR b",
    "((((a))))",
    "a AND (b OR (c AND NOT d))",
  ];

  it.each(cases)("fully escapes %j", (raw) => {
    setup();
    const query = buildFtsQuery(raw);
    expect(query).not.toBeNull();
    expectFullyEscaped(query!);
  });

  it.each(cases)("never throws when run against real FTS5: %j", (raw) => {
    setup();
    const query = buildFtsQuery(raw)!;
    expect(() => runAgainstRealFts(query, ["a b c d trap_document_xyz"])).not.toThrow();
  });
});

// ── C: quotes, parens, wildcards, column filters, carets ────────────────

describe.each(MODES)("buildFtsQuery — special characters & syntax markers [$name]", ({ setup }) => {
  const cases: Array<[label: string, raw: string]> = [
    ["embedded double quote", 'foo"bar'],
    ["pre-quoted phrases", '"foo" "bar"'],
    ["parenthesized group", "(foo)"],
    ["trailing wildcard", "foo*"],
    ["leading wildcard", "*foo"],
    ["bare wildcard only", "*"],
    ["column filter on real column name", "content:foo"],
    ["column filter on unindexed column", "record_id:foo"],
    ["caret prefix", "^foo"],
    ["caret mid-token", "foo^bar"],
    ["backslash", "foo\\bar"],
    ["classic quote-breakout payload", '" OR "1"="1'],
    ["semicolon", "foo;bar"],
    ["double-double-quote escape attempt", '""foo""'],
    ["unterminated quote", '"foo'],
    ["mismatched parens", "(foo OR bar"],
  ];

  it.each(cases)("%s (%j) is fully escaped", (_label, raw) => {
    setup();
    const query = buildFtsQuery(raw);
    if (query === null) return; // empty token set is its own safe outcome
    expectFullyEscaped(query);
  });

  it.each(cases)("%s (%j) never throws against real FTS5", (_label, raw) => {
    setup();
    const query = buildFtsQuery(raw);
    if (query === null) return;
    expect(() => runAgainstRealFts(query, ["foo bar trap_document_xyz"])).not.toThrow();
  });
});

// ── D: boundary / edge-case inputs ───────────────────────────────────────

describe.each(MODES)("buildFtsQuery — boundary inputs [$name]", ({ setup }) => {
  it("empty string returns null", () => {
    setup();
    expect(buildFtsQuery("")).toBeNull();
  });

  it("whitespace-only returns null", () => {
    setup();
    expect(buildFtsQuery("   \t\n  ")).toBeNull();
  });

  it("pure-operator input is either removed or fully escaped", () => {
    setup();
    const query = buildFtsQuery("AND OR NOT NEAR");
    if (query !== null) expectFullyEscaped(query);
  });

  it("single character survives", () => {
    setup();
    expect(buildFtsQuery("a")).toBe('"a"');
  });

  it("numeric-only input survives", () => {
    setup();
    const query = buildFtsQuery("12345");
    expect(query).not.toBeNull();
    expectFullyEscaped(query!);
  });

  it("mixed CJK + English + operators is fully escaped", () => {
    setup();
    const query = buildFtsQuery("hello 世界 AND 你好 OR world");
    expect(query).not.toBeNull();
    expectFullyEscaped(query!);
  });

  it("emoji input does not throw and is fully escaped (or null)", () => {
    setup();
    const query = buildFtsQuery("😀🎉 AND 🚀");
    if (query !== null) expectFullyEscaped(query);
  });

  it("embedded NUL / control characters do not throw", () => {
    setup();
    expect(() => buildFtsQuery("foo\u0000bar\u0001AND\u0002baz")).not.toThrow();
  });

  it("very long input (5000 repeated operators) completes safely", () => {
    setup();
    const raw = new Array(5000).fill("AND").join(" ");
    const query = buildFtsQuery(raw);
    if (query !== null) expectFullyEscaped(query);
  });

  it("very long input never throws against real FTS5", () => {
    setup();
    const raw = new Array(2000).fill("a OR b AND c NOT d NEAR e").join(" ");
    const query = buildFtsQuery(raw)!;
    expect(() => runAgainstRealFts(query, ["trap_document_xyz"])).not.toThrow();
  });
});

describe("buildFtsQuery — underscore-only input (letter/digit filter asymmetry)", () => {
  // The two tokenization paths disagree on whether a token with no letters
  // or digits (e.g. "___") survives: the jieba path explicitly filters such
  // tokens out, the regex-fallback path does not. Neither behavior is a
  // security issue (an all-underscore token can't carry FTS5 syntax either
  // way), but the difference is worth pinning so a future change doesn't
  // silently alter it in one path without the other.
  it("fallback tokenizer keeps a token made only of underscores", () => {
    useFallbackTokenizer();
    expect(buildFtsQuery("___")).toBe('"___"');
  });

  it("jieba tokenizer drops a token with no letters or digits", () => {
    useFakeJieba();
    expect(buildFtsQuery("___")).toBeNull();
  });
});

// ── E: regression — normal keyword search must not be over-sanitized ────

describe.each(MODES)("buildFtsQuery — normal search is not over-sanitized [$name]", ({ setup }) => {
  it("plain multi-word English query", () => {
    setup();
    expect(buildFtsQuery("python tutorial")).toBe('"python" OR "tutorial"');
  });

  it.each(["android", "organize", "notable", "nearby", "andiron", "orbit", "understand", "corner"])(
    "word containing an operator as a substring is kept whole: %j",
    (word) => {
      setup();
      // A correct implementation only strips AND/OR/NOT/NEAR as whole
      // (word-boundary) tokens; it must never truncate or mangle a normal
      // word just because an operator's letters appear inside it.
      expect(buildFtsQuery(word)).toBe(`"${word}"`);
    },
  );

  it("does not duplicate the OR joiner or drop tokens for a benign multi-word query", () => {
    setup();
    const query = buildFtsQuery("memory agent architecture")!;
    expect(query.split(" OR ").filter((t) => !["OR", '"OR"'].includes(t))).toHaveLength(3);
    expect(query).toContain('"memory"');
    expect(query).toContain('"agent"');
    expect(query).toContain('"architecture"');
  });
});

// ── F: integration — behavior against a real FTS5 engine ────────────────

describe.each(MODES)("buildFtsQuery — real FTS5 engine safety [$name]", ({ setup }) => {
  const corpus = [
    "the cat sat on the mat",
    "a dog ran in the park",
    "completely unrelated trap document xyz789",
    "and or not near are common english words",
  ];

  it("operator-laden query matches literal term occurrences only, never everything", () => {
    setup();
    const query = buildFtsQuery("cat AND dog")!;
    const results = runAgainstRealFts(query, corpus);
    // Whether AND is stripped (PR #178) or retained as a quoted literal
    // (current main), the real content terms remain broad OR matches and the
    // unrelated trap document must never match.
    expect(results).toContain("the cat sat on the mat");
    expect(results).toContain("a dog ran in the park");
    expect(results).not.toContain("completely unrelated trap document xyz789");
  });

  it("column-filter injection attempt does not scope the search to another column", () => {
    setup();
    const query = buildFtsQuery("content:cat")!;
    const results = runAgainstRealFts(query, corpus);
    // `content:` is stripped down to the literal words "content" and "cat";
    // it must not be interpreted as an FTS5 column filter.
    expect(results).toContain("the cat sat on the mat");
    expect(results).not.toContain("completely unrelated trap document xyz789");
  });

  it("quote-breakout payload does not escape into a match-everything query", () => {
    setup();
    const query = buildFtsQuery('" OR "1"="1')!;
    const results = runAgainstRealFts(query, corpus);
    expect(results).not.toContain("completely unrelated trap document xyz789");
    expect(results.length).toBeLessThan(corpus.length);
  });

  it("NEAR/N proximity syntax is neutralized, not interpreted as a proximity operator", () => {
    setup();
    const query = buildFtsQuery("cat NEAR/5 dog")!;
    expect(() => runAgainstRealFts(query, corpus)).not.toThrow();
    const results = runAgainstRealFts(query, corpus);
    expect(results).not.toContain("completely unrelated trap document xyz789");
  });

  it("benign query recall is unaffected: exact expected matches returned", () => {
    setup();
    const query = buildFtsQuery("cat dog")!;
    const results = runAgainstRealFts(query, corpus);
    expect(results.sort()).toEqual(["a dog ran in the park", "the cat sat on the mat"].sort());
  });

  it("wildcard-only input produces null and is simply skipped by callers", () => {
    setup();
    expect(buildFtsQuery("*")).toBeNull();
  });
});

// ── Real @node-rs/jieba integration (skipped if the native addon is absent) ──

let realJiebaAvailable = true;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { Jieba } = require("@node-rs/jieba");
  const { dict } = require("@node-rs/jieba/dict");
  Jieba.withDict(dict);
} catch {
  realJiebaAvailable = false;
}

describe.runIf(realJiebaAvailable)("buildFtsQuery — real @node-rs/jieba segmentation", () => {
  it("Chinese operator-shaped substrings inside real words are not stripped", () => {
    _resetJiebaForTest();
    // "近" (near) and similar CJK characters are unrelated to the ASCII
    // FTS5 keyword NEAR — segmentation must not confuse the two.
    const query = buildFtsQuery("用户 AND TypeScript OR 记忆")!;
    expectFullyEscaped(query);
    expect(query).toContain('"用户"');
    expect(query).toContain('"TypeScript"');
    expect(query).toContain('"记忆"');
  });

  it("pure Chinese stop-word input returns null", () => {
    _resetJiebaForTest();
    expect(buildFtsQuery("的了在是")).toBeNull();
  });

  it("mixed operator + stop-word + real content is fully escaped and never throws", () => {
    _resetJiebaForTest();
    const query = buildFtsQuery("的 AND 用户喜欢编程 OR 了 NOT TypeScript NEAR 记忆")!;
    expectFullyEscaped(query);
    expect(() =>
      runAgainstRealFts(query, ["用户喜欢编程和TypeScript", "completely unrelated trap document xyz789"]),
    ).not.toThrow();
  });
});

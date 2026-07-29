import { afterEach, describe, expect, it } from "vitest";
import {
  buildFtsQuery,
  toFtsPhrase,
  _resetJiebaForTest,
  _setJiebaForTest,
} from "./sqlite.js";

afterEach(() => {
  _resetJiebaForTest();
});

describe("toFtsPhrase", () => {
  it("wraps a plain token in double quotes", () => {
    expect(toFtsPhrase("android")).toBe('"android"');
  });

  it("escapes embedded double quotes by doubling them (FTS5 rule)", () => {
    // A raw quote must be doubled, not deleted — deletion changes the term.
    expect(toFtsPhrase('a"b')).toBe('"a""b"');
    expect(toFtsPhrase('say "hi"')).toBe('"say ""hi"""');
  });
});

describe("buildFtsQuery — fallback (regex) path", () => {
  // Force the jieba-free path for deterministic tokenization.
  function useFallback() {
    _setJiebaForTest(null);
  }

  it("tokenizes and OR-joins quoted terms", () => {
    useFallback();
    expect(buildFtsQuery("旅行计划 API")).toBe('"旅行计划" OR "API"');
  });

  it("neutralizes bareword FTS5 operators by quoting them as literals", () => {
    useFallback();
    // AND / OR / NOT are kept as tokens but quoted, so FTS5 sees literal phrases,
    // not boolean operators. The only unquoted operator is our own OR join.
    expect(buildFtsQuery("cats AND dogs")).toBe('"cats" OR "AND" OR "dogs"');
    expect(buildFtsQuery("a NOT b")).toBe('"a" OR "NOT" OR "b"');
  });

  it("does NOT corrupt ordinary words that contain operator substrings", () => {
    useFallback();
    // This is exactly what the naive `/(AND|OR|NOT|NEAR)/gi` strip gets wrong:
    // it would turn android→roid, network→netwk, corner→cner, notebook→ebook.
    expect(buildFtsQuery("android network corner notebook")).toBe(
      '"android" OR "network" OR "corner" OR "notebook"',
    );
  });

  it("strips FTS5 special characters via tokenization (quotes, star, colon, parens)", () => {
    useFallback();
    // A classic injection attempt — none of the special chars survive tokenization,
    // and every surviving token is quoted.
    expect(buildFtsQuery('title:foo OR bar*')).toBe('"title" OR "foo" OR "OR" OR "bar"');
    expect(buildFtsQuery('x" OR "1"="1')).toBe('"x" OR "OR" OR "1" OR "1"');
  });

  it("returns null for empty / punctuation-only input", () => {
    useFallback();
    expect(buildFtsQuery("")).toBeNull();
    expect(buildFtsQuery("   ")).toBeNull();
    expect(buildFtsQuery('"()*:-')).toBeNull();
  });
});

describe("buildFtsQuery — jieba path escaping", () => {
  it("escapes embedded quotes from a segmenter token instead of dropping them", () => {
    // Simulate a segmenter that yields a token containing a double quote.
    _setJiebaForTest({ cutForSearch: () => ['a"b', "c"] });
    expect(buildFtsQuery("ignored")).toBe('"a""b" OR "c"');
  });

  it("filters pure-punctuation tokens and de-duplicates", () => {
    _setJiebaForTest({ cutForSearch: () => ["foo", "foo", "!!!", "bar"] });
    expect(buildFtsQuery("ignored")).toBe('"foo" OR "bar"');
  });
});

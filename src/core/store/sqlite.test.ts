import { describe, expect, it } from "vitest";
import { buildFtsQuery } from "./sqlite.js";

describe("buildFtsQuery", () => {
  // ── Normal behavior (no regression) ──

  it("splits English words and OR-joins them as quoted phrases", () => {
    expect(buildFtsQuery("hello world")).toBe('"hello" OR "world"');
  });

  it("handles Unicode (Chinese) text via the fallback regex", () => {
    expect(buildFtsQuery("AI 智能 记忆")).toBe('"AI" OR "智能" OR "记忆"');
  });

  it("returns null for empty input", () => {
    expect(buildFtsQuery("")).toBeNull();
  });

  it("returns null for whitespace-only input", () => {
    expect(buildFtsQuery("   ")).toBeNull();
  });

  it("handles numbers and underscores in tokens", () => {
    expect(buildFtsQuery("test_123 v2.0")).toBe('"test_123" OR "v2" OR "0"');
  });

  // ── FTS5 special character sanitization ──
  //
  // The regex /["'()*]/g strips these from every token before quoting.
  // In the fallback path, the tokenizer /[\p{L}\p{N}_]+/gu already
  // excludes these characters — sanitization is a no-op for
  // fallback-produced tokens (belt-and-suspenders).
  // On the jieba path, these characters may pass through jieba's
  // segmenter and are removed here — the same sanitize logic applies.

  it("removes asterisk to prevent FTS5 prefix matching", () => {
    expect(buildFtsQuery("hello*")).toBe('"hello"');
    expect(buildFtsQuery("**test**")).toBe('"test"');
    expect(buildFtsQuery("*")).toBeNull();
    expect(buildFtsQuery("a* b c*")).toBe('"a" OR "b" OR "c"');
  });

  it("handles double quotes in input", () => {
    // Fallback regex excludes " so it acts as a word boundary
    expect(buildFtsQuery('he"llo')).toBe('"he" OR "llo"');
    // Surrounding quotes are naturally stripped by the regex match
    expect(buildFtsQuery('"admin"')).toBe('"admin"');
  });

  it("handles single quotes in input", () => {
    // Fallback regex excludes ' so it acts as a word boundary
    expect(buildFtsQuery("he'llo")).toBe('"he" OR "llo"');
    // Surrounding quotes are naturally stripped by the regex match
    expect(buildFtsQuery("'alone'")).toBe('"alone"');
  });

  it("handles parentheses in input", () => {
    // Fallback regex excludes ( ) so they act as word boundaries
    expect(buildFtsQuery("test(query)here")).toBe('"test" OR "query" OR "here"');
    expect(buildFtsQuery("(alone)")).toBe('"alone"');
  });

  it("removes all FTS5 special characters in combination", () => {
    const result = buildFtsQuery('hello "*world*" \'(test)\'');
    expect(result).toBe('"hello" OR "world" OR "test"');
  });

  it("returns null when input contains only special characters", () => {
    expect(buildFtsQuery('"()*\'"')).toBeNull();
    expect(buildFtsQuery("***")).toBeNull();
  });

  // ── FTS5 keyword operators (protected by quoting) ──
  // AND, OR, NOT, NEAR, +, - are only operators outside double quotes.
  // Since every token is wrapped in "..." they are treated as literal text.

  it("treats AND/OR/NOT as literal words inside quoted strings", () => {
    expect(buildFtsQuery("cat OR dog NOT mouse")).toBe(
      '"cat" OR "OR" OR "dog" OR "NOT" OR "mouse"',
    );
  });

  it("treats NEAR as a literal word inside quoted strings", () => {
    expect(buildFtsQuery("NEAR match")).toBe('"NEAR" OR "match"');
  });

  it("handles + and - prefix operators (inert inside quotes)", () => {
    // + and - are not matched by the fallback regex, so they naturally drop out
    expect(buildFtsQuery("+include -exclude")).toBe('"include" OR "exclude"');
  });
});

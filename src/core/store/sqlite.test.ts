import { afterEach, describe, it, expect } from "vitest";

import { buildFtsQuery, _resetJiebaForTest, _setJiebaForTest } from "./sqlite.js";

describe("buildFtsQuery", () => {
  afterEach(() => {
    _resetJiebaForTest();
  });

  // ─── FTS5 operator sanitization ──────────────────────────────────────────

  it("strips AND so the word itself is not a token", () => {
    const result = buildFtsQuery("hello AND world");
    expect(result).not.toBeNull();
    // The phrase terms must only be "hello" and "world", not "AND"
    const phrases = result!.split(" OR ").map((p) => p.slice(1, -1)); // strip outer quotes
    expect(phrases).toContain("hello");
    expect(phrases).toContain("world");
    expect(phrases).not.toContain("AND");
  });

  it("strips OR so the word itself is not a token", () => {
    const result = buildFtsQuery("cat OR dog");
    expect(result).not.toBeNull();
    const phrases = result!.split(" OR ").map((p) => p.slice(1, -1));
    expect(phrases).toContain("cat");
    expect(phrases).toContain("dog");
    expect(phrases).not.toContain("OR");
  });

  it("strips NOT so the word itself is not a token", () => {
    const result = buildFtsQuery("food NOT fish");
    expect(result).not.toBeNull();
    const phrases = result!.split(" OR ").map((p) => p.slice(1, -1));
    expect(phrases).toContain("food");
    expect(phrases).toContain("fish");
    expect(phrases).not.toContain("NOT");
  });

  it("strips NEAR so the word itself is not a token", () => {
    const result = buildFtsQuery("apple NEAR orange");
    expect(result).not.toBeNull();
    const phrases = result!.split(" OR ").map((p) => p.slice(1, -1));
    expect(phrases).toContain("apple");
    expect(phrases).toContain("orange");
    expect(phrases).not.toContain("NEAR");
  });

  // A standalone operator with no other tokens → null (no tokens survive sanitization)
  it("returns null when input is only an operator", () => {
    for (const op of ["AND", "and", "And", "OR", "or", "NOT", "not", "NEAR", "near"]) {
      expect(buildFtsQuery(op), `"${op}" alone should produce null`).toBeNull();
    }
  });

  it("strips operators case-insensitively in mixed input", () => {
    const mixedCase = ["and", "And", "or", "Or", "not", "Not", "near", "Near"];
    for (const form of mixedCase) {
      const result = buildFtsQuery(`hello ${form} world`);
      expect(result, `input with "${form}": result should not be null`).not.toBeNull();
      const phrases = result!.split(" OR ").map((p) => p.slice(1, -1));
      expect(phrases).toContain("hello");
      expect(phrases).toContain("world");
      expect(phrases).not.toContain(form);
      expect(phrases).not.toContain(form.toUpperCase());
    }
  });

  it("does not strip operator string when it appears as a substring", () => {
    // "android" contains "and" but is not a standalone keyword
    const result = buildFtsQuery("android");
    expect(result).not.toBeNull();
    const phrases = result!.split(" OR ").map((p) => p.slice(1, -1));
    expect(phrases).toContain("android");
  });

  it("does not strip operator-like substrings inside longer words", () => {
    // "notation" contains "not"; "border" contains "or"
    const result = buildFtsQuery("notation border");
    expect(result).not.toBeNull();
    const phrases = result!.split(" OR ").map((p) => p.slice(1, -1));
    expect(phrases).toContain("notation");
    expect(phrases).toContain("border");
  });

  // ─── Normal query behaviour ───────────────────────────────────────────────

  it("returns null for an empty string", () => {
    expect(buildFtsQuery("")).toBeNull();
  });

  it("returns null for whitespace-only input", () => {
    expect(buildFtsQuery("   ")).toBeNull();
  });

  it("returns null for punctuation-only input", () => {
    expect(buildFtsQuery("!@#$%^&*()")).toBeNull();
  });

  it("wraps each token in double quotes", () => {
    const result = buildFtsQuery("hello world");
    expect(result).not.toBeNull();
    for (const part of result!.split(" OR ")) {
      expect(part.trim()).toMatch(/^".*"$/);
    }
  });

  it("joins tokens with OR", () => {
    const result = buildFtsQuery("foo bar baz");
    expect(result).not.toBeNull();
    expect(result).toContain(" OR ");
  });

  it("handles a single token", () => {
    const result = buildFtsQuery("typescript");
    expect(result).toBe('"typescript"');
  });

  it("strips double-quotes inside token values to prevent FTS5 phrase injection", () => {
    // Quotes in user input must not appear as unescaped chars inside the phrase terms
    const result = buildFtsQuery('say "hello"');
    expect(result).not.toBeNull();
    const phrases = result!.split(" OR ").map((p) => p.slice(1, -1));
    for (const phrase of phrases) {
      expect(phrase).not.toContain('"');
    }
  });

  it("strips operators when mixed with other chars", () => {
    const result = buildFtsQuery("foo AND bar OR baz");
    expect(result).not.toBeNull();
    const phrases = result!.split(" OR ").map((p) => p.slice(1, -1));
    expect(phrases).not.toContain("AND");
    expect(phrases).not.toContain("OR");
    expect(phrases).toContain("foo");
    expect(phrases).toContain("bar");
    expect(phrases).toContain("baz");
  });

  // ─── jieba tokenization path ──────────────────────────────────────────────

  it("strips FTS5 operators before jieba tokenization", () => {
    const seen: string[] = [];
    _setJiebaForTest({
      cutForSearch(text: string): string[] {
        seen.push(text);
        return text.split(/\s+/).filter(Boolean);
      },
    });

    expect(buildFtsQuery("用户 AND TypeScript OR 记忆")).toBe(
      '"用户" OR "TypeScript" OR "记忆"',
    );
    // jieba must receive the sanitized text — operators replaced by spaces, not the original
    expect(seen).toEqual(["用户   TypeScript   记忆"]);
  });

  it("does not strip operator substrings embedded inside tokens via jieba", () => {
    const seen: string[] = [];
    _setJiebaForTest({
      cutForSearch(text: string): string[] {
        seen.push(text);
        return text.split(/\s+/).filter(Boolean);
      },
    });

    const result = buildFtsQuery("android notable nearby");
    expect(result).not.toBeNull();
    // android/notable/nearby must survive — they only contain operator substrings, not whole-word operators
    const phrases = result!.split(" OR ").map((p) => p.slice(1, -1));
    expect(phrases).toContain("android");
    expect(phrases).toContain("notable");
    expect(phrases).toContain("nearby");
    // jieba received the text unchanged (no whole-word operators present)
    expect(seen).toEqual(["android notable nearby"]);
  });
});

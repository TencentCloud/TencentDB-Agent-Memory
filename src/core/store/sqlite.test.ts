import { describe, it, expect, afterEach, beforeAll } from "vitest";
import {
  buildFtsQuery,
  _resetJiebaForTest,
  _setJiebaForTest,
} from "./sqlite.js";

describe("buildFtsQuery — FTS5 operator sanitization (jieba path)", () => {
  // Restore jieba to auto-initialise on first use (undo any prior override)
  _resetJiebaForTest();

  afterEach(() => {
    _resetJiebaForTest();
  });

  it("produces a quoted OR-joined query for normal input", () => {
    const result = buildFtsQuery("Hello World");
    expect(result).toBeTruthy();
    expect(result).toContain(" OR ");
  });

  it("strips standalone AND operator from tokens", () => {
    const result = buildFtsQuery("cats AND dogs")!;
    const tokens = result.split(" OR ").map((t) => t.replaceAll('"', ""));
    expect(tokens).not.toContain("AND");
    expect(tokens).toContain("cats");
    expect(tokens).toContain("dogs");
  });

  it("strips standalone OR operator from tokens", () => {
    const result = buildFtsQuery("apples OR oranges")!;
    const tokens = result.split(" OR ").map((t) => t.replaceAll('"', ""));
    expect(tokens).not.toContain("OR");
    expect(tokens).toContain("apples");
    expect(tokens).toContain("oranges");
  });

  it("strips standalone NOT operator from tokens", () => {
    const result = buildFtsQuery("coffee NOT tea")!;
    const tokens = result.split(" OR ").map((t) => t.replaceAll('"', ""));
    expect(tokens).not.toContain("NOT");
    expect(tokens).toContain("coffee");
    expect(tokens).toContain("tea");
  });

  it("strips standalone NEAR operator from tokens", () => {
    const result = buildFtsQuery("house NEAR river")!;
    const tokens = result.split(" OR ").map((t) => t.replaceAll('"', ""));
    expect(tokens).not.toContain("NEAR");
    expect(tokens).toContain("house");
    expect(tokens).toContain("river");
  });

  it("strips case-insensitive operators from tokens", () => {
    const result = buildFtsQuery("red And Blue oR Green nOt Yellow")!;
    const tokens = result.split(" OR ").map((t) => t.replaceAll('"', ""));
    expect(tokens).not.toContain("And");
    expect(tokens).not.toContain("oR");
    expect(tokens).not.toContain("nOt");
    expect(tokens).toContain("red");
    expect(tokens).toContain("Blue");
    expect(tokens).toContain("Green");
    expect(tokens).toContain("Yellow");
  });

  it("does NOT strip operators embedded inside words", () => {
    const result = buildFtsQuery("ANDROID ORAND NOTICE STAND NEARBY")!;
    const tokens = result.split(" OR ").map((t) => t.replaceAll('"', ""));
    expect(tokens).toContain("ANDROID");
    expect(tokens).toContain("ORAND");
    expect(tokens).toContain("NOTICE");
    expect(tokens).toContain("STAND");
    expect(tokens).toContain("NEARBY");
  });

  it("returns null for input that is only operators", () => {
    const result = buildFtsQuery("AND OR NOT NEAR");
    expect(result).toBeNull();
  });

  it("returns null for empty string", () => {
    const result = buildFtsQuery("");
    expect(result).toBeNull();
  });

  it("preserves normal Chinese + English mixed queries", () => {
    const result = buildFtsQuery("用户的 Python 项目使用 AND 连接条件")!;
    expect(result).toContain("Python");
    const tokens = result.split(" OR ").map((t) => t.replaceAll('"', ""));
    expect(tokens).not.toContain("AND");
  });
});

describe("buildFtsQuery — FTS5 operator sanitization (fallback / regex path)", () => {
  beforeAll(() => {
    _setJiebaForTest(null);
  });

  afterEach(() => {
    _resetJiebaForTest();
  });

  it("strips AND/OR/NOT/NEAR — no operator tokens in result", () => {
    const result = buildFtsQuery("find AND replace OR delete NOT keep NEAR here")!;
    const tokens = result.split(" OR ").map((t) => t.replaceAll('"', ""));
    expect(tokens).not.toContain("AND");
    expect(tokens).not.toContain("OR");
    expect(tokens).not.toContain("NOT");
    expect(tokens).not.toContain("NEAR");
  });

  it("returns null when all content is operators", () => {
    const result = buildFtsQuery("  AND   OR   NOT   ");
    expect(result).toBeNull();
  });
});

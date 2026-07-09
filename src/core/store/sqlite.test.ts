import { afterEach, describe, expect, it } from "vitest";

import { _resetJiebaForTest, _setJiebaForTest, buildFtsQuery } from "./sqlite.js";

describe("buildFtsQuery", () => {
  afterEach(() => {
    _resetJiebaForTest();
  });

  it("removes FTS5 operators before fallback tokenization", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("alpha OR beta AND NOT gamma NEAR delta")).toBe(
      '"alpha" OR "beta" OR "gamma" OR "delta"',
    );
  });

  it("removes FTS5 operators case-insensitively", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("alpha or beta aNd not gamma near delta")).toBe(
      '"alpha" OR "beta" OR "gamma" OR "delta"',
    );
  });

  it("returns null when input only contains FTS5 operators", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("AND or NOT near")).toBeNull();
  });

  it("keeps operator substrings inside ordinary words", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("orange candy android northeast nearby")).toBe(
      '"orange" OR "candy" OR "android" OR "northeast" OR "nearby"',
    );
  });

  it("removes operators before jieba tokenization", () => {
    let tokenizedText = "";

    _setJiebaForTest({
      cutForSearch(text: string): string[] {
        tokenizedText = text;
        return text.match(/[\p{L}\p{N}_]+/gu) ?? [];
      },
    });

    expect(buildFtsQuery("alpha OR beta")).toBe('"alpha" OR "beta"');
    expect(tokenizedText).not.toMatch(/\bOR\b/i);
  });

  it("filters operator tokens returned by a tokenizer", () => {
    _setJiebaForTest({
      cutForSearch(): string[] {
        return ["alpha", "OR", "beta", "NOT", "gamma"];
      },
    });

    expect(buildFtsQuery("alpha beta gamma")).toBe('"alpha" OR "beta" OR "gamma"');
  });

  it("normalizes FTS5 syntax characters from raw input into lexical tokens", () => {
    _setJiebaForTest(null);

    expect(
      buildFtsQuery('title:secret {title body}:memo foo* "quoted phrase" NEAR(alpha beta, 5)'),
    ).toBe(
      '"title" OR "secret" OR "title" OR "body" OR "memo" OR "foo" OR "quoted" OR "phrase" OR "alpha" OR "beta" OR "5"',
    );
  });

  it("normalizes FTS5 syntax characters returned by a tokenizer", () => {
    _setJiebaForTest({
      cutForSearch(): string[] {
        return [
          "title:secret",
          "{title body}:memo",
          "foo*",
          "\"quoted phrase\"",
          "NEAR(alpha beta, 5)",
          "OR",
        ];
      },
    });

    const query = buildFtsQuery("ignored raw text");

    expect(query).toBe(
      '"title" OR "secret" OR "body" OR "memo" OR "foo" OR "quoted" OR "phrase" OR "alpha" OR "beta" OR "5"',
    );
    expect(query).not.toMatch(/[:*(){}]/);
  });
});

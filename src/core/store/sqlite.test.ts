import { afterEach, describe, expect, it } from "vitest";

import { _resetJiebaForTest, _setJiebaForTest, buildFtsQuery } from "./sqlite.js";

describe("buildFtsQuery", () => {
  afterEach(() => {
    _resetJiebaForTest();
  });

  it("filters FTS5 boolean and NEAR operators in fallback tokenization", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("alpha OR beta AND NOT NEAR gamma")).toBe('"alpha" OR "beta" OR "gamma"');
  });

  it("removes FTS5 syntax characters while preserving searchable terms", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery('("alpha"* OR beta)')).toBe('"alpha" OR "beta"');
  });

  it("returns null when input contains only FTS5 operators and syntax", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery('" OR AND NOT NEAR ( ) *')).toBeNull();
  });

  it("keeps non-operator words that merely contain operator text", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("ordinary candy nearshore or")).toBe('"ordinary" OR "candy" OR "nearshore" OR "or"');
  });

  it("sanitizes jieba output before building the MATCH query", () => {
    const fakeJieba: Parameters<typeof _setJiebaForTest>[0] = {
      cutForSearch: () => ["alpha", "OR", "NEAR(beta", "beta", "的", "*", "nearshore"],
    };
    _setJiebaForTest(fakeJieba);

    expect(buildFtsQuery("ignored raw text")).toBe('"alpha" OR "beta" OR "nearshore"');
  });
});

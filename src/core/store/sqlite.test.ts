import { afterEach, describe, expect, it } from "vitest";

import { _resetJiebaForTest, _setJiebaForTest, buildFtsQuery } from "./sqlite.js";

describe("buildFtsQuery", () => {
  afterEach(() => {
    _resetJiebaForTest();
  });

  it("keeps ordinary fallback tokens OR-joined as quoted phrases", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("旅行计划 API")).toBe('"旅行计划" OR "API"');
  });

  it("drops standalone FTS5 operators before building fallback queries", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("alpha AND beta OR NOT gamma NEAR delta")).toBe(
      '"alpha" OR "beta" OR "gamma" OR "delta"',
    );
  });

  it("filters operators case-insensitively without deleting containing words", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("android ordinary nearshore scanner Or NOT")).toBe(
      '"android" OR "ordinary" OR "nearshore" OR "scanner"',
    );
  });

  it("normalizes full-width operators and strips FTS5 syntax characters", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("alpha＊ ＯＲ beta NEAR/5 'gamma' -content:delta")).toBe(
      '"alpha" OR "beta" OR "gamma" OR "delta"',
    );
  });

  it("keeps NEAR group terms while discarding its distance argument", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("NEAR(alpha beta, 5)")).toBe('"alpha" OR "beta"');
  });

  it("returns null when input contains no searchable fallback tokens", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("AND OR NOT NEAR () * ''")).toBeNull();
  });

  it("applies the same sanitizer to jieba-produced tokens", () => {
    _setJiebaForTest({
      cutForSearch: () => ["alpha", "AND", "NEAR(beta", "C++", "的", "beta", "alpha"],
    });

    expect(buildFtsQuery("ignored raw input")).toBe('"alpha" OR "beta" OR "C"');
  });
});

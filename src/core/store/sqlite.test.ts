import { afterEach, describe, expect, it } from "vitest";

import { _resetJiebaForTest, _setJiebaForTest, buildFtsQuery } from "./sqlite.js";

describe("buildFtsQuery", () => {
  afterEach(() => {
    _resetJiebaForTest();
  });

  it("removes FTS5 reserved operators before building a MATCH query", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("alpha AND NOT beta OR NEAR gamma")).toBe('"alpha" OR "beta" OR "gamma"');
  });

  it("drops standalone FTS5 operators instead of returning a query", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("AND OR NOT NEAR")).toBeNull();
  });

  it("keeps ordinary keyword search behavior unchanged", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("travel plan API")).toBe('"travel" OR "plan" OR "API"');
  });

  it("sanitizes FTS5 syntax characters from jieba tokens", () => {
    _setJiebaForTest({
      cutForSearch: () => ["foo:bar", "C++", "AND", "alpha*", "(beta)", "用户"],
    });

    expect(buildFtsQuery("unused")).toBe('"foo" OR "bar" OR "C" OR "alpha" OR "beta" OR "用户"');
  });
});

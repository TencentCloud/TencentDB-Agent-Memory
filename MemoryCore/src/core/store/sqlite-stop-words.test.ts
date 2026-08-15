import { afterEach, describe, expect, it } from "vitest";

import {
  _resetJiebaForTest,
  _setJiebaForTest,
  buildFtsQuery,
} from "./sqlite.js";

describe("buildFtsQuery English stop-word filtering", () => {
  afterEach(() => {
    _resetJiebaForTest();
  });

  it("filters English function words from jieba tokens while preserving content words", () => {
    _setJiebaForTest({
      cutForSearch: () => ["does", "the", "user", "live"],
    });

    expect(buildFtsQuery("does the user live")).toBe(
      '"user" OR "live"',
    );
  });

  it("filters English function words in the Unicode-regex fallback path", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("does the user live")).toBe(
      '"user" OR "live"',
    );
  });

  it("applies case-insensitive filtering and preserves negation in jieba", () => {
    _setJiebaForTest({
      cutForSearch: () => ["THE", "user", "IS", "not", "allergic"],
    });

    expect(buildFtsQuery("THE user IS not allergic")).toBe(
      '"user" OR "not" OR "allergic"',
    );
  });

  it("keeps technical tokens while filtering case-insensitive function words", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("THE user IS in Berlin")).toBe(
      '"user" OR "in" OR "Berlin"',
    );
  });

  it("keeps negation words searchable", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("user is not allergic to peanuts")).toBe(
      '"user" OR "not" OR "allergic" OR "to" OR "peanuts"',
    );
  });

  it("keeps technical query terms such as SQL keywords searchable", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("WHERE user_id IN table")).toBe(
      '"WHERE" OR "user_id" OR "IN" OR "table"',
    );
  });

  it("returns null when a query contains no searchable tokens", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("the does is are")).toBeNull();
  });

  it("preserves the existing Chinese stop-word behavior", () => {
    _setJiebaForTest({
      cutForSearch: () => ["用户", "的", "喜欢", "编程"],
    });

    expect(buildFtsQuery("用户的喜欢编程")).toBe(
      '"用户" OR "喜欢" OR "编程"',
    );
  });

  it("applies Chinese stop-word filtering in the Unicode-regex fallback path", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("用户 的 喜欢 编程")).toBe(
      '"用户" OR "喜欢" OR "编程"',
    );
  });
});

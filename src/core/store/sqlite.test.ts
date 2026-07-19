import { afterEach, describe, expect, it } from "vitest";

import { _resetJiebaForTest, _setJiebaForTest, buildFtsQuery } from "./sqlite.js";

describe("buildFtsQuery", () => {
  afterEach(() => {
    _resetJiebaForTest();
  });

  it("removes a standalone AND operator before fallback tokenization", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("foo AND bar")).toBe('"foo" OR "bar"');
  });

  it("removes a standalone OR operator before fallback tokenization", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("foo OR bar")).toBe('"foo" OR "bar"');
  });

  it("removes a standalone NOT operator before fallback tokenization", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("foo NOT bar")).toBe('"foo" OR "bar"');
  });

  it("removes a standalone NEAR operator before fallback tokenization", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("foo NEAR bar")).toBe('"foo" OR "bar"');
  });

  it("removes standalone operators case-insensitively", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("foo and bar Or baz nOt qux near end")).toBe(
      '"foo" OR "bar" OR "baz" OR "qux" OR "end"',
    );
  });

  it("returns null when the input contains only standalone operators", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("AND OR NOT NEAR")).toBeNull();
  });

  it("preserves normal words containing operator substrings", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("ANDROID ordinary notable nearby OR中文")).toBe(
      '"ANDROID" OR "ordinary" OR "notable" OR "nearby" OR "OR中文"',
    );
  });

  it("uses the cleaned input for jieba search tokenization", () => {
    const calls: Array<{ text: string; hmm: boolean }> = [];
    _setJiebaForTest({
      cutForSearch(text, hmm) {
        calls.push({ text, hmm });
        return text.split(/\s+/).filter(Boolean);
      },
    });

    expect(buildFtsQuery("用户 AND TypeScript OR 记忆")).toBe(
      '"用户" OR "TypeScript" OR "记忆"',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].hmm).toBe(true);
    expect(calls[0].text.split(/\s+/).filter(Boolean)).toEqual(["用户", "TypeScript", "记忆"]);
  });

  it("preserves existing jieba filtering, deduplication, and quoting behavior", () => {
    _setJiebaForTest({
      cutForSearch: () => ["用户", "用户", "的", ",", "TypeScript", '"quoted"'],
    });

    expect(buildFtsQuery("normal input")).toBe('"用户" OR "TypeScript" OR "quoted"');
  });
});

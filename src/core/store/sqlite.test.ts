import { afterEach, describe, expect, it } from "vitest";

import { _resetJiebaForTest, _setJiebaForTest, buildFtsQuery } from "./sqlite.js";

describe("buildFtsQuery", () => {
  afterEach(() => {
    _resetJiebaForTest();
  });

  it("keeps ordinary fallback tokens OR-joined as quoted phrases", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("travel plan API")).toBe('"travel" OR "plan" OR "API"');
  });

  it("strips FTS5 operators before fallback tokenization", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("alpha AND beta OR NOT gamma NEAR delta")).toBe(
      '"alpha" OR "beta" OR "gamma" OR "delta"',
    );
  });

  it("strips operators case-insensitively without deleting containing words", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("android ordinary notable nearby Or NOT")).toBe(
      '"android" OR "ordinary" OR "notable" OR "nearby"',
    );
  });

  it("returns null when input contains only FTS5 operators", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("AND OR NOT NEAR")).toBeNull();
  });

  it("applies the same operator stripping before jieba tokenization", () => {
    const cutInputs: string[] = [];

    _setJiebaForTest({
      cutForSearch(text, hmm) {
        cutInputs.push(text);
        expect(hmm).toBe(true);
        return text.split(/\s+/).filter(Boolean);
      },
    });

    expect(buildFtsQuery("用户 AND TypeScript OR 记忆")).toBe('"用户" OR "TypeScript" OR "记忆"');
    expect(cutInputs).toEqual(["用户   TypeScript   记忆"]);
  });

  it("filters FTS5 operators returned by jieba while keeping normal tokens", () => {
    _setJiebaForTest({
      cutForSearch: () => ["用户", "AND", "TypeScript", "OR", "用户", "的", "nearby"],
    });

    expect(buildFtsQuery("ignored raw text")).toBe('"用户" OR "TypeScript" OR "nearby"');
  });
});

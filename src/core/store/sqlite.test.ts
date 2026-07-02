import { afterEach, describe, expect, it } from "vitest";

import { _resetJiebaForTest, _setJiebaForTest, buildFtsQuery } from "./sqlite.js";

describe("buildFtsQuery", () => {
  afterEach(() => {
    _resetJiebaForTest();
  });

  it("strips FTS5 operators and control syntax in regex fallback mode", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery('alpha AND beta OR gamma NOT delta NEAR/5 "quoted" (group)*')).toBe(
      '"alpha" OR "beta" OR "gamma" OR "delta" OR "quoted" OR "group"',
    );
  });

  it("sanitizes input before jieba tokenization", () => {
    const seenInputs: string[] = [];
    _setJiebaForTest({
      cutForSearch(text: string) {
        seenInputs.push(text);
        return text.match(/[\p{L}\p{N}_]+/gu) ?? [];
      },
    });

    expect(buildFtsQuery("memory AND sqlite NEAR/3 injection")).toBe(
      '"memory" OR "sqlite" OR "injection"',
    );
    expect(seenInputs).toEqual(["memory   sqlite   injection"]);
  });

  it("returns null when input contains only FTS5 syntax", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery('AND OR NOT NEAR/10 "()" * -')).toBeNull();
  });
});

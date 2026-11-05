import { describe, expect, it } from "vitest";
import { normalizeKoreanQueryTerms, tokenize } from "../manager.js";

describe("normalizeKoreanQueryTerms", () => {
  it("strips one trailing particle or ending, longest match first", () => {
    expect(normalizeKoreanQueryTerms(["레버리지를", "회고에서", "서울에서는", "공부하는", "정리했었지"])).toEqual([
      "레버리지",
      "회고",
      "서울",
      "공부",
      "정리",
    ]);
    expect(normalizeKoreanQueryTerms(tokenize("API를 20분을"))).toEqual(["api", "20분"]);
  });

  it("drops Korean filler and question words", () => {
    expect(normalizeKoreanQueryTerms(["분산", "투자는", "뭐였더라"])).toEqual(["분산", "투자"]);
    expect(normalizeKoreanQueryTerms(["복리", "무엇을", "알려줘?"])).toEqual(["복리"]);
  });

  it("leaves Han and Latin terms untouched", () => {
    const zh = tokenize("复利是什么");
    expect(normalizeKoreanQueryTerms(zh)).toEqual(zh);
    expect(normalizeKoreanQueryTerms(["leverage", "notes", "中文을"])).toEqual(["leverage", "notes", "中文을"]);
  });

  it("keeps at least two characters before a suffix", () => {
    expect(normalizeKoreanQueryTerms(["회의", "평가", "가을"])).toEqual(["회의", "평가", "가을"]);
    // Known limit: a noun ending like a particle loses it, but the stem is still a prefix.
    expect(normalizeKoreanQueryTerms(["고양이"])).toEqual(["고양"]);
  });

  it("returns the original terms when every term would be dropped", () => {
    expect(normalizeKoreanQueryTerms(["어떻게", "해"])).toEqual(["어떻게", "해"]);
  });

  it("reduces '복리에 대해 알려줘' to its keyword (regression)", () => {
    expect(tokenize("복리에 대해 알려줘")).toEqual(["복리에", "대해", "알려줘"]);
    expect(normalizeKoreanQueryTerms(tokenize("복리에 대해 알려줘"))).toEqual(["복리"]);
  });
});

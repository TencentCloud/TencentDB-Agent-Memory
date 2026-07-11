import { afterEach, describe, expect, it, vi } from "vitest";

import {
  _resetJiebaForTest,
  _setJiebaForTest,
  buildFtsQuery,
  sanitizeFts5Input,
} from "./sqlite.js";

afterEach(() => {
  _resetJiebaForTest();
});

describe("sanitizeFts5Input", () => {
  it.each(["AND", "OR", "NOT", "NEAR", "and", "or", "not", "near"])(
    "removes the standalone %s operator case-insensitively",
    (operator) => {
      expect(sanitizeFts5Input(`alpha ${operator} beta`)).toBe("alpha   beta");
    },
  );

  it("does not remove operator text embedded in normal keywords", () => {
    expect(sanitizeFts5Input("android origin notable nearby"))
      .toBe("android origin notable nearby");
  });

  it.each(["\"", "'", "(", ")", "*", ":", "^", "{", "}", "+", "-"])(
    "neutralizes the %s structural character without joining adjacent tokens",
    (character) => {
      expect(sanitizeFts5Input(`alpha${character}beta`)).toBe("alpha beta");
    },
  );

  it("preserves ordinary Latin, CJK, numeric, underscore, and whitespace input", () => {
    expect(sanitizeFts5Input("TypeScript API_2 用户偏好 2026\n旅行"))
      .toBe("TypeScript API_2 用户偏好 2026\n旅行");
  });
});

describe("buildFtsQuery FTS5 sanitization", () => {
  it("neutralizes a combined injection payload in the regex fallback", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery('\"alpha\" OR NEAR(beta gamma) NOT title:admin*'))
      .toBe('\"alpha\" OR \"beta\" OR \"gamma\" OR \"title\" OR \"admin\"');
  });

  it("sanitizes input before passing it to jieba", () => {
    const cutForSearch = vi.fn(() => ["alpha", "beta"]);
    _setJiebaForTest({ cutForSearch });

    expect(buildFtsQuery("alpha OR NEAR(beta)"))
      .toBe('\"alpha\" OR \"beta\"');
    expect(cutForSearch).toHaveBeenCalledWith("alpha     beta ", true);
  });

  it("returns null when input contains only FTS5 syntax", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery('AND OR NOT NEAR \"\'()*:^{}+-')).toBeNull();
  });

  it("keeps normal keyword-search behavior", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("TypeScript API_2 用户偏好 2026"))
      .toBe('\"TypeScript\" OR \"API_2\" OR \"用户偏好\" OR \"2026\"');
  });
});

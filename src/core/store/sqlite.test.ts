import { afterEach, describe, expect, it } from "vitest";
import { buildFtsQuery, _resetJiebaForTest, _setJiebaForTest } from "./sqlite.js";

describe("buildFtsQuery", () => {
  afterEach(() => {
    _resetJiebaForTest();
  });

  it("strips FTS5 operators before fallback tokenization", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("alpha AND beta OR NOT gamma NEAR delta")).toBe(
      '"alpha" OR "beta" OR "gamma" OR "delta"',
    );
  });

  it("does not strip operator words embedded inside normal tokens", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("android origin notable nearby")).toBe(
      '"android" OR "origin" OR "notable" OR "nearby"',
    );
  });

  it("strips FTS5 operators before jieba tokenization", () => {
    const seen: string[] = [];
    _setJiebaForTest({
      cutForSearch(text: string): string[] {
        seen.push(text);
        return text.split(/\s+/);
      },
    });

    expect(buildFtsQuery("用户 AND TypeScript OR 记忆")).toBe(
      '"用户" OR "TypeScript" OR "记忆"',
    );
    expect(seen).toEqual(["用户   TypeScript   记忆"]);
  });
});

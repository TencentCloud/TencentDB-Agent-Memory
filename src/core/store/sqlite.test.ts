import { afterEach, describe, expect, it } from "vitest";

import { _resetJiebaForTest, _setJiebaForTest, buildFtsQuery } from "./sqlite.js";

describe("buildFtsQuery", () => {
  afterEach(() => {
    _resetJiebaForTest();
  });

  it("filters FTS5 boolean operators in the fallback tokenizer", () => {
    _setJiebaForTest(null);

    const query = buildFtsQuery("alpha AND beta OR gamma NOT delta");

    expect(query).toBe('"alpha" OR "beta" OR "gamma" OR "delta"');
    expect(query).not.toContain('"AND"');
    expect(query).not.toContain('"OR"');
    expect(query).not.toContain('"NOT"');
  });

  it("filters FTS5 NEAR operator syntax without removing normal terms", () => {
    _setJiebaForTest(null);

    const query = buildFtsQuery("NEAR(alpha beta, 5)");

    expect(query).toContain('"alpha"');
    expect(query).toContain('"beta"');
    expect(query).not.toContain('"NEAR"');
  });

  it("does not remove operator names embedded inside ordinary words", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("candy normalize north")).toBe('"candy" OR "normalize" OR "north"');
  });

  it("returns null when the input only contains FTS5 operators", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("AND OR NOT NEAR")).toBeNull();
  });

  it("filters FTS5 operators returned by jieba while keeping normal tokens", () => {
    const user = "\u7528\u6237";
    const likes = "\u559c\u6b22";
    const cutInputs: string[] = [];

    _setJiebaForTest({
      cutForSearch(text, hmm) {
        cutInputs.push(text);
        expect(hmm).toBe(true);
        return [user, "AND", likes, "OR", "TypeScript", user];
      },
    });

    const query = buildFtsQuery(`${user} AND ${likes} OR TypeScript`);

    expect(cutInputs).toHaveLength(1);
    expect(cutInputs[0]).not.toContain("AND");
    expect(cutInputs[0]).not.toContain("OR");
    expect(query).toBe(`"${user}" OR "${likes}" OR "TypeScript"`);
  });
});

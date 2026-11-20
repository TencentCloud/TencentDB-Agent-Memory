import { describe, expect, it } from "vitest";
import { tokenize } from "../manager.js";

describe("tokenize", () => {
  it("lowercases English words and drops stop words", () => {
    expect(tokenize("The Redis Cluster is a what")).toEqual(["redis", "cluster"]);
  });

  it("segments Chinese into words (jieba, bigram fallback both keep these)", () => {
    const tokens = tokenize("企业知识库");
    expect(tokens).toContain("企业");
    expect(tokens).toContain("知识");
  });

  it("splits mixed Chinese/Latin tokens", () => {
    const tokens = tokenize("l0录入");
    expect(tokens).toContain("l0");
    expect(tokens).toContain("录入");
  });

  it("filters Chinese stop words and punctuation", () => {
    expect(tokenize("的知识")).not.toContain("的");
    expect(tokenize("，。！？")).toEqual([]);
    expect(tokenize("")).toEqual([]);
  });
});
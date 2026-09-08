import { describe, expect, it } from "vitest";
import {
  emptyHitHint,
  hasCjk,
  isEmptySymbolHit,
  parseIdentifierTokens,
  rewriteQueryToIdentifiers,
} from "./query-rewrite.js";

describe("hasCjk", () => {
  it("detects Chinese queries", () => {
    expect(hasCjk("搜索的逻辑")).toBe(true);
    expect(hasCjk("排序在哪里做的")).toBe(true);
  });

  it("ignores English identifiers", () => {
    expect(hasCjk("SearchServiceImpl")).toBe(false);
    expect(hasCjk("auth login")).toBe(false);
  });
});

describe("isEmptySymbolHit", () => {
  it("treats the stock empty explore line as a miss", () => {
    expect(isEmptySymbolHit('No relevant code found for "搜索的逻辑"')).toBe(true);
  });

  it("treats blank text as a miss", () => {
    expect(isEmptySymbolHit("   ")).toBe(true);
  });

  it("keeps a real hit", () => {
    expect(isEmptySymbolHit("Exploration: SearchServiceImpl\nFound 34 symbols")).toBe(false);
  });
});

describe("parseIdentifierTokens", () => {
  it("keeps a clean token line", () => {
    expect(parseIdentifierTokens("Search Service Query Filter")).toBe(
      "Search Service Query Filter",
    );
  });

  it("strips prose and punctuation", () => {
    expect(parseIdentifierTokens('Here you go: "SearchService", rank, 排序')).toBe(
      "SearchService rank",
    );
  });

  it("returns null when nothing identifier-like remains", () => {
    expect(parseIdentifierTokens("抱歉，我不知道")).toBeNull();
  });
});

describe("rewriteQueryToIdentifiers", () => {
  it("returns parsed tokens from the chat fn", async () => {
    const tokens = await rewriteQueryToIdentifiers("搜索的逻辑", async () => "Search Query Filter");
    expect(tokens).toBe("Search Query Filter");
  });

  it("returns null when the model echoes the Chinese query", async () => {
    const tokens = await rewriteQueryToIdentifiers("搜索的逻辑", async () => "搜索的逻辑");
    expect(tokens).toBeNull();
  });
});

describe("emptyHitHint", () => {
  it("mentions the original query and the identifier limitation", () => {
    const hint = emptyHitHint("搜索的逻辑", "Search Query");
    expect(hint).toContain("搜索的逻辑");
    expect(hint).toContain("Search Query");
    expect(hint).toContain("English identifiers");
  });
});

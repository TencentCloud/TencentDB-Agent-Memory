/** tz-10b — the budget's unit of measure has to be stable and script-aware. */
import { describe, it, expect } from "vitest";
import { createCharTokenizer, estimateTokens } from "./tokenizer.js";

describe("estimateTokens", () => {
  it("counts CJK per character and latin per four", () => {
    expect(estimateTokens("记忆")).toBe(2);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    // Mixed text adds the two rules, it does not pick one.
    expect(estimateTokens("记忆abcd")).toBe(3);
  });

  it("is total: empty text costs nothing, the same text always costs the same", () => {
    expect(estimateTokens("")).toBe(0);
    const text = "деплой идёт через rsync без --delete";
    expect(estimateTokens(text)).toBe(estimateTokens(text));
  });

  it("is pinned by id and version so a measurement can be compared", () => {
    const tokenizer = createCharTokenizer();
    expect(tokenizer.id).toBe("chars-cjk-v1");
    expect(tokenizer.version).toBe("1");
    expect(tokenizer.count("记忆")).toBe(estimateTokens("记忆"));
  });
});

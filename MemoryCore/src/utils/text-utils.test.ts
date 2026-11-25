import { describe, expect, it } from "vitest";

import { extractWords } from "./text-utils.js";

describe("extractWords", () => {
  it("extracts lowercased latin words of two or more characters", () => {
    const words = extractWords("Where does the User live?");
    expect(words.has("where")).toBe(true);
    expect(words.has("does")).toBe(true);
    expect(words.has("user")).toBe(true);
    expect(words.has("live")).toBe(true);
  });

  it("ignores single-character latin tokens", () => {
    const words = extractWords("a I x");
    expect(words.has("a")).toBe(false);
    expect(words.has("i")).toBe(false);
    expect(words.has("x")).toBe(false);
  });

  it("keeps CJK single characters", () => {
    const words = extractWords("你好世界");
    for (const c of ["你", "好", "世", "界"]) {
      expect(words.has(c)).toBe(true);
    }
  });

  it("builds bigrams only inside a contiguous CJK run", () => {
    const words = extractWords("你好，世界");
    expect(words.has("你好")).toBe(true);
    expect(words.has("世界")).toBe(true);
    // Regression: the old implementation joined characters from separate
    // runs, producing a token that never occurs next to each other in the text.
    expect(words.has("好世")).toBe(false);
  });

  it("does not create cross-run bigrams across latin text", () => {
    const words = extractWords("中文 and 更多");
    expect(words.has("中文")).toBe(true);
    expect(words.has("更多")).toBe(true);
    expect(words.has("文更")).toBe(false);
    expect(words.has("and")).toBe(true);
  });

  it("returns an empty set for empty input", () => {
    expect(extractWords("").size).toBe(0);
  });
});

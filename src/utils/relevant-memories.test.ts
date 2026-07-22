/**
 * Tests for relevant-memories strip helpers — used before persisting user
 * messages so recalled-memory blocks don't bloat frozen conversation history.
 */
import { describe, expect, test } from "vitest";
import { stripRelevantMemories, hasRelevantMemories } from "./relevant-memories.js";

describe("stripRelevantMemories", () => {
  test("removes a single <relevant-memories> block and surrounding whitespace", () => {
    const text = "<relevant-memories>\nmem\n</relevant-memories>\nhello";
    expect(stripRelevantMemories(text)).toBe("hello");
  });

  test("removes multiple blocks", () => {
    const text = "a<relevant-memories>x</relevant-memories>b<relevant-memories>y</relevant-memories>c";
    expect(stripRelevantMemories(text)).toBe("abc");
  });

  test("leaves text without blocks unchanged", () => {
    expect(stripRelevantMemories("just user text")).toBe("just user text");
  });

  test("preserves surrounding text", () => {
    expect(stripRelevantMemories("before<relevant-memories>mem</relevant-memories>after")).toBe("beforeafter");
  });
});

describe("hasRelevantMemories", () => {
  test("true when a block is present", () => {
    expect(hasRelevantMemories("x<relevant-memories>y</relevant-memories>")).toBe(true);
  });

  test("false when absent", () => {
    expect(hasRelevantMemories("plain text")).toBe(false);
  });
});

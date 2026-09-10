import { describe, expect, it } from "vitest";
import {
  TOOL_RESULT_TRUNCATE_CHARS,
  truncateTailToolResults,
  truncateToolResultText,
} from "./compressor.js";
import type { Message } from "./helpers.js";

function toolResult(content: string): Message {
  return { role: "tool", content };
}

function countingEstimator(maxCalls: number) {
  let calls = 0;
  return (text: string) => {
    if (++calls > maxCalls) {
      throw new Error(`estimateTokens called ${calls} times — truncation is not converging`);
    }
    return Math.max(1, Math.ceil(text.length / 4));
  };
}

describe("truncateToolResultText", () => {
  it("keeps short content unchanged", () => {
    expect(truncateToolResultText("hello", 2000)).toBe("hello");
  });

  it("fits notice-inclusive output within truncateChars", () => {
    const content = "x".repeat(TOOL_RESULT_TRUNCATE_CHARS + 500);
    const truncated = truncateToolResultText(content, TOOL_RESULT_TRUNCATE_CHARS);
    expect(truncated.length).toBeLessThanOrEqual(TOOL_RESULT_TRUNCATE_CHARS);
    expect(truncated).toContain("content truncated");
  });
});

describe("truncateTailToolResults", () => {
  it("terminates when a single tool_result cannot free the requested budget", () => {
    const truncateChars = TOOL_RESULT_TRUNCATE_CHARS;
    const messages = [toolResult("x".repeat(truncateChars + 500))];
    const tokenArray = [Math.ceil((truncateChars + 500) / 4)];

    const freed = truncateTailToolResults(
      messages,
      tokenArray,
      0,
      100_000,
      countingEstimator(20),
      truncateChars,
    );

    expect(freed).toBeGreaterThan(0);
    const content = messages[0].content as string;
    expect(content.length).toBeLessThanOrEqual(truncateChars);
    expect(content).toContain("content truncated");
  });

  it("does not re-select an already truncated message", () => {
    const truncateChars = 80;
    const messages = [toolResult("a".repeat(200)), toolResult("b".repeat(180))];
    const tokenArray = [
      Math.ceil(200 / 4),
      Math.ceil(180 / 4),
    ];

    truncateTailToolResults(
      messages,
      tokenArray,
      0,
      100_000,
      countingEstimator(20),
      truncateChars,
    );

    expect((messages[0].content as string).length).toBeLessThanOrEqual(truncateChars);
    expect((messages[1].content as string).length).toBeLessThanOrEqual(truncateChars);
  });
});

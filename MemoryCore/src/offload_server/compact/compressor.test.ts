/**
 * Regression tests for #832 — tool-result truncation must terminate instead
 * of spinning at 100% CPU when a single message cannot free enough tokens.
 */

import { describe, expect, it } from "vitest";
import { truncateTailToolResults } from "./compressor.js";
import type { Message } from "./helpers.js";

function toolResult(content: string): Message {
  return {
    role: "user",
    content: [{ type: "tool_result", content }],
  } as unknown as Message;
}

function getToolResultContent(msg: Message): string {
  const blocks = (msg as any).content as { type: string; content: string }[];
  return blocks[0]?.content ?? "";
}

describe("truncateTailToolResults (#832)", () => {
  it("terminates when a single message cannot free enough tokens", () => {
    const content = "x".repeat(2500); // > default TOOL_RESULT_TRUNCATE_CHARS (2000)
    const messages = [toolResult(content)];
    const tokenArray = [Math.ceil(content.length / 4)]; // ~625
    const estimate = (t: string) => Math.max(1, Math.ceil(t.length / 4));

    // Would previously loop forever (freed=0 after round 1) until timeout.
    const freed = truncateTailToolResults(messages, tokenArray, 0, 100_000, estimate);

    expect(freed).toBeGreaterThan(0);
    // Truncated result (including the notice) stays within the budget, so the
    // same message is not re-selected on the next pass.
    const result = getToolResultContent(messages[0]);
    expect(result.length).toBeLessThanOrEqual(2000);
    expect(result).toContain("content truncated");
  });

  it("leaves already-small tool results untouched", () => {
    const content = "short";
    const messages = [toolResult(content)];
    const freed = truncateTailToolResults(messages, [5], 0, 100, (t) => t.length);
    expect(freed).toBe(0);
    expect(getToolResultContent(messages[0])).toBe("short");
  });
});

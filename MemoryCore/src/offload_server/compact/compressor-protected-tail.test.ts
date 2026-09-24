/**
 * Tests for #838 — compressProtectedTail must be usable as the escape hatch
 * when emergency compaction still leaves the prompt above the target (it was
 * previously never called).
 *
 * Note: the fine-grained truncation path inside compressProtectedTail is
 * covered by #832's fix (truncateTailToolResults infinite loop); these tests
 * exercise the fast batch-deletion path so they run on the unpatched trunk.
 */

import { describe, expect, it } from "vitest";
import { compressProtectedTail } from "./compressor.js";
import type { Message } from "./helpers.js";

function assistantWithToolUse(): Message {
  return {
    role: "assistant",
    content: "planning",
    tool_calls: [{ function: { name: "f", arguments: "{}" } }],
  } as unknown as Message;
}

function toolResult(content: string): Message {
  return { role: "tool", content, tool_call_id: "t1" } as unknown as Message;
}

describe("compressProtectedTail (#838)", () => {
  it("frees tokens from oversized tool pairs when above the target", () => {
    // Two oversized tool pairs: fast batch deletion of the first pair alone is
    // enough to bring the prompt under the target.
    const messages: Message[] = [
      { role: "user", content: "user question" } as Message,
      assistantWithToolUse(),
      toolResult("x".repeat(30000)),
      assistantWithToolUse(),
      toolResult("y".repeat(30000)),
    ];
    const tokens = [1, 10, 30000, 10, 30000];
    const deletedIds: string[] = [];

    const result = compressProtectedTail(messages, tokens, 35_000, 60_021, deletedIds);

    expect(result.freedTokens).toBeGreaterThan(0);
  });

  it("returns zero when already within target", () => {
    const messages = [{ role: "user", content: "q" } as Message];
    const result = compressProtectedTail(messages, [1], 100, 1, []);
    expect(result.freedTokens).toBe(0);
    expect(result.deletedCount).toBe(0);
  });
});

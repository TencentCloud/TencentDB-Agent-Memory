import { describe, expect, it } from "vitest";

import {
  buildTiktokenContextSnapshot,
  invalidateTokenCache,
} from "./context-token-tracker.js";
import { stripDeletedToolUseBlocks } from "./l3-helpers.js";

function makeMixedAssistantMessage() {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "I will inspect the repository." },
      {
        type: "tool_use",
        id: "toolu_deleted_01",
        name: "read_file",
        input: {
          path: "/tmp/large.log",
          reason: "x".repeat(2000),
        },
      },
      { type: "text", text: "The useful text should stay." },
    ],
  };
}

describe("stripDeletedToolUseBlocks", () => {
  it("invalidates cached token counts after removing deleted tool_use blocks", () => {
    const msg = makeMixedAssistantMessage();
    const before = buildTiktokenContextSnapshot("before", [msg], null, null);

    const removed = stripDeletedToolUseBlocks(msg, new Set(["toolu_deleted_01"]));
    const after = buildTiktokenContextSnapshot("after", [msg], null, null);

    expect(removed).toBe(1);
    expect(msg.content).toEqual([
      { type: "text", text: "I will inspect the repository." },
      { type: "text", text: "The useful text should stay." },
    ]);
    expect(after.totalTokens).toBeLessThan(before.totalTokens);
  });

  it("leaves cached counts untouched when no deleted block matches", () => {
    const msg = makeMixedAssistantMessage();
    const before = buildTiktokenContextSnapshot("before", [msg], null, null);

    const removed = stripDeletedToolUseBlocks(msg, new Set(["other_id"]));
    const after = buildTiktokenContextSnapshot("after", [msg], null, null);

    expect(removed).toBe(0);
    expect(after.totalTokens).toBe(before.totalTokens);

    invalidateTokenCache(msg);
  });
});

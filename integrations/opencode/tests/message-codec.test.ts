import { describe, expect, it } from "vitest";
import {
  collectCompletedTurns,
  extractText,
  formatRecallInjection,
  RECALL_MARKER_START,
  stripRecallBlocks,
} from "../src/message-codec.js";

describe("OpenCode message codec", () => {
  it("excludes synthetic, ignored, and recalled text", () => {
    expect(
      extractText([
        { type: "text", text: "real" },
        { type: "text", text: "synthetic", synthetic: true },
        { type: "text", text: "ignored", ignored: true },
        { type: "text", text: `${RECALL_MARKER_START}\nmemory` },
        { type: "reasoning", text: "hidden" },
      ]),
    ).toBe("real");
  });

  it("pairs only successful completed assistant messages", () => {
    const turns = collectCompletedTurns([
      {
        info: { id: "u1", sessionID: "s", role: "user" },
        parts: [{ type: "text", text: "request" }],
      },
      {
        info: {
          id: "a1",
          sessionID: "s",
          role: "assistant",
          parentID: "u1",
          time: { completed: 2 },
        },
        parts: [{ type: "text", text: "answer" }],
      },
      {
        info: {
          id: "a2",
          sessionID: "s",
          role: "assistant",
          parentID: "u1",
          error: {},
        },
        parts: [{ type: "text", text: "failed" }],
      },
    ]);
    expect(turns).toEqual([
      expect.objectContaining({
        assistantMessageId: "a1",
        userText: "request",
        assistantText: "answer",
      }),
    ]);
  });

  it("labels recall as supplemental synthetic context", () => {
    const injection = formatRecallInjection("remember this");
    expect(injection).toContain(RECALL_MARKER_START);
    expect(injection).toContain("untrusted historical context");
  });

  it("removes recalled blocks from explicit capture text", () => {
    const value = `before\n${formatRecallInjection("memory")}\nafter`;
    expect(stripRecallBlocks(value)).toBe("before\n\nafter");
  });
});

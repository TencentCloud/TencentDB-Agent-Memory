import { describe, expect, it } from "vitest";
import { cursorAdapter, repairCursorReasoningContent } from "../cursor.js";

describe("cursorAdapter", () => {
  it("classifies captured chat-completions shape as main", () => {
    expect(cursorAdapter.classifyRequest({ messages: [{ role: "user", content: [] }] })).toBe("main");
  });

  it("fails open for unknown request shapes", () => {
    expect(cursorAdapter.classifyRequest({ input: "auxiliary" })).toBe("auxiliary");
  });

  it("extracts the last text block", () => {
    expect(cursorAdapter.extractUserText([
      { type: "text", text: "first" },
      { type: "image", url: "ignored" },
      { type: "text", text: "actual input" },
    ])).toBe("actual input");
  });

  it("repairs missing reasoning_content on replayed assistant tool calls", () => {
    const body = { messages: [
      { role: "assistant", tool_calls: [{ id: "call-1" }] },
      { role: "assistant", reasoning_content: "real reasoning", tool_calls: [{ id: "call-2" }] },
      { role: "assistant", content: "plain response" },
    ] };
    expect(repairCursorReasoningContent(body)).toBe(1);
    expect(body.messages[0]).toMatchObject({ reasoning_content: "[proxy cursor tool-call replay]" });
    expect(body.messages[1]).toMatchObject({ reasoning_content: "real reasoning" });
  });
});

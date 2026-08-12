import { describe, expect, it } from "vitest";

import { buildCaptureTurn } from "../src/capture.js";

describe("settled transcript capture", () => {
  it("preserves tool-call source order and pairs parallel results by id", () => {
    const turn = buildCaptureTurn(
      "pi:session-1",
      "Inspect the project",
      [
        {
          role: "assistant",
          stopReason: "toolUse",
          timestamp: 10,
          content: [
            { type: "text", text: "I will inspect both files." },
            { type: "toolCall", id: "call-a", name: "read", arguments: { path: "a.ts" } },
            { type: "toolCall", id: "call-b", name: "read", arguments: { path: "b.ts" } },
          ],
        },
        { role: "toolResult", toolCallId: "call-a", toolName: "read", content: [{ type: "text", text: "A" }], timestamp: 11 },
        { role: "toolResult", toolCallId: "call-b", toolName: "read", content: [{ type: "text", text: "B" }], timestamp: 12 },
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Inspection complete." }], timestamp: 13 },
      ],
      1_000,
      20,
    );

    expect(turn?.assistant).toBe("Inspection complete.");
    expect(turn?.skillMessages.map((message) => [message.role, message.tool_call_id])).toEqual([
      ["user", undefined],
      ["assistant", undefined],
      ["tool_call", "call-a"],
      ["tool_call", "call-b"],
      ["tool_result", "call-a"],
      ["tool_result", "call-b"],
      ["assistant", undefined],
    ]);
  });

  it("sanitizes recall, credentials, images, errors, and oversized output", () => {
    const turn = buildCaptureTurn(
      "pi:session-1",
      "BEGIN_TENCENTDB_RECALLED_MEMORY\nsecret\nEND_TENCENTDB_RECALLED_MEMORY\napi_key=hunter2",
      [
        {
          role: "assistant",
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { token: "abc" } }],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          isError: true,
          content: [{ type: "image" }, { type: "text", text: "x".repeat(800) }],
        },
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Handled the error." }] },
      ],
      500,
    );

    expect(turn?.user).toContain("[recalled memory omitted]");
    expect(turn?.user).toContain('api_key="[REDACTED]"');
    const result = turn?.skillMessages.find((message) => message.role === "tool_result");
    const call = turn?.skillMessages.find((message) => message.role === "tool_call");
    expect(call?.content).toContain('"token":"[REDACTED]"');
    expect(result?.content).toContain("[image]");
    expect(result?.content).toContain("...[capture truncated]");
    expect(result?.tool_call_id).toBe("call-1");
  });
});

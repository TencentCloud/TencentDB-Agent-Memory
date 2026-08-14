import { describe, expect, it } from "vitest";
import { buildCaptureTurn, hasCompletedAssistant } from "../src/capture.js";

describe("buildCaptureTurn", () => {
  it("captures an array-content assistant turn with paired tool calls", () => {
    const messages = [
      { role: "user", content: "list files" },
      { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { cmd: "ls" } }] },
      { role: "toolResult", toolCallId: "c1", toolName: "bash", content: "a.txt" },
      { role: "assistant", content: [{ type: "text", text: "found a.txt" }], stopReason: "stop" },
    ];
    const turn = buildCaptureTurn("s", "list files", messages, 8_000, 1_000);
    expect(turn).not.toBeNull();
    expect(turn?.assistant).toBe("found a.txt");
    expect(turn?.user).toBe("list files");
    const roles = turn?.skillMessages?.map((m) => m.role);
    expect(roles).toEqual(["user", "tool_call", "tool_result", "assistant"]);
  });

  it("captures a string-content assistant turn (H1 fix: no silent drop)", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello there", stopReason: "stop" },
    ];
    const turn = buildCaptureTurn("s", "hi", messages, 8_000, 1_000);
    expect(turn).not.toBeNull();
    expect(turn?.assistant).toBe("hello there");
    expect(turn?.skillMessages?.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("returns null when there is no completed assistant message", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "..." }], stopReason: "error" },
    ];
    expect(buildCaptureTurn("s", "hi", messages, 8_000, 1_000)).toBeNull();
  });

  it("redacts secrets in captured content", () => {
    const messages = [
      { role: "user", content: "api_key=secret123" },
      { role: "assistant", content: "ok", stopReason: "stop" },
    ];
    const turn = buildCaptureTurn("s", "api_key=secret123", messages, 8_000, 1_000);
    expect(turn?.user).not.toContain("secret123");
    expect(turn?.user).toContain("[REDACTED]");
  });

  it("joins queued follow-up user messages", () => {
    const messages = [
      { role: "user", content: "first" },
      { role: "assistant", content: "r1", stopReason: "stop" },
      { role: "user", content: "second" },
      { role: "assistant", content: "r2", stopReason: "stop" },
    ];
    const turn = buildCaptureTurn("s", "first", messages, 8_000, 1_000);
    expect(turn?.user).toContain("first");
    expect(turn?.user).toContain("second");
    expect(turn?.user).toContain("queued follow-up");
    expect(turn?.assistant).toBe("r2");
  });

  it("drops orphan tool calls/results without a pair from the skill buffer", () => {
    const messages = [
      { role: "user", content: "x" },
      { role: "assistant", content: [{ type: "toolCall", id: "orphan", name: "bash", arguments: {} }] },
      { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ];
    const turn = buildCaptureTurn("s", "x", messages, 8_000, 1_000);
    const roles = turn?.skillMessages?.map((m) => m.role);
    expect(roles).not.toContain("tool_call");
  });
});

describe("hasCompletedAssistant", () => {
  it("returns true for a final assistant with text", () => {
    expect(
      hasCompletedAssistant([
        { role: "user", content: "x" },
        { role: "assistant", content: "y", stopReason: "stop" },
      ]),
    ).toBe(true);
  });

  it("returns false when the last assistant errored", () => {
    expect(hasCompletedAssistant([{ role: "assistant", content: "y", stopReason: "error" }])).toBe(false);
  });

  it("returns false with no assistant", () => {
    expect(hasCompletedAssistant([{ role: "user", content: "x" }])).toBe(false);
  });
});

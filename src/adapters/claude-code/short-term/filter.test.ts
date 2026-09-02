import { describe, expect, it } from "vitest";
import type { ClaudeCodeToolEvent } from "../types.js";
import { shouldCaptureToolEvent } from "./filter.js";

function event(overrides: Partial<ClaudeCodeToolEvent>): ClaudeCodeToolEvent {
  return {
    sessionKey: "agent:claude-code-x:s",
    toolUseId: "t1",
    toolName: "Read",
    status: "success",
    endedAt: "2026-07-22T00:00:00Z",
    inputSummary: "",
    resultSummary: "",
    ...overrides,
  };
}

describe("shouldCaptureToolEvent", () => {
  it("captures failures", () => {
    expect(shouldCaptureToolEvent(event({ status: "error" }))).toMatchObject({ capture: true, reason: "tool_error" });
  });

  it("captures shell and edit tools", () => {
    expect(shouldCaptureToolEvent(event({ toolName: "Bash" })).capture).toBe(true);
    expect(shouldCaptureToolEvent(event({ toolName: "Edit" })).capture).toBe(true);
  });

  it("skips low-signal read/search tools by default", () => {
    expect(shouldCaptureToolEvent(event({ toolName: "Read" })).capture).toBe(false);
    expect(shouldCaptureToolEvent(event({ toolName: "Grep" })).capture).toBe(false);
  });

  it("captures large outputs", () => {
    expect(shouldCaptureToolEvent(event({ toolName: "Read", rawResult: "x".repeat(5000) })).reason).toBe("large_result");
  });
});

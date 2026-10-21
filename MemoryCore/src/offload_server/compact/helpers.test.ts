import { describe, expect, it } from "vitest";
import { extractToolResultId, isToolResultMessage } from "./helpers.js";

describe("top-level OpenClaw tool results", () => {
  it("recognizes the documented toolResult role", () => {
    expect(isToolResultMessage({ role: "toolResult", toolCallId: "call_1" })).toBe(true);
  });

  it("extracts the linked toolCallId", () => {
    expect(extractToolResultId({ role: "toolResult", toolCallId: "call_1" })).toBe("call_1");
  });
});

describe("existing message contracts", () => {
  it.each([
    ["OpenAI", { role: "tool", tool_call_id: "call_1" }],
    ["Anthropic", { type: "tool_result", tool_use_id: "call_1" }],
    ["wrapped OpenClaw", { type: "message", message: { role: "toolResult", id: "call_1" } }],
    ["Anthropic user block", { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1" }] }],
  ])("preserves %s result recognition and pairing", (_name, message) => {
    expect(isToolResultMessage(message)).toBe(true);
    expect(extractToolResultId(message)).toBe("call_1");
  });

  it.each([undefined, null, "", 0, {}])("rejects an absent or invalid native ID: %j", (toolCallId) => {
    expect(extractToolResultId({ role: "toolResult", toolCallId })).toBeNull();
  });

  it("does not interpret arbitrary toolCallId fields as results", () => {
    for (const role of ["user", "assistant", "system"]) {
      const message = { role, toolCallId: "call_1", content: [] };
      expect(extractToolResultId(message)).toBeNull();
      expect(isToolResultMessage(message)).toBe(false);
    }
  });

  it("preserves existing ID precedence when native fields are also present", () => {
    expect(extractToolResultId({ role: "toolResult", toolCallId: "native", tool_call_id: "openai" })).toBe("openai");
    expect(extractToolResultId({ role: "toolResult", toolCallId: "native", tool_use_id: "anthropic" })).toBe("anthropic");
    expect(extractToolResultId({ role: "toolResult", toolCallId: "native", type: "message", message: { id: "wrapped" } })).toBe("wrapped");
  });
});

import { describe, expect, it } from "vitest";
import { parseMemCommand } from "../parser.js";

describe("parseMemCommand", () => {
  it("finds the last Cursor user command before trailing assistant/tool replay", () => {
    const parsed = parseMemCommand({ messages: [
      { role: "user", content: [{ type: "text", text: "ordinary question" }] },
      { role: "assistant", content: [], tool_calls: [{ id: "call-1" }] },
      { role: "tool", tool_call_id: "call-1", content: [{ type: "text", text: "result" }] },
      { role: "user", content: [
        { type: "text", text: "<user_query>mem:help</user_query>" },
        { type: "text", text: "<additional_data>environment noise after the command</additional_data>" },
      ] },
      { role: "assistant", content: [], tool_calls: [{ id: "call-2" }] },
      { role: "tool", tool_call_id: "call-2", content: [{ type: "text", text: "result" }] },
    ] }, "cursor");

    expect(parsed).toMatchObject({ command: "help", args: "", rawMessage: "mem:help" });
  });

  it("preserves the historic last-element behavior for non-Cursor clients", () => {
    const parsed = parseMemCommand({ messages: [
      { role: "user", content: "mem:help" },
      { role: "assistant", content: "already answered" },
    ] }, "codebuddy");
    expect(parsed).toBeNull();
  });
});

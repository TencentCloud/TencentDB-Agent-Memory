import { describe, expect, it, vi } from "vitest";
import { extractNewCodexUserMessage } from "../codex-recorder.js";
import { recordTdaiTurn } from "../recorder.js";
import type { TdaiClient } from "../client.js";

const user = (text = "show aiChat code") => ({
  type: "message", role: "user", content: [{ type: "input_text", text }],
});
const assistant = { type: "message", role: "assistant", content: [] };
const identity = { teamId: "team", userId: "user", agentId: "agent", sessionId: "session" };

describe("Codex L0 tool continuations", () => {
  it("records the initial question", () => {
    expect(extractNewCodexUserMessage([user()])).toEqual({ role: "user", content: "show aiChat code" });
  });

  it.each([
    "function_call", "function_call_output", "custom_tool_call",
    "custom_tool_call_output", "reasoning",
  ])("does not replay the user after %s", (type) => {
    expect(extractNewCodexUserMessage([user(), { type }])).toBeNull();
  });

  it("does not replay the user after assistant commentary", () => {
    expect(extractNewCodexUserMessage([user(), assistant])).toBeNull();
  });

  it("retains a later identical question", () => {
    expect(extractNewCodexUserMessage([user(), assistant, { type: "function_call_output" }, user()]))
      .toEqual({ role: "user", content: "show aiChat code" });
  });

  it.each([undefined, null, "question", [], [null, { type: "message", role: "user", content: [] }]])(
    "ignores inputs without user text: %j", (input) => {
      expect(extractNewCodexUserMessage(input)).toBeNull();
    },
  );

  it("archives one user plus all new assistant replies across tool rounds", async () => {
    const addConversation = vi.fn().mockResolvedValue(undefined);
    const client = { addConversation } as unknown as TdaiClient;
    const history: unknown[] = [user()];
    for (const reply of ["I'll inspect the code", "", "Here is the flow"]) {
      await recordTdaiTurn(client, identity, extractNewCodexUserMessage(history), reply);
      history.push(assistant, { type: "custom_tool_call_output", output: "result" });
    }
    expect(addConversation.mock.calls.flatMap((call) => call[1])).toEqual([
      { role: "user", content: "show aiChat code" },
      { role: "assistant", content: "I'll inspect the code" },
      { role: "assistant", content: "Here is the flow" },
    ]);
    expect(addConversation).toHaveBeenCalledTimes(2);
  });
});

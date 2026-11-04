import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TdaiClient } from "../client.js";
import { extractLatestUserMessage, recordTdaiTurn } from "../recorder.js";

const identity = { teamId: "team", userId: "user", agentId: "agent", sessionId: "session" };
const userMessage = { role: "user" as const, content: "question" };
const addConversation = vi.fn().mockResolvedValue(undefined);
const client = { addConversation } as unknown as TdaiClient;

beforeEach(() => addConversation.mockClear());

describe("shared L0 recorder user-message gate", () => {
  it("skips null user messages from direct callers without an opt-in", async () => {
    // OpenCode tool continuations deliberately pass null, even with user history.
    await recordTdaiTurn(client, identity, null, "tool continuation reply");
    expect(addConversation).not.toHaveBeenCalled();
  });

  it("skips inputs with no extractable user text without an opt-in", async () => {
    const user = extractLatestUserMessage([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tool", content: "result" }] },
    ]);
    expect(user).toBeNull();
    await recordTdaiTurn(client, identity, user, "tool continuation reply");
    expect(addConversation).not.toHaveBeenCalled();
  });

  it("respects an explicitly disabled assistant-only option", async () => {
    await recordTdaiTurn(client, identity, null, "reply", { allowAssistantOnly: false });
    expect(addConversation).not.toHaveBeenCalled();
  });

  it("writes assistant-only replies when explicitly enabled", async () => {
    await recordTdaiTurn(client, identity, null, "reply", { allowAssistantOnly: true });
    expect(addConversation).toHaveBeenCalledExactlyOnceWith(identity, [{ role: "assistant", content: "reply" }]);
  });

  it.each([undefined, null, "", " \n "])("skips empty assistant-only content: %j", async (content) => {
    await recordTdaiTurn(client, identity, null, content, { allowAssistantOnly: true });
    expect(addConversation).not.toHaveBeenCalled();
  });

  it("still requires identity when assistant-only writes are enabled", async () => {
    await recordTdaiTurn(client, null, null, "reply", { allowAssistantOnly: true });
    expect(addConversation).not.toHaveBeenCalled();
  });

  it("preserves normal user and assistant writes without an opt-in", async () => {
    await recordTdaiTurn(client, identity, userMessage, "reply");
    expect(addConversation).toHaveBeenCalledExactlyOnceWith(identity, [userMessage, { role: "assistant", content: "reply" }]);
  });

  it("preserves user-only writes without an opt-in", async () => {
    await recordTdaiTurn(client, identity, userMessage, null);
    expect(addConversation).toHaveBeenCalledExactlyOnceWith(identity, [userMessage]);
  });
});

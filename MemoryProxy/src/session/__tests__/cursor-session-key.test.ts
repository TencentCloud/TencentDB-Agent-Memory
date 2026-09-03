import { describe, expect, it } from "vitest";
import { resolveCursorConversationId } from "../session-key.js";

function body(firstPrompt: string, tail: Record<string, unknown>[] = []) {
  return {
    user: "account-placeholder",
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "cursor metadata" },
      { role: "user", content: [{ type: "text", text: firstPrompt }] },
      ...tail,
    ],
  };
}

describe("resolveCursorConversationId", () => {
  it("stays stable as the same conversation history grows", () => {
    const first = resolveCursorConversationId(body("hello"));
    const second = resolveCursorConversationId(body("hello", [
      { role: "assistant", content: "reply" },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ]));
    expect(second).toBe(first);
  });

  it("separates new conversations with different first turns", () => {
    expect(resolveCursorConversationId(body("one"))).not.toBe(resolveCursorConversationId(body("two")));
  });

  it("documents the no-header limitation for identical first turns", () => {
    // Cursor's confirmed ingress exposes account identity and message history,
    // but no conversation header. Until Cursor provides one, two fresh chats
    // with identical first turns cannot be distinguished deterministically.
    expect(resolveCursorConversationId(body("same prompt"))).toBe(
      resolveCursorConversationId(body("same prompt")),
    );
  });
});

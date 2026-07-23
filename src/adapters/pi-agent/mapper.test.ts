import { describe, expect, it } from "vitest";
import { normalizePiMessages, piMessagesToSeedConversations } from "./mapper.js";

describe("Pi Agent mapper", () => {
  it("normalizes text and block-style messages", () => {
    const messages = normalizePiMessages({
      messages: [
        { role: "system", content: "ignore" },
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "text", text: "world" }] },
      ],
    });

    expect(messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ]);
  });

  it("pairs user/assistant turns for seed input", () => {
    const conversations = piMessagesToSeedConversations([
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    ]);

    expect(conversations).toEqual([
      { user: "u1", assistant: "a1", timestamp: undefined },
      { user: "u2", assistant: "a2", timestamp: undefined },
    ]);
  });
});
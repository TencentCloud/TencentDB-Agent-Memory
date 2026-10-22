import { describe, expect, it } from "vitest";
import { extractClientIdentity } from "../identity.js";

describe("request-body session identity", () => {
  it("uses metadata.session_id before the system-prompt fallback", () => {
    const identity = extractClientIdentity(
      {},
      {
        metadata: { session_id: "topic-session-42" },
        messages: [
          {
            role: "system",
            content: "session_id: old-prompt-session",
          },
        ],
      },
    );

    expect(identity.sessionId).toBe("topic-session-42");
  });

  it.each([
    ["session_id", { session_id: "session-a" }, "session-a"],
    ["conversationId", { conversationId: "conversation-b" }, "conversation-b"],
    ["thread_id", { thread_id: "thread-c" }, "thread-c"],
    [
      "metadata.conversation_id",
      { metadata: { conversation_id: "conversation-d" } },
      "conversation-d",
    ],
    ["metadata.threadId", { metadata: { threadId: "thread-e" } }, "thread-e"],
  ])("accepts a top-level or metadata %s", (_label, body, expected) => {
    expect(extractClientIdentity({}, body).sessionId).toBe(expected);
  });

  it("keeps request headers ahead of request-body metadata", () => {
    const identity = extractClientIdentity(
      { "x-thread-id": "header-thread" },
      { metadata: { session_id: "body-session" } },
    );

    expect(identity.sessionId).toBe("header-thread");
  });

  it("ignores empty and non-string request-body session values", () => {
    const identity = extractClientIdentity(
      {},
      {
        metadata: { session_id: "   " },
        session_id: 42,
        messages: [
          {
            role: "system",
            content: "conversation_id: prompt-fallback",
          },
        ],
      },
    );

    expect(identity.sessionId).toBe("prompt-fallback");
  });
});

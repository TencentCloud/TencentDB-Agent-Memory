import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { resolveConversationId } from "../session/session-key.js";

async function resolve(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const app = new Hono();
  app.post("/", async (c) => c.json({ id: resolveConversationId(c, await c.req.json()) }));
  const response = await app.request("/", {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return (await response.json()).id;
}

describe("conversation routing from request body", () => {
  it("keeps two topic requests distinct without headers", async () => {
    expect(await resolve({ metadata: { session_id: "topic-a" } })).toBe("topic-a");
    expect(await resolve({ metadata: { session_id: "topic-b" } })).toBe("topic-b");
  });

  it.each(["session_id", "sessionId", "conversation_id", "conversationId", "thread_id", "threadId"])(
    "accepts top-level and metadata %s", async (field) => {
      expect(await resolve({ [field]: " topic-a " })).toBe("topic-a");
      expect(await resolve({ metadata: { [field]: "topic-b" } })).toBe("topic-b");
    },
  );

  it.each(["x-conversation-id", "x-session-id", "x-claude-code-session-id", "x-deepseek-harness-session-id", "x-chat-id", "x-thread-id"])(
    "preserves %s precedence", async (header) => {
      expect(await resolve({ metadata: { session_id: "body" } }, { [header]: "header" })).toBe("header");
    },
  );

  it("preserves parent conversation routing over child and body IDs", async () => {
    expect(await resolve({ session_id: "body" }, {
      "x-parent-conversation-id": "parent", "x-conversation-id": "child",
    })).toBe("parent");
  });

  it.each([null, [], "topic", 42, { session_id: " " }, { session_id: 42 }])(
    "ignores invalid metadata %j without enabling conversation routing", async (metadata) => {
      expect(await resolve({ metadata, session_id: false })).toBeNull();
    },
  );
});

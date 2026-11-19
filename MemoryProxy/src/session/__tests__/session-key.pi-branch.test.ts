import type { Context } from "hono";
import { describe, expect, it } from "vitest";
import { resolveConversationId } from "../session-key.js";

function context(agent: string, headers: Record<string, string>): Context {
  return {
    req: {
      raw: { headers: new Headers(headers) },
      param: (name: string) => (name === "agent" ? agent : undefined),
    },
  } as unknown as Context;
}

describe("Pi session-store branch identity", () => {
  it.each(["workbuddy", "pi"])("preserves parent-session binding for %s subagents", (agent) => {
    expect(resolveConversationId(context(agent, {
      "x-parent-conversation-id": "parent-session",
      "x-conversation-id": "child-session",
      "x-tdai-memory-branch": "branch-left",
    }))).toBe("parent-session");
  });

  it.each(["", "   "])("keeps Pi branch isolation when the parent header is blank (%j)", (parentId) => {
    expect(resolveConversationId(context("pi", {
      "x-parent-conversation-id": parentId,
      "x-conversation-id": "pi-session-123",
      "x-tdai-memory-branch": "branch-left",
    }))).toBe("pi-session-123-branch-left");
  });

  it("preserves the upstream deepseek-harness session header", () => {
    expect(resolveConversationId(context("dsh", {
      "x-deepseek-harness-session-id": "dsh-session",
    }))).toBe("dsh-session");
  });

  it("uses the same derived identity as the Pi memory adapter", () => {
    expect(
      resolveConversationId(context("pi", {
        "x-conversation-id": "pi-session-123",
        "x-tdai-memory-branch": "branch-left",
      })),
    ).toBe("pi-session-123-branch-left");
  });

  it.each([
    "x-conversation-id",
    "x-session-id",
    "session-id",
    "x-claude-code-session-id",
    "x-deepseek-harness-session-id",
    "x-chat-id",
    "x-thread-id",
  ])("applies Pi branch isolation to the %s header", (header) => {
    expect(resolveConversationId(context("pi", {
      [header.toUpperCase()]: "  pi-session-123  ",
      "X-TDAI-MEMORY-BRANCH": "branch-left",
    }))).toBe("pi-session-123-branch-left");
  });

  it.each(["pi", "codebuddy"])("preserves body session fallback for %s", (agent) => {
    expect(resolveConversationId(context(agent, {
      "x-conversation-id": "  ",
      "x-tdai-memory-branch": "branch-left",
    }), {
      client_metadata: { session_id: "  body-session  " },
    })).toBe(agent === "pi" ? "body-session-branch-left" : "body-session");
  });

  it("prefers headers over body session metadata", () => {
    expect(resolveConversationId(context("pi", {
      "x-conversation-id": "pi-session-123",
      "session-id": "lower-priority-session",
      "x-tdai-memory-branch": "branch-left",
    }), {
      client_metadata: { session_id: "body-session" },
    })).toBe("pi-session-123-branch-left");
  });

  it("preserves a trimmed parent-session binding ahead of body metadata", () => {
    expect(resolveConversationId(context("pi", {
      "x-parent-conversation-id": "  parent-session  ",
      "x-tdai-memory-branch": "branch-left",
    }), {
      client_metadata: { session_id: "body-session" },
    })).toBe("parent-session");
  });

  it("does not create a session identity from a branch alone", () => {
    expect(resolveConversationId(context("pi", {
      "x-tdai-memory-branch": "branch-left",
    }))).toBeNull();
  });

  it("ignores invalid branch markers", () => {
    expect(resolveConversationId(context("pi", {
      "x-conversation-id": "pi-session-123",
      "x-tdai-memory-branch": "invalid/branch",
    }))).toBe("pi-session-123");
  });

  it("preserves legacy Pi and non-Pi conversation ids", () => {
    expect(resolveConversationId(context("pi", {
      "x-conversation-id": "pi-session-legacy",
    }))).toBe("pi-session-legacy");

    expect(resolveConversationId(context("codebuddy", {
      "x-conversation-id": "session-codebuddy",
      "x-tdai-memory-branch": "branch-ignored",
    }))).toBe("session-codebuddy");
  });
});

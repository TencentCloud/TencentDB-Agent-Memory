import type { Context } from "hono";
import { describe, expect, it } from "vitest";
import { resolveConversationId } from "../session-key.js";

function context(agent: string, headers: Record<string, string>): Context {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    req: {
      header: (name: string) => normalized[name.toLowerCase()],
      param: (name: string) => (name === "agent" ? agent : undefined),
    },
  } as unknown as Context;
}

describe("Pi session-store branch identity", () => {
  it("uses the same derived identity as the Pi memory adapter", () => {
    expect(
      resolveConversationId(context("pi", {
        "x-conversation-id": "pi-session-123",
        "x-tdai-memory-branch": "branch-left",
      })),
    ).toBe("pi-session-123-branch-left");
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

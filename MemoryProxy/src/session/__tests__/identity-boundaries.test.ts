import { describe, expect, it } from "vitest";
import type { Context } from "hono";
import { deriveTdaiIdentity, getTdaiIdentity } from "../../tdai/identity.js";
import { restoreSessionSpaceId } from "../restore-space-id.js";
import { isFreshConversation, resolveConversationId } from "../session-key.js";

const session = {
  team_id: "team-1",
  user_id: "user-1",
  agent_id: "agent-1",
  session_id: "session-1",
};

describe("TDAI identity boundary", () => {
  it.each(["team_id", "user_id", "agent_id", "session_id"])(
    "does not build a partial identity when %s is missing",
    (field) => {
      expect(deriveTdaiIdentity({ sessionInfo: { ...session, [field]: "  " } })).toBeNull();
    },
  );

  it("prefers session identity and normalizes surrounding whitespace", () => {
    expect(deriveTdaiIdentity({
      sessionInfo: { ...session, user_id: " user-1 ", task_id: " task-1 " },
      userId: "fallback-user",
      sessionKey: "fallback-session",
      userKey: " user-secret ",
    })).toEqual({
      teamId: "team-1", userId: "user-1", agentId: "agent-1", sessionId: "session-1",
      taskId: "task-1", userKey: "user-secret",
    });
  });

  it("uses authenticated user and request session only for absent session fields", () => {
    expect(deriveTdaiIdentity({
      sessionInfo: { team_id: "team-1", agent_id: "agent-1", user_id: 42, session_id: null },
      userId: "user-2", sessionKey: "session-2",
    })).toMatchObject({ userId: "user-2", sessionId: "session-2" });
  });

  it("does not infer missing team or agent from other custom metadata", () => {
    expect(getTdaiIdentity(undefined)).toBeNull();
    expect(getTdaiIdentity({ team_id: "team-1", agent_id: "agent-1" })).toBeNull();
    expect(getTdaiIdentity({ session, userKey: "key" })).toMatchObject({ userKey: "key" });
  });
});

describe("restored tenant identity", () => {
  it.each([undefined, "", null, 0])("fills a missing or invalid space value: %s", (space_id) => {
    const restored = { ...session, space_id };
    restoreSessionSpaceId(restored, "space-from-path");
    expect(restored).toEqual({ ...session, space_id: "space-from-path" });
  });

  it("preserves an already bound tenant", () => {
    const restored = { space_id: "existing-space" };
    restoreSessionSpaceId(restored, "different-space");
    expect(restored.space_id).toBe("existing-space");
  });

  it("is a no-op without either session state or a path space", () => {
    expect(() => restoreSessionSpaceId(null, "space")).not.toThrow();
    expect(() => restoreSessionSpaceId(undefined, "space")).not.toThrow();
    const restored = { space_id: "" };
    restoreSessionSpaceId(restored, undefined);
    restoreSessionSpaceId(restored, "");
    expect(restored.space_id).toBe("");
  });
});

describe("conversation routing", () => {
  const context = (headers: Record<string, string>) => ({
    req: { header: (name: string) => headers[name] },
  }) as unknown as Context;

  it("prioritizes explicit conversation IDs over client-specific aliases", () => {
    expect(resolveConversationId(context({
      "x-conversation-id": "conversation", "x-session-id": "session", "x-thread-id": "thread",
    }))).toBe("conversation");
  });

  it.each([
    "x-session-id", "x-claude-code-session-id", "x-deepseek-harness-session-id", "x-chat-id", "x-thread-id",
  ])("accepts the %s alias", (header) => {
    expect(resolveConversationId(context({ [header]: "session-id" }))).toBe("session-id");
  });

  it("returns null when no session header exists", () => {
    expect(resolveConversationId(context({}))).toBeNull();
  });

  it.each([
    [[], true],
    [[{ role: "system" }, { role: "user" }], true],
    [[{ role: "user" }, { role: "user" }], false],
    [[{ role: "assistant" }], false],
    [[{ role: "tool" }], false],
  ] as const)("classifies freshness of %j", (messages, expected) => {
    expect(isFreshConversation([...messages])).toBe(expected);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { Transport } from "../src/client.js";
import { ParamError } from "../src/errors.js";
import { MemoryClient } from "../src/v3/client.js";

function setup() {
  const transport: Transport = { post: async <T>() => ({} as T) };
  const post = vi.spyOn(transport, "post");
  const client = new MemoryClient(transport, {
    team_id: "team-test",
    agent_id: "agent-test",
    user_id: "user-test",
    session_id: "constructor-session-must-not-be-deleted",
  });
  return { client, post };
}

const sessions = (count: number) => Array.from({ length: count }, (_, i) => `session-${i}`);
const isolation = {
  team_id: "team-test",
  agent_id: "agent-test",
  user_id: "user-test",
};

describe("conversation deletion session limits", () => {
  it.each([undefined, ["message-1"]])(
    "rejects merged overflow before sending a request (message_ids: %s)",
    (messageIds) => {
      const { client, post } = setup();
      const sessionIds = sessions(100);

      expect(() => client.deleteConversation({
        session_ids: sessionIds,
        session_id: "session-extra",
        message_ids: messageIds,
      })).toThrow(new ParamError("session_ids accepts at most 100 items, got 101"));
      expect(post).not.toHaveBeenCalled();
      expect(sessionIds).toEqual(sessions(100));
    },
  );

  it.each([
    { name: "boundary", ids: sessions(99), legacy: "session-99", expected: sessions(100) },
    { name: "duplicate legacy", ids: sessions(100), legacy: "session-0", expected: sessions(100) },
    {
      name: "trim and deduplicate",
      ids: [...sessions(100), "session-0"],
      legacy: " session-0 ",
      expected: sessions(100),
    },
    { name: "legacy only", ids: undefined, legacy: " legacy-session ", expected: ["legacy-session"] },
  ])("accepts normalized sessions at or below the limit: $name", async ({ ids, legacy, expected }) => {
    const { client, post } = setup();
    const original = ids ? [...ids] : undefined;

    await client.deleteConversation({ session_ids: ids, session_id: legacy });

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/v3/conversation/delete", {
      ...isolation,
      session_ids: expected,
    });
    expect(ids).toEqual(original);
  });

  it.each(["", "   "])("rejects empty legacy session %j", (legacy) => {
    const { client, post } = setup();
    expect(() => client.deleteConversation({ session_id: legacy }))
      .toThrow(new ParamError("session_id must be a non-empty string"));
    expect(post).not.toHaveBeenCalled();
  });

  it("does not use the constructor session for a message-only delete", async () => {
    const { client, post } = setup();
    await client.deleteConversation({ message_ids: ["message-1"] });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/v3/conversation/delete", {
      ...isolation,
      message_ids: ["message-1"],
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import type { Transport } from "../src/client.js";
import { ParamError } from "../src/errors.js";
import { MemoryClient } from "../src/v3/client.js";
import type { V3IsolationContext } from "../src/v3/types.js";

const isolation: V3IsolationContext = {
  team_id: "team-a", agent_id: "agent-a", user_id: "user-a",
  session_id: "session-a", task_id: "task-a",
};
const messages = [{ role: "user" as const, content: "Remember this preference" }];

function setup(ids: V3IsolationContext = isolation) {
  const post = vi.fn().mockResolvedValue({});
  return { client: new MemoryClient({ post } as Transport, ids), post };
}

describe("v3 memory isolation", () => {
  it.each(["team_id", "agent_id", "user_id"] as const)("requires %s", (field) => {
    expect(() => setup({ ...isolation, [field]: "" })).toThrow(ParamError);
  });

  it("requires a session for writes while allowing reads across sessions", async () => {
    const { client, post } = setup({ ...isolation, session_id: undefined });
    expect(() => client.addConversation({ messages })).toThrow(/requires session_id/);
    expect(post).not.toHaveBeenCalled();
    await client.queryConversation();
    expect(post).toHaveBeenCalledWith("/v3/conversation/query", {
      team_id: "team-a", agent_id: "agent-a", user_id: "user-a", task_id: "task-a",
    });
  });

  it("lets a write explicitly override the default session", async () => {
    const { client, post } = setup();
    await client.addConversation({ messages, session_id: "session-b" });
    expect(post).toHaveBeenCalledWith("/v3/conversation/add", {
      ...isolation, session_id: "session-b", messages,
    });
  });

  it("clones isolation without changing the original client and can clear optional defaults", async () => {
    const { client, post } = setup();
    const other = client.withIsolation({ userId: "user-b", sessionId: null, taskId: null });
    await other.queryConversation({ limit: 10 });
    await client.queryConversation();
    expect(post).toHaveBeenNthCalledWith(1, "/v3/conversation/query", {
      team_id: "team-a", agent_id: "agent-a", user_id: "user-b", limit: 10,
    });
    expect(post).toHaveBeenNthCalledWith(2, "/v3/conversation/query", isolation);
  });

  it("does not carry a conversation session into scenario or core operations", async () => {
    const { client, post } = setup();
    await client.readScenario({ path: "/preferences" });
    await client.readCore();
    const { session_id: _session, ...profileIsolation } = isolation;
    expect(post).toHaveBeenNthCalledWith(1, "/v3/scenario/read", { ...profileIsolation, path: "/preferences" });
    expect(post).toHaveBeenNthCalledWith(2, "/v3/core/read", profileIsolation);
  });
});

describe("destructive operation boundaries", () => {
  it("does not turn the default session into an implicit delete scope", () => {
    const { client, post } = setup();
    expect(() => client.deleteConversation()).toThrow(ParamError);
    expect(post).not.toHaveBeenCalled();
  });

  it("normalizes duplicate message IDs without deleting the default session", async () => {
    const { client, post } = setup();
    await client.deleteConversation({ message_ids: [" message-a ", "message-a", "message-b"] });
    expect(post).toHaveBeenCalledWith("/v3/conversation/delete", {
      team_id: "team-a", agent_id: "agent-a", user_id: "user-a", task_id: "task-a",
      message_ids: ["message-a", "message-b"],
    });
  });

  it.each([{ ids: [] }, { ids: [""] }, { ids: ["  "] }])("rejects invalid atomic delete IDs $ids before sending", ({ ids }) => {
    const { client, post } = setup();
    expect(() => client.deleteAtomic({ ids })).toThrow(ParamError);
    expect(post).not.toHaveBeenCalled();
  });

  it("applies the 5000-message limit after deduplication", async () => {
    const { client, post } = setup();
    const ids = Array.from({ length: 5000 }, (_, index) => `message-${index}`);
    await client.deleteConversation({ message_ids: [...ids, ids[0]] });
    expect(post.mock.calls[0][1].message_ids).toHaveLength(5000);
    post.mockClear();
    expect(() => client.deleteConversation({ message_ids: [...ids, "one-too-many"] })).toThrow(/at most 5000/);
    expect(post).not.toHaveBeenCalled();
  });

  it("deduplicates legacy and array session IDs together", async () => {
    const { client, post } = setup();
    await client.deleteConversation({ session_ids: [" session-b ", "session-b"], session_id: "session-b" });
    expect(post.mock.calls[0][1].session_ids).toEqual(["session-b"]);
  });

  it("enforces the 100-session limit after merging the legacy session field", () => {
    const { client, post } = setup();
    expect(() => client.deleteConversation({
      session_ids: Array.from({ length: 100 }, (_, index) => `session-${index}`),
      session_id: "additional-session",
    })).toThrow(/at most 100/);
    expect(post).not.toHaveBeenCalled();
  });

  it("accepts exactly 100 sessions when the legacy value is already included", async () => {
    const { client, post } = setup();
    await client.deleteConversation({
      session_ids: Array.from({ length: 100 }, (_, index) => `session-${index}`),
      session_id: "session-0",
    });
    expect(post.mock.calls[0][1].session_ids).toHaveLength(100);
  });

  it("validates and trims the legacy session field consistently with session_ids", async () => {
    const { client, post } = setup();
    expect(() => client.deleteConversation({ session_id: "  " })).toThrow(ParamError);
    expect(post).not.toHaveBeenCalled();
    await client.deleteConversation({ session_id: " session-b " });
    expect(post.mock.calls[0][1].session_ids).toEqual(["session-b"]);
  });

  it("uses explicit asset IDs alone for chat-memory clear", async () => {
    const { client, post } = setup();
    await client.clearChatMemory({ memory_ids: [" memory-a ", "memory-a"] });
    expect(post).toHaveBeenCalledWith("/v3/chat-memory/clear", { memory_ids: ["memory-a"] });
  });

  it("rejects an empty or oversized asset clear before sending", () => {
    const { client, post } = setup();
    expect(() => client.clearChatMemory({ memory_ids: [] })).toThrow(ParamError);
    expect(() => client.clearChatMemory({
      memory_ids: Array.from({ length: 101 }, (_, index) => `memory-${index}`),
    })).toThrow(/at most 100/);
    expect(post).not.toHaveBeenCalled();
  });
});

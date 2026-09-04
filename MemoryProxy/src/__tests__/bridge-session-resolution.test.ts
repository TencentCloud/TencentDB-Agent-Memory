import { describe, expect, it, beforeEach } from "vitest";
import { SessionStore, getSessionStore, __resetSessionStoreForTests } from "../session/store.js";
import type { SessionInitState } from "../session/types.js";

function makeInitializedState(agentId: string, teamId: string): SessionInitState {
  return {
    status: "initialized",
    keyId: "",
    startedAt: Date.now(),
    attemptCount: 0,
    sessionInfo: {
      session_id: "",
      team_id: teamId,
      agent_id: agentId,
      user_id: "usr-test",
      user_key: "key-test",
      space_id: "default",
    },
    userId: "usr-test",
    agentDetail: null,
    taskDetail: null,
  };
}

describe("SessionStore.keysWithSuffix", () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(30 * 60 * 1000);
  });

  it("finds a key by bare sessionId match", () => {
    store.set("pi:abc-123", makeInitializedState("agt-1", "team-1"));
    expect(store.keysWithSuffix("abc-123")).toEqual(["pi:abc-123"]);
  });

  it("finds keys by `:${sessionId}` suffix across multiple agent sources", () => {
    store.set("pi:abc-123", makeInitializedState("agt-1", "team-1"));
    store.set("dsh:abc-123", makeInitializedState("agt-2", "team-2"));
    store.set("claude-code:abc-123", makeInitializedState("agt-3", "team-3"));
    store.set("codex:def-456", makeInitializedState("agt-4", "team-4"));
    const found = store.keysWithSuffix("abc-123");
    expect(found.sort()).toEqual(["claude-code:abc-123", "dsh:abc-123", "pi:abc-123"]);
  });

  it("returns empty array when no key matches", () => {
    store.set("pi:abc-123", makeInitializedState("agt-1", "team-1"));
    expect(store.keysWithSuffix("zzz-000")).toEqual([]);
  });

  it("does not match a sessionId that is a substring but not a suffix", () => {
    store.set("pi:abc-123-extra", makeInitializedState("agt-1", "team-1"));
    expect(store.keysWithSuffix("abc-123")).toEqual([]);
  });
});

describe("bridge L1 resolution via keysWithSuffix (integration)", () => {
  beforeEach(() => {
    __resetSessionStoreForTests();
  });

  it("memory-bridge loadSessionIdsL1 finds a pi-prefixed session with a bare sessionId", async () => {
    const store = getSessionStore();
    store.set("pi:pi-01abc", makeInitializedState("agt-ea0b0wybln", "team-azqo3jvm25"));

    // The bridge receives a bare sessionId from x-conversation-id.
    // The old code tried [bare, "codebuddy:bare", "claude-code:bare"] — all miss.
    // The new code uses keysWithSuffix to find "pi:pi-01abc".
    const candidates = store.keysWithSuffix("pi-01abc");
    expect(candidates).toEqual(["pi:pi-01abc"]);

    const state = store.get(candidates[0]);
    expect(state?.status).toBe("initialized");
    expect(state?.sessionInfo?.agent_id).toBe("agt-ea0b0wybln");
  });

  it("memory-bridge loadSessionIdsL1 finds a dsh-prefixed session with a bare sessionId", async () => {
    const store = getSessionStore();
    store.set("dsh:dsh-02def", makeInitializedState("agt-dsh", "team-dsh"));

    const candidates = store.keysWithSuffix("dsh-02def");
    expect(candidates).toEqual(["dsh:dsh-02def"]);

    const state = store.get(candidates[0]);
    expect(state?.sessionInfo?.agent_id).toBe("agt-dsh");
  });
});

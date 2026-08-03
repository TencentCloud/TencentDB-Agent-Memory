import { describe, expect, it } from "vitest";
import { SessionStore, type SessionIdentity } from "../store.js";
import type { SessionInitState } from "../types.js";

const identity: SessionIdentity = {
  userId: "user-1",
  agentSource: "codebuddy",
  sessionId: "session-1",
};

function pendingState(keyId: string, startedAt: number): SessionInitState {
  return {
    status: "pending_asset_confirm",
    keyId,
    startedAt,
    attemptCount: 0,
  };
}

describe("SessionStore identity lifecycle", () => {
  it("releases the bound identity when a session is explicitly deleted", () => {
    const store = new SessionStore();
    store.bind("key-1", identity);

    store.delete("key-1");

    expect(store.getBoundIdentity("key-1")).toBeUndefined();
  });

  it("releases the bound identity when get evicts an expired pending state", async () => {
    const store = new SessionStore(10);
    store.bind("key-1", identity);
    await store.set("key-1", pendingState("key-1", Date.now() - 100));

    expect(store.get("key-1")).toBeUndefined();
    expect(store.getBoundIdentity("key-1")).toBeUndefined();
  });

  it("cleanup releases only identities whose pending states expired", async () => {
    const store = new SessionStore(10);
    const now = Date.now();

    store.bind("expired", { ...identity, sessionId: "expired" });
    store.bind("fresh", { ...identity, sessionId: "fresh" });
    store.bind("initialized", { ...identity, sessionId: "initialized" });
    await store.set("expired", pendingState("expired", now - 100));
    await store.set("fresh", pendingState("fresh", now));
    await store.set("initialized", {
      status: "initialized",
      keyId: "initialized",
      startedAt: now - 100,
      attemptCount: 0,
    });

    store.cleanup();

    expect(store.getBoundIdentity("expired")).toBeUndefined();
    expect(store.getBoundIdentity("fresh")).toBeDefined();
    expect(store.getBoundIdentity("initialized")).toBeDefined();
  });
});

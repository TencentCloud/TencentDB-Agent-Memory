import { describe, expect, it } from "vitest";
import { MemorySessionStore, type IdpSession } from "../src/panel/auth/session-store.js";

function input(id: string): Omit<IdpSession, "token" | "createdAt" | "expiresAt"> {
  return {
    instanceId: "i-1",
    coreUserId: `u-${id}`,
    userKey: `sk-mem-${id}`,
    providerId: "p-1",
    externalSubject: `s-${id}`,
  };
}

/**
 * Previously, expired sessions were only removed lazily when get(token) was
 * called with that exact token. Sessions that were never revisited stayed in
 * the in-memory Map forever, growing without bound over a long-running panel.
 * create() now reclaims all expired entries and enforces a capacity cap.
 */
describe("MemorySessionStore — expiry reclamation & capacity cap", () => {
  it("reclaims expired sessions created earlier on a later create()", () => {
    const store = new MemorySessionStore(1); // 1s TTL
    const a = store.create(input("a"));
    expect(store.get(a.token)).not.toBeNull();

    // Force expiry without real waiting by monkey-patching Date.now.
    const realNow = Date.now;
    Date.now = () => realNow() + 2_000;
    try {
      store.create(input("b")); // triggers bulk reclamation of expired 'a'
      expect(store.get(a.token)).toBeNull();
      expect(store.get(store.create(input("c")).token)).not.toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  it("enforces maxSessions by evicting the oldest entry", () => {
    const store = new MemorySessionStore(3600, 2);
    const a = store.create(input("a"));
    const b = store.create(input("b"));
    const c = store.create(input("c")); // should evict 'a'

    expect(store.get(a.token)).toBeNull();
    expect(store.get(b.token)).not.toBeNull();
    expect(store.get(c.token)).not.toBeNull();
  });

  it("get() still lazily removes an expired session it is asked for", () => {
    const store = new MemorySessionStore(1);
    const a = store.create(input("a"));
    const realNow = Date.now;
    Date.now = () => realNow() + 2_000;
    try {
      expect(store.get(a.token)).toBeNull();
    } finally {
      Date.now = realNow;
    }
    expect(store.get(a.token)).toBeNull();
  });
});

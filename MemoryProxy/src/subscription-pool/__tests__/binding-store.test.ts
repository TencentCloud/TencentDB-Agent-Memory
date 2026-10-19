import { describe, expect, it } from "vitest";
import { MemoryStorage } from "../../storage/memory-storage.js";
import {
  BINDING_TTL_MS, bindSession, countSessionsByAccount, getBinding, getCursor, rebindSession, sessionBindingKey, setCursor,
} from "../binding-store.js";

const NOW = 1_800_000_000_000;
const DAY = 24 * 3_600_000;

describe("binding store", () => {
  it("builds a key that does not contain the raw session id", () => {
    const key = sessionBindingKey("sp1", "codex", "sess/with..odd chars");
    expect(key.startsWith("nottl/sp1/pool-binding/codex/")).toBe(true);
    expect(key).not.toContain("odd chars");
    expect(sessionBindingKey("sp1", "codex", "s1")).not.toBe(sessionBindingKey("sp1", "codex", "s2"));
    expect(sessionBindingKey("sp1", "codex", "s1")).not.toBe(sessionBindingKey("sp2", "codex", "s1"));
  });

  it("two concurrent first requests create one binding", async () => {
    const storage = new MemoryStorage();
    const key = sessionBindingKey("sp1", "codex", "s1");
    const [a, b] = await Promise.all([
      bindSession(storage, key, "acc-1", NOW),
      bindSession(storage, key, "acc-2", NOW),
    ]);
    expect(a.accountId).toBe(b.accountId);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect((await getBinding(storage, key, NOW))?.account_id).toBe(a.accountId);
  });

  it("an existing binding wins over a later bind attempt", async () => {
    const storage = new MemoryStorage();
    const key = sessionBindingKey("sp1", "codex", "s1");
    await bindSession(storage, key, "acc-1", NOW);
    const second = await bindSession(storage, key, "acc-2", NOW + 1000);
    expect(second).toEqual({ accountId: "acc-1", created: false });
  });

  it("a binding expires after two days without requests", async () => {
    const storage = new MemoryStorage();
    const key = sessionBindingKey("sp1", "codex", "s1");
    await bindSession(storage, key, "acc-1", NOW);
    expect(await getBinding(storage, key, NOW + BINDING_TTL_MS - 1)).not.toBeNull();
    expect(await getBinding(storage, key, NOW + BINDING_TTL_MS + 1)).toBeNull();
    expect(await storage.exists(key)).toBe(false);
  });

  it("an expired binding is replaced by a new bind", async () => {
    const storage = new MemoryStorage();
    const key = sessionBindingKey("sp1", "codex", "s1");
    await bindSession(storage, key, "acc-1", NOW);
    const later = NOW + 3 * DAY;
    const fresh = await bindSession(storage, key, "acc-2", later);
    expect(fresh).toEqual({ accountId: "acc-2", created: true });
  });

  it("a request within the lifetime extends it", async () => {
    const storage = new MemoryStorage();
    const key = sessionBindingKey("sp1", "codex", "s1");
    await bindSession(storage, key, "acc-1", NOW);
    await rebindSession(storage, key, "acc-1", NOW + 1.5 * DAY);
    expect(await getBinding(storage, key, NOW + 3 * DAY)).not.toBeNull();
  });

  it("rebind moves the session to another account", async () => {
    const storage = new MemoryStorage();
    const key = sessionBindingKey("sp1", "codex", "s1");
    await bindSession(storage, key, "acc-1", NOW);
    await rebindSession(storage, key, "acc-2", NOW + 10);
    expect((await getBinding(storage, key, NOW + 20))?.account_id).toBe("acc-2");
  });

  it("counts live sessions per account and prunes expired ones", async () => {
    const storage = new MemoryStorage();
    await bindSession(storage, sessionBindingKey("sp1", "codex", "s1"), "acc-1", NOW);
    await bindSession(storage, sessionBindingKey("sp1", "codex", "s2"), "acc-1", NOW);
    await bindSession(storage, sessionBindingKey("sp1", "codex", "s3"), "acc-2", NOW);
    await bindSession(storage, sessionBindingKey("sp2", "codex", "s4"), "acc-2", NOW);
    await bindSession(storage, sessionBindingKey("sp1", "codex", "old"), "acc-2", NOW - 5 * DAY);
    const counts = await countSessionsByAccount(storage, "sp1", "codex", NOW);
    expect(counts.get("acc-1")).toBe(2);
    expect(counts.get("acc-2")).toBe(1);
    expect(await storage.exists(sessionBindingKey("sp1", "codex", "old"))).toBe(false);
  });

  it("stores the round-robin cursor per instance and provider", async () => {
    const storage = new MemoryStorage();
    expect(await getCursor(storage, "sp1", "codex")).toBe(0);
    await setCursor(storage, "sp1", "codex", 3);
    expect(await getCursor(storage, "sp1", "codex")).toBe(3);
    expect(await getCursor(storage, "sp2", "codex")).toBe(0);
  });
});

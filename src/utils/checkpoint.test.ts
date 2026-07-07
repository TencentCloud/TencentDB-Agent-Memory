import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CheckpointManager } from "./checkpoint.js";
import type { IMemoryStore } from "../core/store/types.js";

function makeDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "cp-test-"));
}

function mockStore(l1: number, l0: number): Pick<IMemoryStore, "countL1" | "countL0"> & IMemoryStore {
  return {
    countL1: async () => l1,
    countL0: async () => l0,
  } as unknown as IMemoryStore;
}

describe("CheckpointManager.recalibrate", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeDir();
    await fs.mkdir(path.join(dir, ".metadata"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("is a no-op when store is not provided", async () => {
    const cm = new CheckpointManager(dir);
    await cm.recalibrate();
    // No checkpoint file should be created
    const filePath = path.join(dir, ".metadata", "recall_checkpoint.json");
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("writes store counts into the checkpoint", async () => {
    const cm = new CheckpointManager(dir);
    const store = mockStore(42, 7);
    const result = await cm.recalibrate(store);

    expect(result).toEqual({ total_memories_extracted: 42, l0_conversations_count: 7 });
    const cp = await cm.read();
    expect(cp.total_memories_extracted).toBe(42);
    expect(cp.l0_conversations_count).toBe(7);
  });

  it("returns undefined when store is not provided", async () => {
    const cm = new CheckpointManager(dir);
    const result = await cm.recalibrate();
    expect(result).toBeUndefined();
  });

  it("corrects inflated counters left by memory-cleaner", async () => {
    const cm = new CheckpointManager(dir);
    // Simulate drift: counters say 1000/500 but actual store holds far fewer
    const store = mockStore(1000, 500);
    await cm.recalibrate(store);

    const store2 = mockStore(8, 3);
    await cm.recalibrate(store2);

    const cp = await cm.read();
    expect(cp.total_memories_extracted).toBe(8);
    expect(cp.l0_conversations_count).toBe(3);
  });

  it("handles zero counts (empty store)", async () => {
    const cm = new CheckpointManager(dir);
    await cm.recalibrate(mockStore(0, 0));
    const cp = await cm.read();
    expect(cp.total_memories_extracted).toBe(0);
    expect(cp.l0_conversations_count).toBe(0);
  });

  it("returns undefined and skips write when store throws", async () => {
    const cm = new CheckpointManager(dir);
    // Seed a known counter value
    await cm.recalibrate(mockStore(10, 5));

    const throwingStore = {
      countL1: async () => { throw new Error("SQLite connection lost"); },
      countL0: async () => 0,
    } as unknown as IMemoryStore;

    const result = await cm.recalibrate(throwingStore);
    expect(result).toBeUndefined();

    // Counters must remain unchanged — no partial write
    const cp = await cm.read();
    expect(cp.total_memories_extracted).toBe(10);
    expect(cp.l0_conversations_count).toBe(5);
  });

  it("preserves unrelated checkpoint fields after recalibration", async () => {
    const cm = new CheckpointManager(dir);
    // Set a sentinel value on an unrelated field
    await cm.markPersonaGenerated(99);
    const before = await cm.read();
    expect(before.last_persona_at).toBe(99);

    await cm.recalibrate(mockStore(5, 2));

    const after = await cm.read();
    expect(after.total_memories_extracted).toBe(5);
    expect(after.l0_conversations_count).toBe(2);
    expect(after.last_persona_at).toBe(99);
  });

  // ─── memories_since_last_persona adjustment ───────────────────────────────

  it("decrements memories_since_last_persona by the number of removed L1 records", async () => {
    const cm = new CheckpointManager(dir);
    // Seed: 10 total L1, 8 since last persona update
    await cm.recalibrate(mockStore(10, 5));
    const seeded = await cm.read();
    // manually bump memories_since_last_persona to a known value
    await (cm as any).mutate((cp: any) => { cp.memories_since_last_persona = 8; });

    // Recalibrate down to 4 L1 records (6 removed)
    await cm.recalibrate(mockStore(4, 5));

    const after = await cm.read();
    expect(after.total_memories_extracted).toBe(4);
    // 8 - 6 = 2
    expect(after.memories_since_last_persona).toBe(2);
  });

  it("does not let memories_since_last_persona go below zero", async () => {
    const cm = new CheckpointManager(dir);
    await cm.recalibrate(mockStore(10, 5));
    await (cm as any).mutate((cp: any) => { cp.memories_since_last_persona = 2; });

    // Remove 10 L1 records — more than memories_since_last_persona
    await cm.recalibrate(mockStore(0, 5));

    const after = await cm.read();
    expect(after.memories_since_last_persona).toBe(0);
  });

  it("does not change memories_since_last_persona when L1 count increases", async () => {
    const cm = new CheckpointManager(dir);
    await cm.recalibrate(mockStore(5, 3));
    await (cm as any).mutate((cp: any) => { cp.memories_since_last_persona = 4; });

    // Store grew — no records removed, so counter must stay unchanged
    await cm.recalibrate(mockStore(9, 3));

    const after = await cm.read();
    expect(after.memories_since_last_persona).toBe(4);
  });
});

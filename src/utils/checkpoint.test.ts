import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CheckpointManager } from "./checkpoint.js";
import fs from "node:fs/promises";
import path from "node:path";

describe("CheckpointManager adjustCounters", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join("/tmp", `test-checkpoint-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it("decreases counters by confirmed deletions without going negative", async () => {
    const cp = new CheckpointManager(testDir);
    const cpData = {
      total_processed: 100,
      l0_conversations_count: 50,
      total_memories_extracted: 30,
      memories_since_last_persona: 15,
    };
    await cp.write(cpData);

    await cp.adjustCounters(20, 10);

    const after = await cp.read();
    expect(after.total_processed).toBe(80);
    expect(after.l0_conversations_count).toBe(30);
    expect(after.total_memories_extracted).toBe(20);
    expect(after.memories_since_last_persona).toBe(5);
  });

  it("clamps at zero on over-deletion", async () => {
    const cp = new CheckpointManager(testDir);
    const cpData = {
      total_processed: 5,
      l0_conversations_count: 3,
      total_memories_extracted: 2,
      memories_since_last_persona: 0,
    };
    await cp.write(cpData);

    await cp.adjustCounters(10, 5);

    const after = await cp.read();
    expect(after.total_processed).toBe(0);
    expect(after.l0_conversations_count).toBe(0);
    expect(after.total_memories_extracted).toBe(0);
    expect(after.memories_since_last_persona).toBe(0);
  });
});

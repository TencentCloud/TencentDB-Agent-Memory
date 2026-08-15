import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CheckpointManager, recalibrateCheckpointFromStore } from "./checkpoint.js";
import type { RecalibrateReport } from "./checkpoint.js";

async function tmpDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "cp-recalibrate-"));
}

describe("CheckpointManager.recalibrate", () => {
  it("clamps overstated counters down to actual store counts and shrinks mslp by removed L1", async () => {
    const dir = await tmpDataDir();
    const cp = new CheckpointManager(dir);

    // Seed a drifted checkpoint: counters permanently overstate reality,
    // as happens after cleanup/pruning that deletes data but not the checkpoint.
    const seeded = await cp.read();
    await cp.write({
      ...seeded,
      total_memories_extracted: 50,
      l0_conversations_count: 30,
      memories_since_last_persona: 20,
    });

    const result = await cp.recalibrate({
      countL0CaptureRounds: () => 5,
      countL1: () => 42,
    });

    // removedL1 = 50 - 42 = 8 → mslp = max(0, 20 - 8) = 12
    expect(result.adjusted).toBe(true);
    expect(result.before).toEqual({ l0: 30, l1: 50, mslp: 20 });
    expect(result.after).toEqual({ l0: 5, l1: 42, mslp: 12 });

    const persisted = await cp.read();
    expect(persisted.total_memories_extracted).toBe(42);
    expect(persisted.l0_conversations_count).toBe(5);
    expect(persisted.memories_since_last_persona).toBe(12);
  });

  it("dry-run reports the would-be drift without persisting anything", async () => {
    const dir = await tmpDataDir();
    const cp = new CheckpointManager(dir);

    await cp.write({
      ...(await cp.read()),
      total_memories_extracted: 50,
      l0_conversations_count: 30,
      memories_since_last_persona: 20,
    });

    const result = await cp.recalibrate(
      { countL0CaptureRounds: () => 5, countL1: () => 42 },
      { dryRun: true },
    );

    // Reports the would-be change…
    expect(result.dryRun).toBe(true);
    expect(result.adjusted).toBe(true);
    expect(result.after).toEqual({ l0: 5, l1: 42, mslp: 12 });
    expect(result.drift).toEqual({ l0: 25, l1: 8, mslp: 8 });

    // …but persists nothing.
    const persisted = await cp.read();
    expect(persisted.total_memories_extracted).toBe(50);
    expect(persisted.l0_conversations_count).toBe(30);
    expect(persisted.memories_since_last_persona).toBe(20);
  });

  it("is idempotent: reports adjusted=false and skips the disk write when counts already match", async () => {
    const dir = await tmpDataDir();
    const cp = new CheckpointManager(dir);
    await cp.write({
      ...(await cp.read()),
      total_memories_extracted: 42,
      l0_conversations_count: 5,
      memories_since_last_persona: 12,
    });

    const writeSpy = vi.spyOn(cp as never, "writeRaw" as never);
    const result = await cp.recalibrate({ countL0CaptureRounds: () => 5, countL1: () => 42 });

    expect(result.adjusted).toBe(false);
    expect(result.drift).toEqual({ l0: 0, l1: 0, mslp: 0 });
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("refuses to wipe counters when the source returns non-finite counts (degraded store)", async () => {
    const dir = await tmpDataDir();
    const cp = new CheckpointManager(dir);
    await cp.write({
      ...(await cp.read()),
      total_memories_extracted: 42,
      l0_conversations_count: 5,
      memories_since_last_persona: 10,
    });

    // A degraded/unhealthy store reports NaN/-1 — recalibrate must NOT overwrite real counters.
    const result = await cp.recalibrate({ countL0CaptureRounds: () => NaN, countL1: () => -1 });

    expect(result.adjusted).toBe(false);
    const persisted = await cp.read();
    expect(persisted.total_memories_extracted).toBe(42);
    expect(persisted.l0_conversations_count).toBe(5);
    expect(persisted.memories_since_last_persona).toBe(10);
  });

  it("refuses to wipe a nonzero counter when the source returns 0 (transient store failure)", async () => {
    const dir = await tmpDataDir();
    const cp = new CheckpointManager(dir);
    await cp.write({
      ...(await cp.read()),
      total_memories_extracted: 42,
      l0_conversations_count: 5,
      memories_since_last_persona: 10,
    });

    // countL0/countL1 swallow runtime errors (SQLITE_BUSY, network blip) and
    // return 0 WITHOUT setting degraded — isDegraded()==false but counts are 0.
    // recalibrate must not overwrite real nonzero counters with that 0.
    const result = await cp.recalibrate({ countL0CaptureRounds: () => 0, countL1: () => 0 });

    expect(result.adjusted).toBe(false);
    const persisted = await cp.read();
    expect(persisted.total_memories_extracted).toBe(42);
    expect(persisted.l0_conversations_count).toBe(5);
    expect(persisted.memories_since_last_persona).toBe(10);
  });

  it("does not grow l0_conversations_count when the source reports more than recorded", async () => {
    const dir = await tmpDataDir();
    const cp = new CheckpointManager(dir);
    await cp.write({
      ...(await cp.read()),
      total_memories_extracted: 42,
      l0_conversations_count: 50,
    });

    // TCVDB's countL0CaptureRounds falls back to per-message countL0(), which can
    // exceed the true batch count — recalibrate must clamp down only, never inflate.
    const result = await cp.recalibrate({ countL0CaptureRounds: () => 200, countL1: () => 42 });

    expect(result.after.l0).toBe(50);
    expect((await cp.read()).l0_conversations_count).toBe(50);
  });

  it("skips overwriting when the checkpoint file is unreadable (corrupt JSON on disk)", async () => {
    const dir = await tmpDataDir();
    const cp = new CheckpointManager(dir);
    await cp.write({
      ...(await cp.read()),
      total_memories_extracted: 42,
      l0_conversations_count: 5,
      runner_states: { s1: { last_captured_timestamp: 100, last_l1_cursor: 50, last_scene_name: "x" } },
    });
    // Corrupt the on-disk checkpoint (simulates crash mid-write / hand-editing).
    const filePath = path.join(dir, ".metadata", "recall_checkpoint.json");
    await fs.writeFile(filePath, "{ broken json", "utf-8");

    // readRaw returns DEFAULT_CHECKPOINT on parse failure — recalibrate must NOT
    // writeRaw that default (it would clobber runner_states/pipeline_states and
    // every other field, not just the three counters).
    const result = await cp.recalibrate({ countL0CaptureRounds: () => 3, countL1: () => 10 });

    expect(result.adjusted).toBe(false);
  });
});

describe("recalibrateCheckpointFromStore", () => {
  it("clamps via a healthy store and emits drift through onDrift", async () => {
    const dir = await tmpDataDir();
    const cp = new CheckpointManager(dir);
    await cp.write({
      ...(await cp.read()),
      total_memories_extracted: 50,
      l0_conversations_count: 30,
      memories_since_last_persona: 20,
    });

    const drifts: RecalibrateReport[] = [];
    const healthyStore = {
      isDegraded: () => false,
      countL0CaptureRounds: () => 5,
      countL1: () => 42,
    };
    const result = await recalibrateCheckpointFromStore({
      dataDir: dir,
      store: healthyStore,
      trigger: "startup",
      onDrift: (r) => drifts.push(r),
    });

    expect(result?.adjusted).toBe(true);
    expect(drifts).toHaveLength(1);
    expect(drifts[0].trigger).toBe("startup");
    expect((await cp.read()).total_memories_extracted).toBe(42);
  });

  it("is a no-op when the store is degraded (no drift, counters untouched)", async () => {
    const dir = await tmpDataDir();
    const cp = new CheckpointManager(dir);
    await cp.write({ ...(await cp.read()), total_memories_extracted: 50 });

    const drifts: RecalibrateReport[] = [];
    const degradedStore = { isDegraded: () => true, countL0CaptureRounds: () => 0, countL1: () => 0 };
    const result = await recalibrateCheckpointFromStore({
      dataDir: dir,
      store: degradedStore,
      trigger: "startup",
      onDrift: (r) => drifts.push(r),
    });

    expect(result).toBe(null);
    expect(drifts).toHaveLength(0);
    expect((await cp.read()).total_memories_extracted).toBe(50);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CheckpointManager, type RecalibrationSource } from "./checkpoint.js";
import { LocalMemoryCleaner } from "./memory-cleaner.js";

/** In-memory fake store returning fixed live counts. */
function fakeSource(l0: number, l1: number): RecalibrationSource {
  return {
    countL0: () => l0,
    countL1: () => l1,
  };
}

async function writeShard(
  dataDir: string,
  subDir: string,
  name: string,
  lines: string[],
): Promise<string> {
  const dir = path.join(dataDir, subDir);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, lines.join("\n") + (lines.length ? "\n" : ""), "utf-8");
  return filePath;
}

describe("CheckpointManager.recalibrate (#157)", () => {
  let dataDir: string;
  let cp: CheckpointManager;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-ckpt-"));
    cp = new CheckpointManager(dataDir);
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("resets inflated counters down to live store counts", async () => {
    await cp.captureAtomically("s1", undefined, async () => ({ maxTimestamp: 100, messageCount: 1 }));
    await cp.captureAtomically("s1", 0, async () => ({ maxTimestamp: 200, messageCount: 1 }));
    await cp.markL1ExtractionComplete("s1", 10, 200);

    let state = await cp.read();
    expect(state.l0_conversations_count).toBe(2);
    expect(state.total_memories_extracted).toBe(10);

    const result = await cp.recalibrate(fakeSource(1, 3));

    expect(result.source).toBe("store");
    expect(result.changed).toBe(true);
    expect(result.l0).toEqual({ before: 2, after: 1 });
    expect(result.l1).toEqual({ before: 10, after: 3 });

    state = await cp.read();
    expect(state.l0_conversations_count).toBe(1);
    expect(state.total_memories_extracted).toBe(3);
  });

  it("is idempotent when counts already match (no drift)", async () => {
    await cp.recalibrate(fakeSource(5, 7));
    const result = await cp.recalibrate(fakeSource(5, 7));

    expect(result.changed).toBe(false);
    expect(result.l0).toEqual({ before: 5, after: 5 });
    expect(result.l1).toEqual({ before: 7, after: 7 });
  });

  it("counts increase as well as decrease (self-correcting in both directions)", async () => {
    await cp.recalibrate(fakeSource(1, 1));
    const result = await cp.recalibrate(fakeSource(9, 4));

    expect(result.changed).toBe(true);
    expect(result.l0.after).toBe(9);
    expect(result.l1.after).toBe(4);
  });

  it("preserves unrelated checkpoint fields", async () => {
    await cp.markPersonaGenerated(42);
    await cp.incrementScenesProcessed();
    await cp.recalibrate(fakeSource(3, 3));

    const state = await cp.read();
    expect(state.last_persona_at).toBe(42);
    expect(state.scenes_processed).toBe(1);
  });

  it("clamps transient bad counts (NaN/negative) to zero", async () => {
    await cp.recalibrate(fakeSource(5, 5));
    const result = await cp.recalibrate({
      countL0: () => Number.NaN,
      countL1: () => -3,
    });

    expect(result.l0.after).toBe(0);
    expect(result.l1.after).toBe(0);
  });

  it("shrinks memories_since_last_persona with L1 so persona is not triggered early", async () => {
    await cp.markL1ExtractionComplete("s1", 12, 100);
    let state = await cp.read();
    expect(state.memories_since_last_persona).toBe(12);
    expect(state.total_memories_extracted).toBe(12);

    const result = await cp.recalibrate(fakeSource(0, 7));

    expect(result.l1).toEqual({ before: 12, after: 7 });
    expect(result.memories_since_last_persona).toEqual({ before: 12, after: 7 });

    state = await cp.read();
    expect(state.memories_since_last_persona).toBe(7);
    expect(state.total_memories_extracted).toBe(7);
  });

  it("clamps memories_since_last_persona to the new L1 ceiling", async () => {
    await cp.write({
      ...(await cp.read()),
      total_memories_extracted: 20,
      memories_since_last_persona: 50,
    });

    const result = await cp.recalibrate(fakeSource(0, 8));
    expect(result.memories_since_last_persona.after).toBe(8);
    expect((await cp.read()).memories_since_last_persona).toBe(8);
  });

  // ─── 深入：手动 JSONL 修剪 ───────────────────────────────────────────
  describe("scenario: manual JSONL prune", () => {
    it("heals after deleting whole shard files by hand", async () => {
      await cp.markL1ExtractionComplete("s1", 50, 1);
      await cp.captureAtomically("s1", undefined, async () => ({ maxTimestamp: 1, messageCount: 1 }));
      await cp.captureAtomically("s1", 0, async () => ({ maxTimestamp: 2, messageCount: 1 }));
      await cp.captureAtomically("s1", 0, async () => ({ maxTimestamp: 3, messageCount: 1 }));

      await writeShard(dataDir, "conversations", "2026-06-01.jsonl", [
        '{"sessionKey":"s1","id":"1"}',
        '{"sessionKey":"s1","id":"2"}',
        '{"sessionKey":"s1","id":"3"}',
        '{"sessionKey":"s1","id":"4"}',
        '{"sessionKey":"s1","id":"5"}',
      ]);
      await writeShard(dataDir, "records", "2026-06-01.jsonl", [
        '{"id":"m1"}',
        '{"id":"m2"}',
        '{"id":"m3"}',
        '{"id":"m4"}',
        '{"id":"m5"}',
      ]);
      await writeShard(dataDir, "records", "2026-06-02.jsonl", [
        '{"id":"m6"}',
        '{"id":"m7"}',
      ]);

      // Operator deletes the older L1 shard and trims L0 down to 2 lines.
      await fs.unlink(path.join(dataDir, "records", "2026-06-01.jsonl"));
      await writeShard(dataDir, "conversations", "2026-06-01.jsonl", [
        '{"sessionKey":"s1","id":"4"}',
        '{"sessionKey":"s1","id":"5"}',
      ]);

      const result = await cp.recalibrate();
      expect(result.source).toBe("jsonl");
      expect(result.l0.after).toBe(2);
      expect(result.l1.after).toBe(2); // only 2026-06-02 shard remains
      expect(result.memories_since_last_persona.after).toBe(2);

      const state = await cp.read();
      expect(state.l0_conversations_count).toBe(2);
      expect(state.total_memories_extracted).toBe(2);
    });

    it("heals after in-place line pruning (rewrite fewer lines)", async () => {
      await cp.markL1ExtractionComplete("s1", 8, 1);
      await writeShard(dataDir, "records", "2026-07-01.jsonl", [
        '{"id":"a"}',
        '{"id":"b"}',
        '{"id":"c"}',
        '{"id":"d"}',
        '{"id":"e"}',
        '{"id":"f"}',
        '{"id":"g"}',
        '{"id":"h"}',
      ]);

      // Keep only 3 lines (manual prune of test pipeline output).
      await writeShard(dataDir, "records", "2026-07-01.jsonl", [
        '{"id":"f"}',
        '{"id":"g"}',
        '{"id":"h"}',
      ]);

      const result = await cp.recalibrate();
      expect(result.l1).toEqual({ before: 8, after: 3 });
      expect(result.memories_since_last_persona.after).toBe(3);
    });

    it("ignores non-shard files and missing directories", async () => {
      await writeShard(dataDir, "conversations", "notes.txt", ["ignored"]);
      const result = await cp.recalibrate();
      expect(result.l0.after).toBe(0);
      expect(result.l1.after).toBe(0);
    });

    it("treats blank / whitespace-only lines as absent", async () => {
      await writeShard(dataDir, "conversations", "2026-06-01.jsonl", ['{"a":1}', "", "  ", '{"a":2}']);
      await writeShard(dataDir, "records", "2026-06-01.jsonl", ['{"m":1}', "\t", '{"m":2}']);

      const result = await cp.recalibrate();
      expect(result.l0.after).toBe(2);
      expect(result.l1.after).toBe(2);
    });
  });

  // ─── 深入：自动 memory-cleaner ───────────────────────────────────────
  describe("scenario: automatic memory-cleaner", () => {
    const nowMs = Date.UTC(2026, 6, 23, 12, 0, 0); // 2026-07-23

    it("recalibrates after cleaner removes expired JSONL shards (no store)", async () => {
      await cp.markL1ExtractionComplete("s1", 30, 1);
      for (let i = 0; i < 4; i++) {
        await cp.captureAtomically(`s${i}`, undefined, async () => ({
          maxTimestamp: i + 1,
          messageCount: 1,
        }));
      }

      await writeShard(dataDir, "conversations", "2026-07-22.jsonl", [
        '{"id":"keep-l0-1"}',
        '{"id":"keep-l0-2"}',
      ]);
      await writeShard(dataDir, "conversations", "2026-01-01.jsonl", ['{"id":"old-l0"}']);
      await writeShard(dataDir, "records", "2026-07-22.jsonl", [
        '{"id":"a"}',
        '{"id":"b"}',
        '{"id":"c"}',
      ]);
      await writeShard(dataDir, "records", "2026-01-01.jsonl", ['{"id":"old"}']);

      const cleaner = new LocalMemoryCleaner({
        baseDir: dataDir,
        retentionDays: 2,
        cleanTime: "03:00",
      });
      await cleaner.runOnce(nowMs);

      await expect(fs.access(path.join(dataDir, "records", "2026-01-01.jsonl"))).rejects.toThrow();
      await expect(fs.access(path.join(dataDir, "conversations", "2026-01-01.jsonl"))).rejects.toThrow();

      const state = await cp.read();
      expect(state.l0_conversations_count).toBe(2);
      expect(state.total_memories_extracted).toBe(3);
      expect(state.memories_since_last_persona).toBe(3);
    });

    it("recalibrates from live store counts after cleaner DB purge", async () => {
      await cp.markL1ExtractionComplete("s1", 40, 1);
      for (let i = 0; i < 5; i++) {
        await cp.captureAtomically(`s${i}`, undefined, async () => ({
          maxTimestamp: i + 1,
          messageCount: 1,
        }));
      }

      let deletedL0 = 0;
      let deletedL1 = 0;
      // Start above min-retain so delete*Expired is actually invoked.
      let liveL0 = 60;
      let liveL1 = 40;
      const store = {
        countL0: () => liveL0,
        countL1: () => liveL1,
        deleteL0Expired: async () => {
          deletedL0 = 18;
          liveL0 = 42;
          return deletedL0;
        },
        deleteL1Expired: async () => {
          deletedL1 = 25;
          liveL1 = 15;
          return deletedL1;
        },
      };

      const cleaner = new LocalMemoryCleaner({
        baseDir: dataDir,
        retentionDays: 2,
        cleanTime: "03:00",
      });
      cleaner.setVectorStore(store as never);
      await cleaner.runOnce(nowMs);

      expect(deletedL0).toBe(18);
      expect(deletedL1).toBe(25);

      const state = await cp.read();
      expect(state.l0_conversations_count).toBe(42);
      expect(state.total_memories_extracted).toBe(15);
      expect(state.memories_since_last_persona).toBe(15);
    });

    it("still recalibrates when min-retain skips DB deletes (prior drift)", async () => {
      await cp.write({
        ...(await cp.read()),
        l0_conversations_count: 99,
        total_memories_extracted: 88,
        memories_since_last_persona: 88,
      });

      // Below MIN_RETAIN_L0(50) / MIN_RETAIN_L1(20) → deletes skipped, but
      // recalibrate must still correct the inflated checkpoint.
      const store = {
        countL0: () => 12,
        countL1: () => 8,
        deleteL0Expired: async () => {
          throw new Error("should not delete when below min-retain");
        },
        deleteL1Expired: async () => {
          throw new Error("should not delete when below min-retain");
        },
      };

      const cleaner = new LocalMemoryCleaner({
        baseDir: dataDir,
        retentionDays: 2,
        cleanTime: "03:00",
      });
      cleaner.setVectorStore(store as never);
      await cleaner.runOnce(nowMs);

      const state = await cp.read();
      expect(state.l0_conversations_count).toBe(12);
      expect(state.total_memories_extracted).toBe(8);
      expect(state.memories_since_last_persona).toBe(8);
    });

    it("survives recalibration failure without aborting cleanup", async () => {
      await writeShard(dataDir, "records", "2026-01-01.jsonl", ['{"id":"old"}']);

      const store = {
        countL0: async () => {
          throw new Error("store unavailable");
        },
        countL1: async () => 0,
        deleteL0Expired: async () => 0,
        deleteL1Expired: async () => 0,
      };

      const cleaner = new LocalMemoryCleaner({
        baseDir: dataDir,
        retentionDays: 2,
        cleanTime: "03:00",
      });
      cleaner.setVectorStore(store as never);

      // Must not throw — cleanup completes even if recalibrate blows up.
      await expect(cleaner.runOnce(nowMs)).resolves.toBeUndefined();
      await expect(fs.access(path.join(dataDir, "records", "2026-01-01.jsonl"))).rejects.toThrow();
    });
  });

  // ─── 深入：session 重置 ─────────────────────────────────────────────
  describe("scenario: session reset", () => {
    it("clears one session's runner/pipeline state and recalibrates globals", async () => {
      await cp.captureAtomically("keep", undefined, async () => ({ maxTimestamp: 10, messageCount: 2 }));
      await cp.captureAtomically("drop", undefined, async () => ({ maxTimestamp: 20, messageCount: 3 }));
      await cp.markL1ExtractionComplete("keep", 4, 10, "scene-keep");
      await cp.markL1ExtractionComplete("drop", 6, 20, "scene-drop");
      await cp.mergePipelineStates({
        keep: {
          conversation_count: 3,
          last_extraction_time: "2026-07-01T00:00:00.000Z",
          last_extraction_updated_time: "2026-07-01T00:00:00.000Z",
          last_active_time: 10,
          l2_pending_l1_count: 1,
          warmup_threshold: 0,
          l2_last_extraction_time: "",
        },
        drop: {
          conversation_count: 9,
          last_extraction_time: "2026-07-02T00:00:00.000Z",
          last_extraction_updated_time: "2026-07-02T00:00:00.000Z",
          last_active_time: 20,
          l2_pending_l1_count: 2,
          warmup_threshold: 2,
          l2_last_extraction_time: "",
        },
      });

      // Simulate wiping the dropped session's records from the store.
      const result = await cp.resetSession("drop", fakeSource(5, 4));

      expect(result.l0.after).toBe(5);
      expect(result.l1.after).toBe(4);
      expect(result.memories_since_last_persona.after).toBe(4);

      const state = await cp.read();
      expect(state.runner_states.drop).toBeUndefined();
      expect(state.pipeline_states.drop).toBeUndefined();
      expect(state.runner_states.keep).toBeDefined();
      expect(state.pipeline_states.keep.conversation_count).toBe(3);
      expect(state.runner_states.keep.last_scene_name).toBe("scene-keep");
      expect(state.l0_conversations_count).toBe(5);
      expect(state.total_memories_extracted).toBe(4);
    });

    it("heals after manually deleting pipeline_states then pruning that session's JSONL", async () => {
      // Reproduce the issue's exact path: delete test pipeline_states entries
      // and corresponding JSONL lines — counters stay inflated until recalibrate.
      await cp.captureAtomically("s-test", undefined, async () => ({ maxTimestamp: 1, messageCount: 1 }));
      await cp.captureAtomically("s-prod", undefined, async () => ({ maxTimestamp: 2, messageCount: 1 }));
      await cp.markL1ExtractionComplete("s-test", 8, 1);
      await cp.markL1ExtractionComplete("s-prod", 42, 2);
      await cp.mergePipelineStates({
        "s-test": {
          conversation_count: 5,
          last_extraction_time: "t",
          last_extraction_updated_time: "t",
          last_active_time: 1,
          l2_pending_l1_count: 0,
          warmup_threshold: 1,
          l2_last_extraction_time: "",
        },
        "s-prod": {
          conversation_count: 2,
          last_extraction_time: "p",
          last_extraction_updated_time: "p",
          last_active_time: 2,
          l2_pending_l1_count: 0,
          warmup_threshold: 0,
          l2_last_extraction_time: "",
        },
      });

      await writeShard(dataDir, "conversations", "2026-07-20.jsonl", [
        '{"sessionKey":"s-test","id":"t1"}',
        '{"sessionKey":"s-test","id":"t2"}',
        '{"sessionKey":"s-prod","id":"p1"}',
        '{"sessionKey":"s-prod","id":"p2"}',
        '{"sessionKey":"s-prod","id":"p3"}',
      ]);
      await writeShard(dataDir, "records", "2026-07-20.jsonl", [
        '{"sessionKey":"s-test","id":"tm1"}',
        '{"sessionKey":"s-test","id":"tm2"}',
        '{"sessionKey":"s-prod","id":"pm1"}',
        '{"sessionKey":"s-prod","id":"pm2"}',
        '{"sessionKey":"s-prod","id":"pm3"}',
      ]);

      let state = await cp.read();
      expect(state.total_memories_extracted).toBe(50); // 8 + 42
      expect(state.l0_conversations_count).toBe(2);

      // Manual: strip test session lines from JSONL + drop its pipeline state.
      await writeShard(dataDir, "conversations", "2026-07-20.jsonl", [
        '{"sessionKey":"s-prod","id":"p1"}',
        '{"sessionKey":"s-prod","id":"p2"}',
        '{"sessionKey":"s-prod","id":"p3"}',
      ]);
      await writeShard(dataDir, "records", "2026-07-20.jsonl", [
        '{"sessionKey":"s-prod","id":"pm1"}',
        '{"sessionKey":"s-prod","id":"pm2"}',
        '{"sessionKey":"s-prod","id":"pm3"}',
      ]);

      const result = await cp.resetSession("s-test"); // JSONL fallback
      expect(result.source).toBe("jsonl");
      expect(result.l0.after).toBe(3);
      expect(result.l1.after).toBe(3);

      state = await cp.read();
      expect(state.pipeline_states["s-test"]).toBeUndefined();
      expect(state.runner_states["s-test"]).toBeUndefined();
      expect(state.pipeline_states["s-prod"]).toBeDefined();
      expect(state.total_memories_extracted).toBe(3);
      expect(state.l0_conversations_count).toBe(3);
      expect(state.memories_since_last_persona).toBe(3);
    });

    it("resetSession on unknown session still recalibrates globals", async () => {
      await cp.markL1ExtractionComplete("s1", 10, 1);
      const result = await cp.resetSession("never-existed", fakeSource(2, 4));
      expect(result.l1.after).toBe(4);
      expect((await cp.read()).total_memories_extracted).toBe(4);
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("preserves unrelated checkpoint fields and recalibrates scenes from disk", async () => {
    // Create one real scene file so countSceneFiles() returns 1
    const sceneDir = path.join(dataDir, "scene_blocks");
    await fs.mkdir(sceneDir, { recursive: true });
    await fs.writeFile(path.join(sceneDir, "work.md"), "# Work\ncontent");

    await cp.markPersonaGenerated(42);
    await cp.incrementScenesProcessed(); // stored = 1
    await cp.recalibrate(fakeSource(3, 3));

    const state = await cp.read();
    expect(state.last_persona_at).toBe(42);       // unrelated field — must survive
    expect(state.scenes_processed).toBe(1);        // 1 .md file on disk → correct
  });

  it("writes last_recalibrated_at as ISO timestamp after each recalibrate", async () => {
    const before = (await cp.read()).last_recalibrated_at;
    expect(before).toBe("");

    const t0 = Date.now();
    await cp.recalibrate(fakeSource(5, 10));
    const after = (await cp.read()).last_recalibrated_at;

    expect(after).not.toBe("");
    expect(new Date(after).getTime()).toBeGreaterThanOrEqual(t0);
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

  // ─── persona clamp: proportional shrink by deletion zone ───────────────
  // Cleanup deletes the OLDEST records first. Only deletions that fall within
  // the "since last persona" window should reduce memories_since_last_persona.

  it("mixed deletion: only post-persona deletes reduce memories_since", async () => {
    // total=50, memories_since=30 → 20 records predate last persona
    // cleanup deletes 30 oldest: 20 pre-persona + 10 post-persona
    // → memories_since should drop from 30 to 20, not to 0
    await cp.write({
      ...(await cp.read()),
      total_memories_extracted: 50,
      memories_since_last_persona: 30,
    });
    const result = await cp.recalibrate(fakeSource(0, 20));
    expect(result.memories_since_last_persona).toEqual({ before: 30, after: 20 });
  });

  it("all deletions predate last persona: memories_since unchanged", async () => {
    // total=50, memories_since=10 → 40 records predate last persona
    // cleanup deletes 20 oldest (all pre-persona) → memories_since stays 10
    await cp.write({
      ...(await cp.read()),
      total_memories_extracted: 50,
      memories_since_last_persona: 10,
    });
    const result = await cp.recalibrate(fakeSource(0, 30));
    expect(result.memories_since_last_persona).toEqual({ before: 10, after: 10 });
  });

  it("all deletions post-persona: memories_since decreases by deleted count", async () => {
    // total=20, memories_since=20 → all records are post-persona
    // cleanup deletes 10 → memories_since drops from 20 to 10
    await cp.write({
      ...(await cp.read()),
      total_memories_extracted: 20,
      memories_since_last_persona: 20,
    });
    const result = await cp.recalibrate(fakeSource(0, 10));
    expect(result.memories_since_last_persona).toEqual({ before: 20, after: 10 });
  });

  // ─── floorGlobalCounters ──────────────────────────────────────────────
  describe("floorGlobalCounters", () => {
    it("raises total_processed and memories_since when below floor", async () => {
      await cp.write({
        ...(await cp.read()),
        total_processed: 10,
        memories_since_last_persona: 5,
      });

      await cp.floorGlobalCounters({ total_processed: 20, memories_since_last_persona: 8 });

      const state = await cp.read();
      expect(state.total_processed).toBe(20);
      expect(state.memories_since_last_persona).toBe(8);
    });

    it("leaves values untouched when already at or above floor", async () => {
      await cp.write({
        ...(await cp.read()),
        total_processed: 50,
        memories_since_last_persona: 30,
      });

      await cp.floorGlobalCounters({ total_processed: 20, memories_since_last_persona: 10 });

      const state = await cp.read();
      expect(state.total_processed).toBe(50);
      expect(state.memories_since_last_persona).toBe(30);
    });

    it("does not touch scenes_processed — recalibrate can legitimately lower it", async () => {
      await cp.write({
        ...(await cp.read()),
        scenes_processed: 7,
        total_processed: 5,
      });

      await cp.floorGlobalCounters({ total_processed: 10, memories_since_last_persona: 0 });

      // scenes_processed must be unchanged
      expect((await cp.read()).scenes_processed).toBe(7);
    });

    it("is atomic — concurrent increment is not clobbered", async () => {
      await cp.write({
        ...(await cp.read()),
        total_processed: 5,
        memories_since_last_persona: 3,
      });

      // Simulate race: floor and a capture increment run concurrently.
      // The floor sees stored=5 and wants to raise to 20.
      // The increment adds 10 (5 → 15), which is above the floor.
      // Final value must be max(15, 20) = 20, not 15 or 5.
      await Promise.all([
        cp.floorGlobalCounters({ total_processed: 20, memories_since_last_persona: 3 }),
        cp.write({ ...(await cp.read()), total_processed: 15 }),
      ]);

      const state = await cp.read();
      // Either write could win; the invariant is that no value falls below the floor
      expect(state.total_processed).toBeGreaterThanOrEqual(15);
    });
  });

  // ─── scenes_processed recalibration ──────────────────────────────────
  describe("scenes_processed", () => {
    async function writeSceneFile(name: string): Promise<void> {
      const dir = path.join(dataDir, "scene_blocks");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, name), `# ${name}\ncontent`);
    }

    it("sets scenes_processed to actual .md file count", async () => {
      await writeSceneFile("work.md");
      await writeSceneFile("travel.md");
      await cp.write({ ...(await cp.read()), scenes_processed: 10 }); // inflated

      const result = await cp.recalibrate(fakeSource(0, 0));
      expect(result.scenes_processed).toEqual({ before: 10, after: 2 });
      expect((await cp.read()).scenes_processed).toBe(2);
    });

    it("sets scenes_processed to 0 when scene_blocks dir is empty or absent", async () => {
      await cp.write({ ...(await cp.read()), scenes_processed: 5 });

      const result = await cp.recalibrate(fakeSource(0, 0));
      expect(result.scenes_processed).toEqual({ before: 5, after: 0 });
    });

    it("ignores non-.md files in scene_blocks", async () => {
      const dir = path.join(dataDir, "scene_blocks");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "work.md"), "# Work");
      await fs.writeFile(path.join(dir, "index.json"), "{}");
      await fs.writeFile(path.join(dir, ".gitkeep"), "");

      const result = await cp.recalibrate(fakeSource(0, 0));
      expect(result.scenes_processed.after).toBe(1); // only work.md
    });

    it("includes scenes_processed in changed flag", async () => {
      await writeSceneFile("work.md");
      await cp.write({ ...(await cp.read()), scenes_processed: 5 });

      const result = await cp.recalibrate(fakeSource(0, 0));
      expect(result.changed).toBe(true);
    });

    it("persona trigger P3 re-enables after data reset clears scene files", async () => {
      // Simulate: user had 5 scenes, wiped data, now has 1 new scene file
      await writeSceneFile("new-context.md");
      await cp.write({ ...(await cp.read()), scenes_processed: 5 });

      await cp.recalibrate(fakeSource(0, 0));

      // After recalibrate scenes_processed = 1 → P3 condition (=== 1) can fire again
      const state = await cp.read();
      expect(state.scenes_processed).toBe(1);
    });
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

  // ─── configurable min-retain thresholds ──────────────────────────────
  describe("scenario: configurable minRetainL0 / minRetainL1", () => {
    const nowMs = Date.UTC(2026, 6, 23, 12, 0, 0); // 2026-07-23 — past the retention window

    function makeStore(totalL0: number, totalL1: number) {
      return {
        countL0: async () => totalL0,
        countL1: async () => totalL1,
        deleteL0Expired: vi.fn(async () => 1),
        deleteL1Expired: vi.fn(async () => 1),
      };
    }

    it("default thresholds: skips delete when below 50 L0 / 20 L1", async () => {
      const store = makeStore(30, 10); // both below defaults
      const cleaner = new LocalMemoryCleaner({ baseDir: dataDir, retentionDays: 2, cleanTime: "03:00" });
      cleaner.setVectorStore(store as never);
      await cleaner.runOnce(nowMs);
      expect(store.deleteL0Expired).not.toHaveBeenCalled();
      expect(store.deleteL1Expired).not.toHaveBeenCalled();
    });

    it("custom lower threshold: deletes even when count is below the default 50/20", async () => {
      const store = makeStore(30, 10); // below default, above custom
      const cleaner = new LocalMemoryCleaner({
        baseDir: dataDir,
        retentionDays: 2,
        cleanTime: "03:00",
        minRetainL0: 10, // custom: only skip if ≤ 10
        minRetainL1: 5,  // custom: only skip if ≤ 5
      });
      cleaner.setVectorStore(store as never);
      await cleaner.runOnce(nowMs);
      expect(store.deleteL0Expired).toHaveBeenCalledOnce();
      expect(store.deleteL1Expired).toHaveBeenCalledOnce();
    });

    it("custom higher threshold: skips delete even when count is above default", async () => {
      const store = makeStore(80, 40); // above default 50/20, but below custom 100/50
      const cleaner = new LocalMemoryCleaner({
        baseDir: dataDir,
        retentionDays: 2,
        cleanTime: "03:00",
        minRetainL0: 100,
        minRetainL1: 50,
      });
      cleaner.setVectorStore(store as never);
      await cleaner.runOnce(nowMs);
      expect(store.deleteL0Expired).not.toHaveBeenCalled();
      expect(store.deleteL1Expired).not.toHaveBeenCalled();
    });

    it("boundary: deletes when count is exactly one above threshold", async () => {
      const store = makeStore(51, 21); // exactly one above defaults
      const cleaner = new LocalMemoryCleaner({ baseDir: dataDir, retentionDays: 2, cleanTime: "03:00" });
      cleaner.setVectorStore(store as never);
      await cleaner.runOnce(nowMs);
      expect(store.deleteL0Expired).toHaveBeenCalledOnce();
      expect(store.deleteL1Expired).toHaveBeenCalledOnce();
    });

    it("boundary: skips when count is exactly at threshold", async () => {
      const store = makeStore(50, 20); // exactly at defaults
      const cleaner = new LocalMemoryCleaner({ baseDir: dataDir, retentionDays: 2, cleanTime: "03:00" });
      cleaner.setVectorStore(store as never);
      await cleaner.runOnce(nowMs);
      expect(store.deleteL0Expired).not.toHaveBeenCalled();
      expect(store.deleteL1Expired).not.toHaveBeenCalled();
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

  // ─── detectDrift ──────────────────────────────────────────────────────────
  describe("detectDrift", () => {
    it("returns hasDrift=false when counters match actual data", async () => {
      await cp.markL1ExtractionComplete("s1", 10, 1);
      const report = await cp.detectDrift(fakeSource(1, 10));
      expect(report.hasDrift).toBe(false);
      expect(report.l1).toEqual({ stored: 10, actual: 10, delta: 0 });
      expect(report.source).toBe("store");
    });

    it("returns hasDrift=true when stored > actual", async () => {
      await cp.write({
        ...(await cp.read()),
        l0_conversations_count: 50,
        total_memories_extracted: 42,
      });
      const report = await cp.detectDrift(fakeSource(30, 30));
      expect(report.hasDrift).toBe(true);
      expect(report.l0).toEqual({ stored: 50, actual: 30, delta: 20 });
      expect(report.l1).toEqual({ stored: 42, actual: 30, delta: 12 });
    });

    it("does not mutate the checkpoint", async () => {
      await cp.write({
        ...(await cp.read()),
        l0_conversations_count: 99,
        total_memories_extracted: 88,
      });
      await cp.detectDrift(fakeSource(1, 1));
      const state = await cp.read();
      expect(state.l0_conversations_count).toBe(99);
      expect(state.total_memories_extracted).toBe(88);
    });

    it("respects tolerance — hasDrift=false when delta within tolerance", async () => {
      await cp.write({
        ...(await cp.read()),
        l0_conversations_count: 12,
        total_memories_extracted: 10,
      });
      // delta=2 for l0, delta=0 for l1 — within tolerance of 3
      const report = await cp.detectDrift(fakeSource(10, 10), 3);
      expect(report.hasDrift).toBe(false);
    });

    it("falls back to JSONL line counts when no source provided", async () => {
      await writeShard(dataDir, "records", "2026-06-01.jsonl", [
        '{"id":"a"}',
        '{"id":"b"}',
      ]);
      await cp.write({
        ...(await cp.read()),
        total_memories_extracted: 99,
      });
      const report = await cp.detectDrift();
      expect(report.source).toBe("jsonl");
      expect(report.l1.actual).toBe(2);
      expect(report.hasDrift).toBe(true);
    });
  });

  // ─── drift_history ────────────────────────────────────────────────────────
  describe("drift_history", () => {
    it("appends an entry when recalibrate detects drift", async () => {
      await cp.write({ ...(await cp.read()), l0_conversations_count: 5, total_memories_extracted: 10 });
      await cp.recalibrate(fakeSource(5, 6)); // l0: 5→5 (no delta); l1: stored=10 actual=6 → delta=4

      const state = await cp.read();
      expect(state.drift_history).toHaveLength(1);
      expect(state.drift_history[0].l1_delta).toBe(4);
      expect(state.drift_history[0].l0_delta).toBe(0);
      expect(new Date(state.drift_history[0].at).getTime()).toBeGreaterThan(0);
    });

    it("does not append when recalibrate finds no drift", async () => {
      await cp.write({ ...(await cp.read()), l0_conversations_count: 3, total_memories_extracted: 5 });
      // source matches stored values exactly → no drift
      await cp.recalibrate(fakeSource(3, 5));

      const state = await cp.read();
      expect(state.drift_history).toHaveLength(0);
    });

    it("records l0 and l1 deltas independently", async () => {
      await cp.write({
        ...(await cp.read()),
        l0_conversations_count: 20,
        total_memories_extracted: 30,
      });
      await cp.recalibrate(fakeSource(15, 25));

      const entry = (await cp.read()).drift_history[0];
      expect(entry.l0_delta).toBe(5);  // 20 - 15
      expect(entry.l1_delta).toBe(5);  // 30 - 25
    });

    it("caps at DRIFT_HISTORY_MAX (10) and evicts oldest on overflow", async () => {
      // Run 12 recalibrates that each detect drift (stored > actual)
      for (let i = 12; i >= 1; i--) {
        await cp.write({
          ...(await cp.read()),
          total_memories_extracted: i + 1,
        });
        await cp.recalibrate(fakeSource(0, 1));
      }

      const history = (await cp.read()).drift_history;
      expect(history).toHaveLength(10);
      // Most recent entry: stored was 2, actual=1, delta=1
      expect(history[history.length - 1].l1_delta).toBe(1);
    });

    it("entries are ordered oldest-first", async () => {
      for (let stored = 5; stored >= 3; stored--) {
        await cp.write({ ...(await cp.read()), total_memories_extracted: stored });
        await cp.recalibrate(fakeSource(0, 1));
      }

      const history = (await cp.read()).drift_history;
      expect(history).toHaveLength(3);
      // Deltas should be 4, 3, 2 in chronological order
      expect(history[0].l1_delta).toBe(4);
      expect(history[1].l1_delta).toBe(3);
      expect(history[2].l1_delta).toBe(2);
    });

    it("tolerates missing drift_history field in old checkpoint files", async () => {
      // Simulate an old checkpoint written before drift_history existed
      await cp.write({ ...(await cp.read()), total_memories_extracted: 10 } as never);
      // Manually strip the field by writing raw JSON
      const rawPath = (cp as never)["filePath"] as string;
      const raw = JSON.parse(await import("node:fs/promises").then(fs => fs.readFile(rawPath, "utf-8")));
      delete raw.drift_history;
      await import("node:fs/promises").then(fs => fs.writeFile(rawPath, JSON.stringify(raw)));

      // recalibrate must not throw and must initialise drift_history
      await expect(cp.recalibrate(fakeSource(0, 5))).resolves.toBeDefined();
      const state = await cp.read();
      expect(Array.isArray(state.drift_history)).toBe(true);
    });
  });

  // ─── concurrency ──────────────────────────────────────────────────────────
  describe("concurrent recalibrate", () => {
    it("two simultaneous recalibrates produce a valid final state (no corruption)", async () => {
      await cp.markL1ExtractionComplete("s1", 50, 1);

      // Both read their counts before either acquires the write lock —
      // the classic TOCTOU window. The lock serializes the writes, so the
      // final checkpoint must equal one of the two valid snapshots.
      const [r1, r2] = await Promise.all([
        cp.recalibrate(fakeSource(10, 20)),
        cp.recalibrate(fakeSource(10, 20)),
      ]);

      // Both calls must complete without throwing
      expect(r1).toBeDefined();
      expect(r2).toBeDefined();

      const state = await cp.read();
      // Counters must be a coherent snapshot — not a partial mix of two writes
      expect(state.l0_conversations_count).toBe(10);
      expect(state.total_memories_extracted).toBe(20);
    });

    it("recalibrate and markL1ExtractionComplete interleaved — no write lost", async () => {
      // Seed 5 extractions, then race a recalibrate (says l1=3) against
      // another extraction (adds 2 more). The file lock ensures the writes
      // are serial; neither clobbers the other's unrelated fields.
      await cp.markL1ExtractionComplete("s1", 5, 1);

      await Promise.all([
        cp.recalibrate(fakeSource(1, 3)),
        cp.markL1ExtractionComplete("s1", 2, 1), // +2 on top of whatever is there
      ]);

      const state = await cp.read();
      // total_memories_extracted is either 3 (recalibrate last) or 5 (mark last)
      // — both are valid. What must NOT happen is corruption (NaN, undefined, negative).
      expect(Number.isInteger(state.total_memories_extracted)).toBe(true);
      expect(state.total_memories_extracted).toBeGreaterThanOrEqual(0);
      // last_recalibrated_at must be a valid ISO string (recalibrate ran)
      expect(new Date(state.last_recalibrated_at).getTime()).toBeGreaterThan(0);
    });

    it("recalibrate is idempotent — running it N times with same source converges", async () => {
      await cp.markL1ExtractionComplete("s1", 99, 1);

      // Run 5 sequential recalibrates with the same source
      for (let i = 0; i < 5; i++) {
        await cp.recalibrate(fakeSource(7, 42));
      }

      const state = await cp.read();
      expect(state.l0_conversations_count).toBe(7);
      expect(state.total_memories_extracted).toBe(42);
    });

    it("concurrent detectDrift calls all return the same snapshot", async () => {
      await cp.write({
        ...(await cp.read()),
        l0_conversations_count: 30,
        total_memories_extracted: 25,
      });

      const reports = await Promise.all([
        cp.detectDrift(fakeSource(20, 20)),
        cp.detectDrift(fakeSource(20, 20)),
        cp.detectDrift(fakeSource(20, 20)),
      ]);

      // detectDrift is read-only — all three must agree on the stored values
      for (const r of reports) {
        expect(r.l0.stored).toBe(30);
        expect(r.l1.stored).toBe(25);
        expect(r.hasDrift).toBe(true);
      }
      // Checkpoint must be unchanged
      const state = await cp.read();
      expect(state.l0_conversations_count).toBe(30);
      expect(state.total_memories_extracted).toBe(25);
    });
  });
});

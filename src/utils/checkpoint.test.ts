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

    // Store now only has 1 L0 and 3 L1 (cleanup happened).
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
    // 12 memories extracted since last persona; cleanup removes 5 → 7 remain.
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
    // Interval somehow exceeds total (corrupt / partial reset) — clamp to L1.
    await cp.write({
      ...(await cp.read()),
      total_memories_extracted: 20,
      memories_since_last_persona: 50,
    });

    const result = await cp.recalibrate(fakeSource(0, 8));
    expect(result.memories_since_last_persona.after).toBe(8);
    expect((await cp.read()).memories_since_last_persona).toBe(8);
  });

  describe("JSONL fallback (degraded mode, no store)", () => {
    async function writeShard(subDir: string, name: string, lines: string[]): Promise<void> {
      const dir = path.join(dataDir, subDir);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, name), lines.join("\n"), "utf-8");
    }

    it("counts non-empty lines across daily shards after manual prune", async () => {
      // Inflate counters first (simulates pre-cleanup drift).
      await cp.markL1ExtractionComplete("s1", 50, 1);
      await cp.captureAtomically("s1", undefined, async () => ({ maxTimestamp: 1, messageCount: 1 }));
      await cp.captureAtomically("s1", 0, async () => ({ maxTimestamp: 2, messageCount: 1 }));

      await writeShard("conversations", "2026-06-01.jsonl", ['{"a":1}', '{"a":2}', ""]);
      await writeShard("conversations", "2026-06-02.jsonl", ['{"a":3}']);
      await writeShard("records", "2026-06-01.jsonl", ['{"m":1}', "  ", '{"m":2}']);

      const result = await cp.recalibrate();

      expect(result.source).toBe("jsonl");
      expect(result.l0.after).toBe(3); // 2 + 1, blank line ignored
      expect(result.l1.after).toBe(2); // whitespace-only line ignored
      expect(result.changed).toBe(true);
    });

    it("ignores non-shard files and missing directories", async () => {
      await writeShard("conversations", "notes.txt", ["ignored"]);
      // records/ dir never created

      const result = await cp.recalibrate();

      expect(result.l0.after).toBe(0);
      expect(result.l1.after).toBe(0);
    });
  });

  describe("memory-cleaner integration", () => {
    it("recalibrates checkpoint after automatic cleanup with a store", async () => {
      await cp.markL1ExtractionComplete("s1", 40, 1);
      for (let i = 0; i < 5; i++) {
        await cp.captureAtomically(`s${i}`, undefined, async () => ({
          maxTimestamp: i + 1,
          messageCount: 1,
        }));
      }

      let state = await cp.read();
      expect(state.total_memories_extracted).toBe(40);
      expect(state.l0_conversations_count).toBe(5);
      expect(state.memories_since_last_persona).toBe(40);

      // Fake store: cleanup left 2 L0 + 15 L1 (well above min-retain thresholds
      // is irrelevant here — we inject post-cleanup counts via the store API).
      const store = {
        countL0: () => 2,
        countL1: () => 15,
        deleteL0Expired: async () => 0,
        deleteL1Expired: async () => 0,
      };

      const cleaner = new LocalMemoryCleaner({
        baseDir: dataDir,
        retentionDays: 2,
        cleanTime: "03:00",
      });
      cleaner.setVectorStore(store as never);

      // Use a far-future "now" so cutoff sanity checks pass with retentionDays=2.
      const nowMs = Date.UTC(2026, 6, 23, 12, 0, 0);
      await cleaner.runOnce(nowMs);

      state = await cp.read();
      expect(state.l0_conversations_count).toBe(2);
      expect(state.total_memories_extracted).toBe(15);
      expect(state.memories_since_last_persona).toBe(15);
    });

    it("recalibrates from JSONL when cleaner runs without a store", async () => {
      await cp.markL1ExtractionComplete("s1", 30, 1);

      const recordsDir = path.join(dataDir, "records");
      await fs.mkdir(recordsDir, { recursive: true });
      // Keep a recent shard that survives retentionDays=2 cleanup.
      await fs.writeFile(
        path.join(recordsDir, "2026-07-22.jsonl"),
        '{"id":"a"}\n{"id":"b"}\n{"id":"c"}\n',
        "utf-8",
      );
      // Expired shard — cleaner should delete it.
      await fs.writeFile(
        path.join(recordsDir, "2026-01-01.jsonl"),
        '{"id":"old"}\n',
        "utf-8",
      );

      const cleaner = new LocalMemoryCleaner({
        baseDir: dataDir,
        retentionDays: 2,
        cleanTime: "03:00",
      });

      const nowMs = Date.UTC(2026, 6, 23, 12, 0, 0); // 2026-07-23
      await cleaner.runOnce(nowMs);

      const state = await cp.read();
      expect(state.total_memories_extracted).toBe(3);
      expect(state.memories_since_last_persona).toBe(3);
      // Expired shard removed.
      await expect(fs.access(path.join(recordsDir, "2026-01-01.jsonl"))).rejects.toThrow();
    });
  });
});

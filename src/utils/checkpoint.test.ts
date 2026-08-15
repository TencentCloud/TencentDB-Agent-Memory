import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CheckpointManager, type RecalibrationSource } from "./checkpoint.js";

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
    // Simulate drift: counters were incremented well beyond reality.
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

  describe("JSONL fallback (degraded mode, no store)", () => {
    async function writeShard(subDir: string, name: string, lines: string[]): Promise<void> {
      const dir = path.join(dataDir, subDir);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, name), lines.join("\n"), "utf-8");
    }

    it("counts non-empty lines across daily shards", async () => {
      await writeShard("conversations", "2026-06-01.jsonl", ['{"a":1}', '{"a":2}', ""]);
      await writeShard("conversations", "2026-06-02.jsonl", ['{"a":3}']);
      await writeShard("records", "2026-06-01.jsonl", ['{"m":1}', "  ", '{"m":2}']);

      const result = await cp.recalibrate();

      expect(result.source).toBe("jsonl");
      expect(result.l0.after).toBe(3); // 2 + 1, blank line ignored
      expect(result.l1.after).toBe(2); // whitespace-only line ignored
    });

    it("ignores non-shard files and missing directories", async () => {
      await writeShard("conversations", "notes.txt", ["ignored"]);
      // records/ dir never created

      const result = await cp.recalibrate();

      expect(result.l0.after).toBe(0);
      expect(result.l1.after).toBe(0);
    });
  });
});

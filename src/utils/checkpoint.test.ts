import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { CheckpointManager, type CheckpointStoreProbe } from "./checkpoint.js";

/**
 * Tests for the `recalibrate()` drift-correction path (issue #157).
 *
 * The append-only counters `total_memories_extracted` and `l0_conversations_count`
 * drift upward when memory-cleaner prunes JSONL shards / SQLite rows or when
 * `recall_checkpoint.json` is hand-edited. `recalibrate()` recounts from the
 * on-disk JSONL and the store probe, and corrects the counters downward only.
 */

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "tdai-checkpoint-"));
}

async function writeCheckpoint(dataDir: string, cp: Record<string, unknown>): Promise<void> {
  const dir = path.join(dataDir, ".metadata");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "recall_checkpoint.json"), JSON.stringify(cp), "utf-8");
}

async function writeJsonlShard(dataDir: string, name: string, lines: string[]): Promise<void> {
  const dir = path.join(dataDir, "records");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), lines.join("\n") + (lines.length ? "\n" : ""), "utf-8");
}

function makeProbe(l0: number, l1: number): CheckpointStoreProbe {
  return {
    countL0: () => l0,
    countL1: () => l1,
  };
}

function makeThrowingProbe(): CheckpointStoreProbe {
  return {
    countL0: () => { throw new Error("countL0 boom"); },
    countL1: () => { throw new Error("countL1 boom"); },
  };
}

describe("CheckpointManager.recalibrate", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("corrects downward when JSONL has fewer records than the checkpoint claims", async () => {
    // Simulate: gateway ran for a while (counter = 50), operator pruned so
    // only 42 records remain on disk.
    await writeJsonlShard(dataDir, "2026-01-01.jsonl", Array.from({ length: 42 }, (_, i) => JSON.stringify({ id: `m${i}` })));
    await writeCheckpoint(dataDir, {
      total_memories_extracted: 50,
      l0_conversations_count: 30,
      memories_since_last_persona: 12,
    });

    const cp = new CheckpointManager(dataDir);
    const result = await cp.recalibrate(dataDir);

    expect(result.total_memories_extracted).toEqual({ before: 50, after: 42 });
    expect(result.l0_conversations_count).toEqual({ before: 30, after: 30 }); // no probe → unchanged
    expect(result.memories_since_last_persona).toEqual({ before: 12, after: 12 }); // still ≤ new total

    const persisted = JSON.parse(await fs.readFile(path.join(dataDir, ".metadata", "recall_checkpoint.json"), "utf-8"));
    expect(persisted.total_memories_extracted).toBe(42);
  });

  it("does NOT grow counters upward — recount larger than stored is ignored", async () => {
    // If JSONL somehow has more records than the checkpoint knows about (rare
    // — recovery from a crash before flush), we do not raise the counter,
    // otherwise we double-count once the pending write lands.
    await writeJsonlShard(dataDir, "2026-01-01.jsonl", Array.from({ length: 100 }, (_, i) => JSON.stringify({ id: `m${i}` })));
    await writeCheckpoint(dataDir, {
      total_memories_extracted: 42,
      l0_conversations_count: 10,
    });

    const cp = new CheckpointManager(dataDir);
    const result = await cp.recalibrate(dataDir);

    expect(result.total_memories_extracted).toEqual({ before: 42, after: 42 });
  });

  it("uses the store probe to recount L0 downward", async () => {
    await writeJsonlShard(dataDir, "2026-01-01.jsonl", [JSON.stringify({ id: "m1" })]);
    await writeCheckpoint(dataDir, {
      total_memories_extracted: 1,
      l0_conversations_count: 50,
    });

    const cp = new CheckpointManager(dataDir);
    const result = await cp.recalibrate(dataDir, makeProbe(8, 1));

    expect(result.l0_conversations_count).toEqual({ before: 50, after: 8 });
  });

  it("clamps memories_since_last_persona to the new total after a downward correction", async () => {
    // total shrinks from 50 → 3, memories_since (=25) must be pulled down to 3
    // otherwise the persona trigger would fire on phantom counts.
    await writeJsonlShard(dataDir, "2026-01-01.jsonl", Array.from({ length: 3 }, (_, i) => JSON.stringify({ id: `m${i}` })));
    await writeCheckpoint(dataDir, {
      total_memories_extracted: 50,
      memories_since_last_persona: 25,
    });

    const cp = new CheckpointManager(dataDir);
    const result = await cp.recalibrate(dataDir);

    expect(result.total_memories_extracted.after).toBe(3);
    expect(result.memories_since_last_persona).toEqual({ before: 25, after: 3 });
  });

  it("leaves memories_since_last_persona alone when it is still within bounds", async () => {
    await writeJsonlShard(dataDir, "2026-01-01.jsonl", Array.from({ length: 30 }, (_, i) => JSON.stringify({ id: `m${i}` })));
    await writeCheckpoint(dataDir, {
      total_memories_extracted: 42,
      memories_since_last_persona: 5,
    });

    const cp = new CheckpointManager(dataDir);
    const result = await cp.recalibrate(dataDir);

    expect(result.total_memories_extracted.after).toBe(30);
    expect(result.memories_since_last_persona).toEqual({ before: 5, after: 5 });
  });

  it("takes the MAX of JSONL and store counts for L1 (avoids clobbering the healthier side)", async () => {
    // JSONL pruned to 10, SQLite still has 40 — take 40 so we don't drop
    // memories that the store still holds.
    await writeJsonlShard(dataDir, "2026-01-01.jsonl", Array.from({ length: 10 }, (_, i) => JSON.stringify({ id: `m${i}` })));
    await writeCheckpoint(dataDir, {
      total_memories_extracted: 100,
    });

    const cp = new CheckpointManager(dataDir);
    const result = await cp.recalibrate(dataDir, makeProbe(0, 40));
    expect(result.total_memories_extracted).toEqual({ before: 100, after: 40 });
  });

  it("skips malformed JSONL lines silently", async () => {
    await writeJsonlShard(dataDir, "2026-01-01.jsonl", [
      JSON.stringify({ id: "m1" }),
      "not-json{",
      JSON.stringify({ id: "m2" }),
      "",
      JSON.stringify({ id: "m3" }),
    ]);
    await writeCheckpoint(dataDir, { total_memories_extracted: 10 });

    const cp = new CheckpointManager(dataDir);
    const result = await cp.recalibrate(dataDir);
    expect(result.total_memories_extracted.after).toBe(3);
  });

  it("handles missing records/ directory as zero JSONL records", async () => {
    await writeCheckpoint(dataDir, { total_memories_extracted: 7 });
    const cp = new CheckpointManager(dataDir);
    const result = await cp.recalibrate(dataDir);
    expect(result.total_memories_extracted).toEqual({ before: 7, after: 0 });
  });

  it("survives a store probe that throws — falls back to JSONL-only", async () => {
    await writeJsonlShard(dataDir, "2026-01-01.jsonl", [JSON.stringify({ id: "m1" })]);
    await writeCheckpoint(dataDir, {
      total_memories_extracted: 5,
      l0_conversations_count: 5,
    });

    const cp = new CheckpointManager(dataDir);
    // Should not throw; L0 stays as-is because probe failed.
    const result = await cp.recalibrate(dataDir, makeThrowingProbe());
    expect(result.total_memories_extracted).toEqual({ before: 5, after: 1 });
    expect(result.l0_conversations_count).toEqual({ before: 5, after: 5 });
  });

  it("is idempotent — running twice produces the same result", async () => {
    await writeJsonlShard(dataDir, "2026-01-01.jsonl", Array.from({ length: 3 }, (_, i) => JSON.stringify({ id: `m${i}` })));
    await writeCheckpoint(dataDir, { total_memories_extracted: 10, memories_since_last_persona: 8 });

    const cp = new CheckpointManager(dataDir);
    const first = await cp.recalibrate(dataDir);
    const second = await cp.recalibrate(dataDir);

    expect(first.total_memories_extracted.after).toBe(3);
    expect(second.total_memories_extracted).toEqual({ before: 3, after: 3 });
    expect(second.memories_since_last_persona).toEqual({ before: 3, after: 3 });
  });

  // Exact scenario from issue #157:
  //   1. gateway accumulates ~50 L1 records
  //   2. operator deletes 8 pipeline_states + the 8 matching JSONL lines
  //   3. total_memories_extracted=50 while JSONL has 42 records
  //   4. verify recalibrate corrects to 42 AND preserves the operator's edits
  it("issue #157 exact repro: prune 8 of 50, recalibrate to 42", async () => {
    const kept = Array.from({ length: 42 }, (_, i) => JSON.stringify({ id: `mem-${i}` }));
    await writeJsonlShard(dataDir, "2026-07-30.jsonl", kept);
    await writeCheckpoint(dataDir, {
      total_memories_extracted: 50,
      l0_conversations_count: 50,
      memories_since_last_persona: 50,
      pipeline_states: {
        // Operator kept exactly one session after removing 8 others.
        "kept-session": {
          conversation_count: 3,
          last_extraction_time: "",
          last_extraction_updated_time: "",
          last_active_time: 0,
          l2_pending_l1_count: 0,
          warmup_threshold: 0,
          l2_last_extraction_time: "",
        },
      },
    });

    const cp = new CheckpointManager(dataDir);
    const result = await cp.recalibrate(dataDir, makeProbe(42, 42));

    expect(result.total_memories_extracted).toEqual({ before: 50, after: 42 });
    expect(result.l0_conversations_count).toEqual({ before: 50, after: 42 });
    expect(result.memories_since_last_persona).toEqual({ before: 50, after: 42 });

    // Operator's pipeline_states edits must survive — recalibrate is scoped
    // to the drifted counters and does not touch per-session state.
    const persisted = JSON.parse(
      await fs.readFile(path.join(dataDir, ".metadata", "recall_checkpoint.json"), "utf-8"),
    );
    expect(persisted.pipeline_states["kept-session"].conversation_count).toBe(3);
    expect(Object.keys(persisted.pipeline_states)).toEqual(["kept-session"]);
  });

  it("is safe against a concurrent mutating call (serialized via file lock)", async () => {
    await writeJsonlShard(dataDir, "2026-01-01.jsonl", Array.from({ length: 2 }, (_, i) => JSON.stringify({ id: `m${i}` })));
    await writeCheckpoint(dataDir, { total_memories_extracted: 10 });

    const cp = new CheckpointManager(dataDir);
    // Run recalibrate and a concurrent markL1ExtractionComplete. The lock
    // ensures a well-defined ordering: either recount runs first (10→2, then
    // +3 → 5) or the mark runs first (10+3=13, then recount clamps to
    // MAX(jsonl=2, dbL1=undef) = 2). Either way, the recount clamp is at most
    // the actual JSONL count.
    await Promise.all([
      cp.recalibrate(dataDir),
      cp.markL1ExtractionComplete("session-A", 3),
    ]);
    const after = await cp.read();
    expect(after.total_memories_extracted).toBeLessThanOrEqual(5);
    expect(after.total_memories_extracted).toBeGreaterThanOrEqual(2);
  });
});

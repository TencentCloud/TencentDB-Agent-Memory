import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointManager } from "./checkpoint.js";

async function makeDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "checkpoint-recal-"));
  await mkdir(join(dir, ".metadata"), { recursive: true });
  await mkdir(join(dir, "records"), { recursive: true });
  await mkdir(join(dir, "conversations"), { recursive: true });
  return dir;
}

describe("CheckpointManager.recalibrate", () => {
  it("resets inflated counters to actual persisted record counts", async () => {
    const dir = await makeDataDir();
    try {
      // Real data: 3 L1 records in one shard, 2 in another; 5 L0 conversations across 2 shards
      await writeFile(join(dir, "records/2026-07-01.jsonl"), '{"id":1}\n{"id":2}\n{"id":3}\n');
      await writeFile(join(dir, "records/2026-07-02.jsonl"), '{"id":4}\n{"id":5}\n');
      await writeFile(join(dir, "conversations/2026-07-01.jsonl"), '{"c":1}\n{"c":2}\n{"c":3}\n');
      await writeFile(join(dir, "conversations/2026-07-02.jsonl"), '{"c":4}\n{"c":5}\n');

      // Drifted checkpoint: counters overstate reality (the #157 symptom)
      await writeFile(
        join(dir, ".metadata/recall_checkpoint.json"),
        JSON.stringify({
          last_captured_timestamp: 0,
          total_processed: 0,
          last_persona_at: 0,
          last_persona_time: "",
          request_persona_update: false,
          persona_update_reason: "",
          memories_since_last_persona: 0,
          scenes_processed: 0,
          runner_states: {},
          pipeline_states: {},
          l0_conversations_count: 42,
          total_memories_extracted: 50,
        }, null, 2),
      );

      const mgr = new CheckpointManager(dir);
      const cp = await mgr.recalibrate();

      expect(cp.total_memories_extracted).toBe(5);
      expect(cp.l0_conversations_count).toBe(5);

      // Persisted file must reflect the corrected counters
      const persisted = JSON.parse(
        await readFile(join(dir, ".metadata/recall_checkpoint.json"), "utf-8"),
      );
      expect(persisted.total_memories_extracted).toBe(5);
      expect(persisted.l0_conversations_count).toBe(5);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("zeroes counters when no records exist", async () => {
    const dir = await makeDataDir();
    try {
      await writeFile(
        join(dir, ".metadata/recall_checkpoint.json"),
        JSON.stringify({
          runner_states: {},
          pipeline_states: {},
          l0_conversations_count: 10,
          total_memories_extracted: 10,
        }),
      );

      const mgr = new CheckpointManager(dir);
      const cp = await mgr.recalibrate();

      expect(cp.total_memories_extracted).toBe(0);
      expect(cp.l0_conversations_count).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

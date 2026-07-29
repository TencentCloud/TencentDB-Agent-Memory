/**
 * Tests for CheckpointManager recalibrate() and related counter logic.
 *
 * The key scenario: counters in recall_checkpoint.json only increment, so
 * after data cleanup they overstate reality. recalibrate() must recount actual
 * files on disk and correct the counters.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CheckpointManager } from "./checkpoint.js";

// ── Helpers ──────────────────────────────────────────────────────────

let tmpDir: string;

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-test-"));
}

/**
 * Create a minimal valid checkpoint file with given counter values.
 * The checkpoint is written atomically (tmp+rename) to match production path.
 */
async function writeCheckpoint(
  dataDir: string,
  overrides: Record<string, unknown>,
): Promise<void> {
  const metaDir = path.join(dataDir, ".metadata");
  await fs.mkdir(metaDir, { recursive: true });
  const filePath = path.join(metaDir, "recall_checkpoint.json");
  const defaultCp = {
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
    l0_conversations_count: 0,
    total_memories_extracted: 0,
    ...overrides,
  };
  await fs.writeFile(filePath, JSON.stringify(defaultCp, null, 2), "utf-8");
}

/**
 * Create a JSONL file with N non-empty lines (plus an optional trailing newline).
 * The file is created under dirPath with the given shard name.
 */
async function writeJsonlFile(
  dirPath: string,
  fileName: string,
  lineCount: number,
): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
  const lines: string[] = [];
  for (let i = 0; i < lineCount; i++) {
    lines.push(JSON.stringify({ id: i, content: `line-${i}` }));
  }
  lines.push(""); // trailing newline — should NOT add to count
  await fs.writeFile(path.join(dirPath, fileName), lines.join("\n"), "utf-8");
}

/**
 * Create a JSON file (non-JSONL) with N JSON objects on separate lines.
 */
async function writeJsonFile(
  dirPath: string,
  fileName: string,
  objectCount: number,
): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
  const objects = [];
  for (let i = 0; i < objectCount; i++) {
    objects.push(JSON.stringify({ key: i }));
  }
  // Write as a JSON array, one object per line (valid JSON format)
  await fs.writeFile(
    path.join(dirPath, fileName),
    objects.join("\n") + "\n",
    "utf-8",
  );
}

// ── Tests ────────────────────────────────────────────────────────────

describe("CheckpointManager.recalibrate()", () => {
  beforeEach(async () => {
    tmpDir = await createTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ============================
  // 1. Empty state
  // ============================

  it("sets counters to 0 when directories are empty", async () => {
    await writeCheckpoint(tmpDir, {
      total_memories_extracted: 999,
      l0_conversations_count: 888,
      memories_since_last_persona: 777,
    });

    // Create empty directories
    await fs.mkdir(path.join(tmpDir, "records"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "conversations"), { recursive: true });

    const cm = new CheckpointManager(tmpDir);
    await cm.recalibrate();

    const cp = await cm.read();
    expect(cp.total_memories_extracted).toBe(0);
    expect(cp.l0_conversations_count).toBe(0);
    expect(cp.memories_since_last_persona).toBe(0);
  });

  // ============================
  // 2. Happy path — counts match
  // ============================

  it("recounts data and corrects counters", async () => {
    await writeCheckpoint(tmpDir, {
      total_memories_extracted: 9999,
      l0_conversations_count: 9999,
    });

    // Create data: 3 records files with 5 lines each = 15 L1 memories
    await writeJsonlFile(path.join(tmpDir, "records"), "2026-01-01.jsonl", 5);
    await writeJsonlFile(path.join(tmpDir, "records"), "2026-01-02.jsonl", 5);
    await writeJsonlFile(path.join(tmpDir, "records"), "2026-01-03.jsonl", 5);

    // Create data: 2 conversations files with 3 lines each = 6 L0 messages
    await writeJsonlFile(path.join(tmpDir, "conversations"), "2026-01-01.jsonl", 3);
    await writeJsonlFile(path.join(tmpDir, "conversations"), "2026-01-02.jsonl", 3);

    const cm = new CheckpointManager(tmpDir);
    await cm.recalibrate();

    const cp = await cm.read();
    expect(cp.total_memories_extracted).toBe(15);  // 3×5
    expect(cp.l0_conversations_count).toBe(6);      // 2×3
    expect(cp.memories_since_last_persona).toBe(0); // reset
  });

  // ============================
  // 3. After cleanup — counters decrease
  // ============================

  it("decreases counters after file deletion (simulating cleanup)", async () => {
    // Start with more data
    await writeJsonlFile(path.join(tmpDir, "records"), "2026-01-01.jsonl", 10);
    await writeJsonlFile(path.join(tmpDir, "conversations"), "2026-01-01.jsonl", 8);
    await writeCheckpoint(tmpDir, {
      total_memories_extracted: 9999,
      l0_conversations_count: 9999,
    });

    // Counters get corrected to 10 and 8
    const cm = new CheckpointManager(tmpDir);
    await cm.recalibrate();
    let cp = await cm.read();
    expect(cp.total_memories_extracted).toBe(10);
    expect(cp.l0_conversations_count).toBe(8);

    // Delete some files (simulating memory-cleaner)
    await fs.unlink(path.join(tmpDir, "records", "2026-01-01.jsonl"));
    await fs.unlink(path.join(tmpDir, "conversations", "2026-01-01.jsonl"));

    // Recalibrate again
    await cm.recalibrate();
    cp = await cm.read();
    expect(cp.total_memories_extracted).toBe(0);
    expect(cp.l0_conversations_count).toBe(0);
  });

  // ============================
  // 4. Missing directories
  // ============================

  it("handles missing directories gracefully", async () => {
    await writeCheckpoint(tmpDir, {
      total_memories_extracted: 999,
      l0_conversations_count: 999,
    });
    // Do NOT create records/ or conversations/ directories

    const cm = new CheckpointManager(tmpDir);
    await cm.recalibrate();

    const cp = await cm.read();
    expect(cp.total_memories_extracted).toBe(0);
    expect(cp.l0_conversations_count).toBe(0);
  });

  // ============================
  // 5. Preserves unrelated fields
  // ============================

  it("preserves fields not related to recounting", async () => {
    await writeCheckpoint(tmpDir, {
      total_processed: 42,
      last_persona_at: 1000,
      scenes_processed: 7,
      runner_states: {
        "session-1": {
          last_captured_timestamp: 123,
          last_l1_cursor: 456,
          last_scene_name: "scene-1",
        },
      },
      pipeline_states: {
        "session-1": {
          conversation_count: 3,
          last_extraction_time: "2026-01-01T00:00:00Z",
          last_extraction_updated_time: "2026-01-01T00:00:00Z",
          last_active_time: 1700000000000,
          l2_pending_l1_count: 0,
          warmup_threshold: 1,
          l2_last_extraction_time: "",
        },
      },
    });

    const cm = new CheckpointManager(tmpDir);
    await cm.recalibrate();

    const cp = await cm.read();
    // These should remain unchanged
    expect(cp.total_processed).toBe(42);
    expect(cp.last_persona_at).toBe(1000);
    expect(cp.scenes_processed).toBe(7);
    expect(cp.runner_states["session-1"].last_captured_timestamp).toBe(123);
    expect(cp.runner_states["session-1"].last_l1_cursor).toBe(456);
    expect(cp.runner_states["session-1"].last_scene_name).toBe("scene-1");
    expect(cp.pipeline_states["session-1"].conversation_count).toBe(3);
  });

  // ============================
  // 6. Mixed file types
  // ============================

  it("counts both .jsonl and .json files, ignores non-JSON files", async () => {
    await writeCheckpoint(tmpDir, {});
    const recordsDir = path.join(tmpDir, "records");
    const conversationsDir = path.join(tmpDir, "conversations");

    // JSONL files — should be counted
    await writeJsonlFile(recordsDir, "2026-01-01.jsonl", 3);
    // JSON files — should also be counted
    await writeJsonFile(recordsDir, "meta.json", 2);
    // Non-JSON file — should be ignored
    await fs.writeFile(path.join(recordsDir, "notes.txt"), "not counted", "utf-8");

    // Conversations: only jsonl
    await writeJsonlFile(conversationsDir, "2026-01-01.jsonl", 4);

    const cm = new CheckpointManager(tmpDir);
    await cm.recalibrate();

    const cp = await cm.read();
    // records: 3 (jsonl) + 2 (json) = 5
    expect(cp.total_memories_extracted).toBe(5);
    // conversations: 4 (jsonl) only
    expect(cp.l0_conversations_count).toBe(4);
  });

  // ============================
  // 7. Empty lines are not counted
  // ============================

  it("skips empty lines when counting", async () => {
    await writeCheckpoint(tmpDir, {});
    const recordsDir = path.join(tmpDir, "records");
    await fs.mkdir(recordsDir, { recursive: true });

    // Create a file with mixed content: valid lines + empty lines
    const content = [
      JSON.stringify({ id: 1 }),
      "",           // empty — skip
      JSON.stringify({ id: 2 }),
      "",           // empty — skip
      "",           // empty — skip
      JSON.stringify({ id: 3 }),
      "",           // trailing newline — skip
    ].join("\n");
    await fs.writeFile(path.join(recordsDir, "data.jsonl"), content, "utf-8");

    const cm = new CheckpointManager(tmpDir);
    await cm.recalibrate();

    const cp = await cm.read();
    expect(cp.total_memories_extracted).toBe(3); // only non-empty lines
  });

  // ============================
  // 8. No checkpoint file yet
  // ============================

  it("works when no checkpoint file exists yet", async () => {
    // Create only data dirs, no .metadata/recall_checkpoint.json
    await writeJsonlFile(path.join(tmpDir, "records"), "2026-01-01.jsonl", 5);
    await writeJsonlFile(path.join(tmpDir, "conversations"), "2026-01-01.jsonl", 3);

    const cm = new CheckpointManager(tmpDir);
    await cm.recalibrate();

    const cp = await cm.read();
    expect(cp.total_memories_extracted).toBe(5);
    expect(cp.l0_conversations_count).toBe(3);
    expect(cp.memories_since_last_persona).toBe(0);
  });

  // ============================
  // 9. Unreadable file is skipped
  // ============================

  it("skips unreadable files without throwing", async () => {
    await writeCheckpoint(tmpDir, {});
    const recordsDir = path.join(tmpDir, "records");
    await fs.mkdir(recordsDir, { recursive: true });

    // One good file
    await writeJsonlFile(recordsDir, "good.jsonl", 2);
    // Create a directory entry that looks like a file but is a dir (sneaky)
    await fs.mkdir(path.join(recordsDir, "fake.jsonl"), { recursive: true });

    const cm = new CheckpointManager(tmpDir);
    await cm.recalibrate(); // should not throw

    const cp = await cm.read();
    // Only the real file's content should be counted
    expect(cp.total_memories_extracted).toBe(2);
  });

  // ============================
  // 10. Multiple recalibrate calls are idempotent
  // ============================

  it("is idempotent — calling twice yields same result", async () => {
    await writeCheckpoint(tmpDir, {
      total_memories_extracted: 999,
      l0_conversations_count: 999,
    });
    await writeJsonlFile(path.join(tmpDir, "records"), "data.jsonl", 7);
    await writeJsonlFile(path.join(tmpDir, "conversations"), "data.jsonl", 5);

    const cm = new CheckpointManager(tmpDir);
    await cm.recalibrate();
    const cp1 = await cm.read();

    await cm.recalibrate();
    const cp2 = await cm.read();

    expect(cp2.total_memories_extracted).toBe(cp1.total_memories_extracted);
    expect(cp2.l0_conversations_count).toBe(cp1.l0_conversations_count);
    expect(cp2.memories_since_last_persona).toBe(0);
  });
});

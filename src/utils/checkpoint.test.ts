import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { CheckpointManager } from "./checkpoint.js";
import type { Checkpoint } from "./checkpoint.js";

// ============================
// Test helpers
// ============================

/** Creates a fresh temp data directory with the standard subdirectory layout. */
async function createTestDataDir(): Promise<string> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-test-"));
  await fs.mkdir(path.join(base, ".metadata"), { recursive: true });
  await fs.mkdir(path.join(base, "records"), { recursive: true });
  await fs.mkdir(path.join(base, "conversations"), { recursive: true });
  return base;
}

/** Writes an L0 conversations JSONL file with realistic production format.
 *  Each line matches the L0MessageRecord interface from l0-recorder.ts. */
async function writeL0Jsonl(filePath: string, lineCount: number): Promise<void> {
  const baseTs = new Date("2026-07-10T10:00:00+08:00").getTime();
  const lines = Array.from({ length: lineCount }, (_, i) =>
    JSON.stringify({
      sessionKey: "test-session",
      sessionId: `sess-${Math.floor(i / 3)}`,  // ~3 messages per conversation
      recordedAt: new Date(baseTs + i * 1000).toISOString(),
      id: `msg_${baseTs + i}_${(i * 17 % 256).toString(16).padStart(6, "0")}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message content for line ${i}`,
      timestamp: baseTs + i * 1000,
    }),
  );
  await fs.writeFile(filePath, lines.join("\n") + "\n", "utf-8");
}

/** Writes an L1 records JSONL file with realistic production format.
 *  Each line matches the MemoryRecord interface from l1-writer.ts. */
async function writeL1Jsonl(filePath: string, lineCount: number): Promise<void> {
  const baseTs = new Date("2026-07-10T10:00:00+08:00").getTime();
  const lines = Array.from({ length: lineCount }, (_, i) =>
    JSON.stringify({
      id: `m_${baseTs + i}_${(i * 31 % 65536).toString(16).padStart(8, "0")}`,
      content: `Extracted memory #${i}: user prefers concise responses`,
      type: i % 3 === 0 ? "persona" : i % 3 === 1 ? "episodic" : "instruction",
      priority: 50 + (i % 50),
      scene_name: `scene-${Math.floor(i / 5)}`,
      source_message_ids: [`msg_src_${i}_0`, `msg_src_${i}_1`],
      metadata: {},
      timestamps: [new Date(baseTs + i * 1000).toISOString()],
      createdAt: new Date(baseTs + i * 1000).toISOString(),
      updatedAt: new Date(baseTs + i * 1000).toISOString(),
      sessionKey: "test-session",
      sessionId: `sess-${Math.floor(i / 4)}`,
    }),
  );
  await fs.writeFile(filePath, lines.join("\n") + "\n", "utf-8");
}

/** Backward-compatible: writes lines in simplified format (for tests that don't care about schema). */
async function writeJsonl(filePath: string, lineCount: number): Promise<void> {
  const lines = Array.from({ length: lineCount }, (_, i) =>
    JSON.stringify({ id: `msg-${i}`, content: `line ${i}`, timestamp: new Date().toISOString() }),
  );
  await fs.writeFile(filePath, lines.join("\n") + "\n", "utf-8");
}

/** Writes a JSONL file with specific content lines (allows blank lines, custom data). */
async function writeJsonlRaw(filePath: string, lines: string[]): Promise<void> {
  await fs.writeFile(filePath, lines.join("\n") + "\n", "utf-8");
}

/** Seed a checkpoint file with given overrides. */
async function seedCheckpoint(dataDir: string, overrides: Partial<Checkpoint>): Promise<void> {
  const cpPath = path.join(dataDir, ".metadata", "recall_checkpoint.json");
  const defaults: Checkpoint = {
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
  };
  await fs.writeFile(cpPath, JSON.stringify({ ...defaults, ...overrides }, null, 2), "utf-8");
}

async function removeDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

// ============================
// Tests
// ============================

describe("CheckpointManager.recalibrate", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await createTestDataDir();
  });

  afterEach(async () => {
    await removeDir(dataDir);
  });

  // ─── L1: total_memories_extracted ───

  it("recalibrates total_memories_extracted from records/ JSONL files", async () => {
    // Arrange: 3 JSONL files in records/ with 5, 8, 3 lines = 16 total
    await writeJsonl(path.join(dataDir, "records", "2026-07-10.jsonl"), 5);
    await writeJsonl(path.join(dataDir, "records", "2026-07-11.jsonl"), 8);
    await writeJsonl(path.join(dataDir, "records", "2026-07-12.jsonl"), 3);
    // Seed checkpoint with inflated counter (simulates drift after cleaner run)
    await seedCheckpoint(dataDir, { total_memories_extracted: 100 });

    const mgr = new CheckpointManager(dataDir);
    await mgr.recalibrate();
    const cp = await mgr.read();

    expect(cp.total_memories_extracted).toBe(16);
  });

  it("sets total_memories_extracted to 0 when records/ is empty", async () => {
    await seedCheckpoint(dataDir, { total_memories_extracted: 50 });

    const mgr = new CheckpointManager(dataDir);
    await mgr.recalibrate();
    const cp = await mgr.read();

    expect(cp.total_memories_extracted).toBe(0);
  });

  it("sets total_memories_extracted to 0 when records/ does not exist", async () => {
    // Remove records/ directory entirely
    await removeDir(path.join(dataDir, "records"));
    await seedCheckpoint(dataDir, { total_memories_extracted: 30 });

    const mgr = new CheckpointManager(dataDir);
    await mgr.recalibrate();
    const cp = await mgr.read();

    expect(cp.total_memories_extracted).toBe(0);
  });

  it("ignores non-.jsonl files in records/", async () => {
    await writeJsonl(path.join(dataDir, "records", "2026-07-10.jsonl"), 5);
    // Write a .json file (should be ignored)
    await fs.writeFile(
      path.join(dataDir, "records", "legacy.json"),
      JSON.stringify([{ id: "old" }]),
      "utf-8",
    );
    // Write a .txt file (should be ignored)
    await fs.writeFile(
      path.join(dataDir, "records", "notes.txt"),
      "not jsonl\n",
      "utf-8",
    );
    await seedCheckpoint(dataDir, { total_memories_extracted: 999 });

    const mgr = new CheckpointManager(dataDir);
    await mgr.recalibrate();
    const cp = await mgr.read();

    expect(cp.total_memories_extracted).toBe(5);
  });

  it("skips blank lines when counting JSONL lines", async () => {
    // 3 valid lines + 2 blank lines = 3 counted
    await writeJsonlRaw(path.join(dataDir, "records", "2026-07-10.jsonl"), [
      '{"id":"1","content":"a"}',
      "",
      '{"id":"2","content":"b"}',
      "",
      '{"id":"3","content":"c"}',
    ]);
    await seedCheckpoint(dataDir, { total_memories_extracted: 50 });

    const mgr = new CheckpointManager(dataDir);
    await mgr.recalibrate();
    const cp = await mgr.read();

    expect(cp.total_memories_extracted).toBe(3);
  });

  // ─── L0: l0_conversations_count ───

  it("clamps l0_conversations_count to actual file line count (counter was inflated)", async () => {
    // conversations/ has 10 lines
    await writeJsonl(path.join(dataDir, "conversations", "2026-07-10.jsonl"), 6);
    await writeJsonl(path.join(dataDir, "conversations", "2026-07-11.jsonl"), 4);
    // Checkpoint says 50 (inflated from deleted data)
    await seedCheckpoint(dataDir, { l0_conversations_count: 50 });

    const mgr = new CheckpointManager(dataDir);
    await mgr.recalibrate();
    const cp = await mgr.read();

    // min(50, 10) = 10
    expect(cp.l0_conversations_count).toBe(10);
  });

  it("preserves l0_conversations_count when it is already below file line count", async () => {
    // conversations/ has 10 lines
    await writeJsonl(path.join(dataDir, "conversations", "2026-07-10.jsonl"), 10);
    // Checkpoint says 5 (already conservative, e.g. after partial processing)
    await seedCheckpoint(dataDir, { l0_conversations_count: 5 });

    const mgr = new CheckpointManager(dataDir);
    await mgr.recalibrate();
    const cp = await mgr.read();

    // min(5, 10) = 5 — keeps the lower value
    expect(cp.l0_conversations_count).toBe(5);
  });

  it("sets l0_conversations_count to 0 when conversations/ does not exist", async () => {
    await removeDir(path.join(dataDir, "conversations"));
    await seedCheckpoint(dataDir, { l0_conversations_count: 20 });

    const mgr = new CheckpointManager(dataDir);
    await mgr.recalibrate();
    const cp = await mgr.read();

    // min(20, 0) = 0
    expect(cp.l0_conversations_count).toBe(0);
  });

  // ─── Scenario: After cleaner deletes files ───

  it("recalibrates after cleaner deletes old JSONL files", async () => {
    // Before cleanup: 3 days of data
    await writeJsonl(path.join(dataDir, "records", "2026-07-01.jsonl"), 10);
    await writeJsonl(path.join(dataDir, "records", "2026-07-08.jsonl"), 7);
    await writeJsonl(path.join(dataDir, "records", "2026-07-15.jsonl"), 5);
    await writeJsonl(path.join(dataDir, "conversations", "2026-07-01.jsonl"), 20);
    await writeJsonl(path.join(dataDir, "conversations", "2026-07-08.jsonl"), 15);
    await writeJsonl(path.join(dataDir, "conversations", "2026-07-15.jsonl"), 12);
    // Counter reflects pre-cleanup state
    await seedCheckpoint(dataDir, {
      total_memories_extracted: 22,  // 10 + 7 + 5
      l0_conversations_count: 47,    // 20 + 15 + 12
    });

    // Simulate cleaner deleting old files (2026-07-01 removed by retention policy)
    await fs.unlink(path.join(dataDir, "records", "2026-07-01.jsonl"));
    await fs.unlink(path.join(dataDir, "conversations", "2026-07-01.jsonl"));

    const mgr = new CheckpointManager(dataDir);
    await mgr.recalibrate();
    const cp = await mgr.read();

    // L1: 7 + 5 = 12 (was 22)
    expect(cp.total_memories_extracted).toBe(12);
    // L0: min(47, 15 + 12) = min(47, 27) = 27
    expect(cp.l0_conversations_count).toBe(27);
  });

  // ─── Scenario: Manual file deletion ───

  it("recalibrates after user manually deletes specific JSONL files", async () => {
    await writeJsonl(path.join(dataDir, "records", "2026-07-10.jsonl"), 8);
    await writeJsonl(path.join(dataDir, "records", "2026-07-11.jsonl"), 6);
    await seedCheckpoint(dataDir, { total_memories_extracted: 14 });

    // User manually deletes one file
    await fs.unlink(path.join(dataDir, "records", "2026-07-10.jsonl"));

    const mgr = new CheckpointManager(dataDir);
    await mgr.recalibrate();
    const cp = await mgr.read();

    // Only 6 lines remain
    expect(cp.total_memories_extracted).toBe(6);
  });

  // ─── Scenario: Pipeline state deletion ───

  it("recalibrates correctly when pipeline session state was deleted but files remain", async () => {
    await writeJsonl(path.join(dataDir, "records", "2026-07-10.jsonl"), 5);
    await writeJsonl(path.join(dataDir, "conversations", "2026-07-10.jsonl"), 10);
    // Checkpoint has pipeline_states from a deleted session
    await seedCheckpoint(dataDir, {
      total_memories_extracted: 5,
      l0_conversations_count: 10,
      pipeline_states: {
        "deleted-session": {
          conversation_count: 99,
          last_extraction_time: "2026-07-01T00:00:00Z",
          last_extraction_updated_time: "2026-07-01T00:00:00Z",
          last_active_time: 0,
          l2_pending_l1_count: 0,
          warmup_threshold: 0,
          l2_last_extraction_time: "",
        },
      },
    });

    const mgr = new CheckpointManager(dataDir);
    await mgr.recalibrate();
    const cp = await mgr.read();

    // Counters match actual data regardless of stale pipeline_states
    expect(cp.total_memories_extracted).toBe(5);
    expect(cp.l0_conversations_count).toBe(10);
    // pipeline_states should be preserved (recalibrate doesn't touch them)
    expect(cp.pipeline_states["deleted-session"]).toBeDefined();
  });

  // ─── Scenario: Data rollback ───

  it("recalibrates after data rollback reduces file count", async () => {
    // Start with 20 records
    await writeJsonl(path.join(dataDir, "records", "2026-07-10.jsonl"), 20);
    await seedCheckpoint(dataDir, { total_memories_extracted: 20 });

    // Simulate rollback: replace with only 5 records
    await writeJsonl(path.join(dataDir, "records", "2026-07-10.jsonl"), 5);

    const mgr = new CheckpointManager(dataDir);
    await mgr.recalibrate();
    const cp = await mgr.read();

    expect(cp.total_memories_extracted).toBe(5);
  });

  // ─── Scenario: Session reset ───

  it("recalibrates after session data reset (conversations cleared)", async () => {
    await writeJsonl(path.join(dataDir, "conversations", "2026-07-10.jsonl"), 15);
    await seedCheckpoint(dataDir, { l0_conversations_count: 15 });

    // Session reset: delete all conversation files
    await removeDir(path.join(dataDir, "conversations"));
    await fs.mkdir(path.join(dataDir, "conversations"), { recursive: true });

    const mgr = new CheckpointManager(dataDir);
    await mgr.recalibrate();
    const cp = await mgr.read();

    expect(cp.l0_conversations_count).toBe(0);
  });

  // ─── Concurrency safety ───

  it("recalibrate is safe under concurrent access", async () => {
    await writeJsonl(path.join(dataDir, "records", "2026-07-10.jsonl"), 7);
    await seedCheckpoint(dataDir, { total_memories_extracted: 999 });

    // Launch 5 concurrent recalibrations
    const managers = Array.from({ length: 5 }, () => new CheckpointManager(dataDir));
    await Promise.all(managers.map((m) => m.recalibrate()));

    const cp = await managers[0].read();
    expect(cp.total_memories_extracted).toBe(7);
  });

  // ─── Preserves other checkpoint fields ───

  it("does not modify other checkpoint fields during recalibrate", async () => {
    await writeJsonl(path.join(dataDir, "records", "2026-07-10.jsonl"), 3);
    await seedCheckpoint(dataDir, {
      total_memories_extracted: 100,
      l0_conversations_count: 200,
      total_processed: 42,
      scenes_processed: 7,
      last_captured_timestamp: 1234567890,
      request_persona_update: true,
      persona_update_reason: "needs refresh",
    });

    const mgr = new CheckpointManager(dataDir);
    await mgr.recalibrate();
    const cp = await mgr.read();

    // Recalibrated fields
    expect(cp.total_memories_extracted).toBe(3);
    expect(cp.l0_conversations_count).toBe(0); // min(200, 0) = 0 (no conversations/ files)

    // Untouched fields
    expect(cp.total_processed).toBe(42);
    expect(cp.scenes_processed).toBe(7);
    expect(cp.last_captured_timestamp).toBe(1234567890);
    expect(cp.request_persona_update).toBe(true);
    expect(cp.persona_update_reason).toBe("needs refresh");
  });

  // ─── No checkpoint file exists yet ───

  it("creates checkpoint file when recalibrate runs on fresh data dir", async () => {
    // Don't seed any checkpoint — .metadata/ exists but no recall_checkpoint.json
    await writeJsonl(path.join(dataDir, "records", "2026-07-10.jsonl"), 4);

    const mgr = new CheckpointManager(dataDir);
    await mgr.recalibrate();
    const cp = await mgr.read();

    expect(cp.total_memories_extracted).toBe(4);
    // All other fields should be defaults
    expect(cp.total_processed).toBe(0);
    expect(cp.l0_conversations_count).toBe(0);
  });

  // ─── Multiple recalibrations are idempotent ───

  it("produces consistent results across repeated recalibrations", async () => {
    await writeJsonl(path.join(dataDir, "records", "2026-07-10.jsonl"), 6);
    await writeJsonl(path.join(dataDir, "conversations", "2026-07-10.jsonl"), 10);
    await seedCheckpoint(dataDir, {
      total_memories_extracted: 50,
      l0_conversations_count: 8,
    });

    const mgr = new CheckpointManager(dataDir);

    // First recalibrate
    await mgr.recalibrate();
    const cp1 = await mgr.read();

    // Second recalibrate (should be identical)
    await mgr.recalibrate();
    const cp2 = await mgr.read();

    expect(cp1.total_memories_extracted).toBe(cp2.total_memories_extracted);
    expect(cp1.l0_conversations_count).toBe(cp2.l0_conversations_count);
    expect(cp1.total_memories_extracted).toBe(6);
    expect(cp1.l0_conversations_count).toBe(8); // min(50→6, 10) = 6, then min(6, 10) = 6
  });

  // ─── Real-format data tests ───

  it("recalibrates correctly with production-format L0 and L1 JSONL files", async () => {
    // Use real L0/L1 formats matching l0-recorder.ts and l1-writer.ts
    await writeL0Jsonl(path.join(dataDir, "conversations", "2026-07-10.jsonl"), 12);
    await writeL0Jsonl(path.join(dataDir, "conversations", "2026-07-11.jsonl"), 8);
    await writeL1Jsonl(path.join(dataDir, "records", "2026-07-10.jsonl"), 6);
    await writeL1Jsonl(path.join(dataDir, "records", "2026-07-11.jsonl"), 4);
    await seedCheckpoint(dataDir, {
      total_memories_extracted: 999,
      l0_conversations_count: 999,
    });

    const mgr = new CheckpointManager(dataDir);
    await mgr.recalibrate();
    const cp = await mgr.read();

    // L1: 6 + 4 = 10 total memory lines
    expect(cp.total_memories_extracted).toBe(10);
    // L0: min(999, 12 + 8) = 20
    expect(cp.l0_conversations_count).toBe(20);
  });

  // ─── L1 update/merge scenario ───

  it("counts all lines including merge duplicates (known semantic gap)", async () => {
    // In production, l1-writer.ts appends a new line for every store/update/merge.
    // A single memory that gets merged will have 2 lines in the JSONL:
    //   original line + merged line (both with the same `id` but different `updatedAt`).
    // recalibrate counts ALL lines, so total_memories_extracted may exceed unique memory count.
    // This is the documented behavior — line count is the best available proxy.
    const baseTs = new Date("2026-07-10T10:00:00+08:00").getTime();
    const originalRecord = JSON.stringify({
      id: "m_001_aabbccdd",
      content: "User likes TypeScript",
      type: "episodic",
      priority: 60,
      scene_name: "coding",
      source_message_ids: ["msg_1"],
      metadata: {},
      timestamps: [new Date(baseTs).toISOString()],
      createdAt: new Date(baseTs).toISOString(),
      updatedAt: new Date(baseTs).toISOString(),
      sessionKey: "test-session",
      sessionId: "sess-1",
    });
    // Same memory, merged with new evidence — appended as a new line
    const mergedRecord = JSON.stringify({
      id: "m_001_aabbccdd", // same ID, updated content
      content: "User likes TypeScript and prefers concise examples",
      type: "episodic",
      priority: 65,
      scene_name: "coding",
      source_message_ids: ["msg_1", "msg_5"],
      metadata: {},
      timestamps: [new Date(baseTs).toISOString(), new Date(baseTs + 86400000).toISOString()],
      createdAt: new Date(baseTs).toISOString(),
      updatedAt: new Date(baseTs + 86400000).toISOString(),
      sessionKey: "test-session",
      sessionId: "sess-1",
    });
    const otherRecord = JSON.stringify({
      id: "m_002_11223344",
      content: "User works in Beijing timezone",
      type: "persona",
      priority: 80,
      scene_name: "profile",
      source_message_ids: ["msg_3"],
      metadata: {},
      timestamps: [new Date(baseTs + 3600000).toISOString()],
      createdAt: new Date(baseTs + 3600000).toISOString(),
      updatedAt: new Date(baseTs + 3600000).toISOString(),
      sessionKey: "test-session",
      sessionId: "sess-1",
    });
    await writeJsonlRaw(path.join(dataDir, "records", "2026-07-10.jsonl"), [
      originalRecord,
      mergedRecord,
      otherRecord,
    ]);
    await seedCheckpoint(dataDir, { total_memories_extracted: 2 });

    const mgr = new CheckpointManager(dataDir);
    await mgr.recalibrate();
    const cp = await mgr.read();

    // 3 lines total (original + merge + other), NOT 2 unique memories.
    // This is intentional: line count over-counts after merges, but it's the
    // best proxy without a full store.index. The issue #157 acknowledges this.
    expect(cp.total_memories_extracted).toBe(3);
  });

  // ─── L0 multi-message-per-event semantic ───

  it("preserves l0_conversations_count below line count (multi-message capture events)", async () => {
    // In production, one captureAtomically() call can write 2-10 messages
    // (a full conversation round) but only increments l0_conversations_count by 1.
    // So after 3 capture events writing 4 messages each = 12 lines, counter = 3.
    // Recalibrate: min(3, 12) = 3 — correctly preserves the event count.
    await writeL0Jsonl(path.join(dataDir, "conversations", "2026-07-10.jsonl"), 12);
    await seedCheckpoint(dataDir, { l0_conversations_count: 3 });

    const mgr = new CheckpointManager(dataDir);
    await mgr.recalibrate();
    const cp = await mgr.read();

    // 3 capture events produced 12 lines. min(3, 12) = 3.
    expect(cp.l0_conversations_count).toBe(3);
  });

  // ─── Runner states preserved through recalibrate ───

  it("preserves runner_states cursors during recalibrate", async () => {
    await writeL1Jsonl(path.join(dataDir, "records", "2026-07-10.jsonl"), 5);
    await seedCheckpoint(dataDir, {
      total_memories_extracted: 100,
      runner_states: {
        "session-alpha": {
          last_captured_timestamp: 1720600000000,
          last_l1_cursor: 1720600000000,
          last_scene_name: "coding-preferences",
        },
        "session-beta": {
          last_captured_timestamp: 1720700000000,
          last_l1_cursor: 1720700000000,
          last_scene_name: "work-habits",
        },
      },
    });

    const mgr = new CheckpointManager(dataDir);
    await mgr.recalibrate();
    const cp = await mgr.read();

    expect(cp.total_memories_extracted).toBe(5);
    // Runner cursors must be intact — recalibrate never touches runner_states
    expect(cp.runner_states["session-alpha"].last_l1_cursor).toBe(1720600000000);
    expect(cp.runner_states["session-alpha"].last_scene_name).toBe("coding-preferences");
    expect(cp.runner_states["session-beta"].last_captured_timestamp).toBe(1720700000000);
  });
});

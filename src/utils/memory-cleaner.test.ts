import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { LocalMemoryCleaner } from "./memory-cleaner.js";

// ============================
// Test helpers
// ============================

async function createCleanerTestDir(): Promise<string> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cleaner-test-"));
  await fs.mkdir(path.join(base, "conversations"), { recursive: true });
  await fs.mkdir(path.join(base, "records"), { recursive: true });
  return base;
}

/** Write a JSONL shard file with a specific date name. */
async function writeShard(dir: string, date: string, lineCount: number): Promise<void> {
  const lines = Array.from({ length: lineCount }, (_, i) =>
    JSON.stringify({ id: `${date}-${i}`, content: `msg ${i}` }),
  );
  await fs.writeFile(path.join(dir, `${date}.jsonl`), lines.join("\n") + "\n", "utf-8");
}

/** Write a production-format L0 conversation shard (matches l0-recorder.ts output). */
async function writeL0Shard(dir: string, date: string, lineCount: number): Promise<void> {
  const baseTs = new Date(`${date}T00:00:00+08:00`).getTime();
  const lines = Array.from({ length: lineCount }, (_, i) =>
    JSON.stringify({
      sessionKey: "test-session",
      sessionId: `sess-${Math.floor(i / 3)}`,
      recordedAt: new Date(baseTs + i * 2000).toISOString(),
      id: `msg_${baseTs + i}_${i.toString(16).padStart(6, "0")}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Conversation message ${i} on ${date}`,
      timestamp: baseTs + i * 2000,
    }),
  );
  await fs.writeFile(path.join(dir, `${date}.jsonl`), lines.join("\n") + "\n", "utf-8");
}

/** Write a production-format L1 record shard (matches l1-writer.ts output). */
async function writeL1Shard(dir: string, date: string, lineCount: number): Promise<void> {
  const baseTs = new Date(`${date}T00:00:00+08:00`).getTime();
  const lines = Array.from({ length: lineCount }, (_, i) =>
    JSON.stringify({
      id: `m_${baseTs + i}_${i.toString(16).padStart(8, "0")}`,
      content: `Memory extracted on ${date}: user preference #${i}`,
      type: i % 3 === 0 ? "persona" : i % 3 === 1 ? "episodic" : "instruction",
      priority: 50 + (i % 50),
      scene_name: `scene-${Math.floor(i / 5)}`,
      source_message_ids: [`msg_src_${i}`],
      metadata: {},
      timestamps: [new Date(baseTs + i * 1000).toISOString()],
      createdAt: new Date(baseTs + i * 1000).toISOString(),
      updatedAt: new Date(baseTs + i * 1000).toISOString(),
      sessionKey: "test-session",
      sessionId: `sess-${Math.floor(i / 4)}`,
    }),
  );
  await fs.writeFile(path.join(dir, `${date}.jsonl`), lines.join("\n") + "\n", "utf-8");
}

async function removeDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

// ============================
// Tests
// ============================

describe("LocalMemoryCleaner.onAfterCleanup callback", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await createCleanerTestDir();
  });

  afterEach(async () => {
    await removeDir(baseDir);
  });

  it("invokes onAfterCleanup after successful runOnce()", async () => {
    // Create an old file that will be cleaned (retentionDays=2, file from 30 days ago)
    const oldDate = "2020-01-01";
    await writeShard(path.join(baseDir, "conversations"), oldDate, 3);
    await writeShard(path.join(baseDir, "records"), oldDate, 2);

    const callback = vi.fn(async () => {});
    const cleaner = new LocalMemoryCleaner({
      baseDir,
      retentionDays: 2,
      cleanTime: "03:00",
      onAfterCleanup: callback,
    });

    await cleaner.runOnce();

    expect(callback).toHaveBeenCalledTimes(1);
    // Verify the old files were actually deleted
    const convEntries = await fs.readdir(path.join(baseDir, "conversations"));
    expect(convEntries).not.toContain(`${oldDate}.jsonl`);
    cleaner.destroy();
  });

  it("invokes onAfterCleanup even when there are no files to clean", async () => {
    // Empty directories — nothing to delete, but callback should still fire
    const callback = vi.fn(async () => {});
    const cleaner = new LocalMemoryCleaner({
      baseDir,
      retentionDays: 2,
      cleanTime: "03:00",
      onAfterCleanup: callback,
    });

    await cleaner.runOnce();

    expect(callback).toHaveBeenCalledTimes(1);
    cleaner.destroy();
  });

  it("does NOT invoke onAfterCleanup when cleaner is destroyed", async () => {
    const callback = vi.fn(async () => {});
    const cleaner = new LocalMemoryCleaner({
      baseDir,
      retentionDays: 2,
      cleanTime: "03:00",
      onAfterCleanup: callback,
    });

    cleaner.destroy();
    await cleaner.runOnce();

    expect(callback).not.toHaveBeenCalled();
  });

  it("does NOT invoke onAfterCleanup when retentionDays is invalid", async () => {
    const callback = vi.fn(async () => {});
    const cleaner = new LocalMemoryCleaner({
      baseDir,
      retentionDays: 0, // invalid
      cleanTime: "03:00",
      onAfterCleanup: callback,
    });

    await cleaner.runOnce();

    expect(callback).not.toHaveBeenCalled();
    cleaner.destroy();
  });

  it("does NOT invoke onAfterCleanup when retentionDays is negative", async () => {
    const callback = vi.fn(async () => {});
    const cleaner = new LocalMemoryCleaner({
      baseDir,
      retentionDays: -1,
      cleanTime: "03:00",
      onAfterCleanup: callback,
    });

    await cleaner.runOnce();

    expect(callback).not.toHaveBeenCalled();
    cleaner.destroy();
  });

  it("works correctly without onAfterCleanup (backward compatibility)", async () => {
    await writeShard(path.join(baseDir, "conversations"), "2020-01-01", 3);

    const cleaner = new LocalMemoryCleaner({
      baseDir,
      retentionDays: 2,
      cleanTime: "03:00",
      // No onAfterCleanup provided
    });

    // Should not throw
    await cleaner.runOnce();

    const convEntries = await fs.readdir(path.join(baseDir, "conversations"));
    expect(convEntries).not.toContain("2020-01-01.jsonl");
    cleaner.destroy();
  });

  it("propagates callback errors to caller", async () => {
    const callback = vi.fn(async () => {
      throw new Error("recalibrate failed");
    });
    const cleaner = new LocalMemoryCleaner({
      baseDir,
      retentionDays: 2,
      cleanTime: "03:00",
      onAfterCleanup: callback,
    });

    await expect(cleaner.runOnce()).rejects.toThrow("recalibrate failed");
    expect(callback).toHaveBeenCalledTimes(1);
    cleaner.destroy();
  });

  // ─── Integration: recalibrate after cleaner ───

  it("recalibrates checkpoint counters after cleaner deletes files (integration)", async () => {
    // Setup: 3 days of data, retention keeps only last 2 days
    const today = new Date();
    const fmtLocal = (d: Date) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    };
    const d0 = fmtLocal(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 5));
    const d1 = fmtLocal(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1));
    const d2 = fmtLocal(today);

    // Old file (will be deleted by cleaner)
    await writeShard(path.join(baseDir, "records"), d0, 10);
    await writeShard(path.join(baseDir, "conversations"), d0, 15);
    // Recent files (will be kept)
    await writeShard(path.join(baseDir, "records"), d1, 7);
    await writeShard(path.join(baseDir, "records"), d2, 4);
    await writeShard(path.join(baseDir, "conversations"), d1, 8);
    await writeShard(path.join(baseDir, "conversations"), d2, 5);

    // Write checkpoint with inflated counters (pre-cleanup values)
    const metadataDir = path.join(baseDir, ".metadata");
    await fs.mkdir(metadataDir, { recursive: true });
    await fs.writeFile(
      path.join(metadataDir, "recall_checkpoint.json"),
      JSON.stringify({
        last_captured_timestamp: Date.now(),
        total_processed: 100,
        last_persona_at: 0,
        last_persona_time: "",
        request_persona_update: false,
        persona_update_reason: "",
        memories_since_last_persona: 0,
        scenes_processed: 0,
        runner_states: {},
        pipeline_states: {},
        l0_conversations_count: 28,     // 15 + 8 + 5 = inflated
        total_memories_extracted: 21,   // 10 + 7 + 4 = inflated
      }),
      "utf-8",
    );

    const cleaner = new LocalMemoryCleaner({
      baseDir,
      retentionDays: 2,
      cleanTime: "03:00",
      onAfterCleanup: async () => {
        const { CheckpointManager } = await import("./checkpoint.js");
        const cp = new CheckpointManager(baseDir);
        await cp.recalibrate();
      },
    });

    await cleaner.runOnce();

    // Read checkpoint after recalibration
    const raw = JSON.parse(
      await fs.readFile(path.join(metadataDir, "recall_checkpoint.json"), "utf-8"),
    );

    // Old file deleted: records/ has d1(7) + d2(4) = 11
    expect(raw.total_memories_extracted).toBe(11);
    // conversations/ has d1(8) + d2(5) = 13, min(28, 13) = 13
    expect(raw.l0_conversations_count).toBe(13);
    cleaner.destroy();
  });

  // ─── Cleaner skips non-date-sharded files ───

  it("cleaner preserves non-date-sharded .jsonl files and recalibrate counts them", async () => {
    // Write a date-sharded file (will be deleted) and a non-sharded file (will survive)
    await writeShard(path.join(baseDir, "records"), "2020-01-01", 10);
    await writeShard(path.join(baseDir, "records"), "2020-06-15", 5);
    // Non-date-sharded files — cleaner must NOT touch these
    await fs.writeFile(
      path.join(baseDir, "records", "manual-export.jsonl"),
      '{"id":"manual-1","content":"exported data"}\n',
      "utf-8",
    );
    await fs.writeFile(
      path.join(baseDir, "records", "backup-2024.jsonl"),
      '{"id":"bak-1","content":"backup"}\n{"id":"bak-2","content":"backup2"}\n',
      "utf-8",
    );

    const metadataDir = path.join(baseDir, ".metadata");
    await fs.mkdir(metadataDir, { recursive: true });
    await fs.writeFile(
      path.join(metadataDir, "recall_checkpoint.json"),
      JSON.stringify({
        last_captured_timestamp: 0, total_processed: 0,
        last_persona_at: 0, last_persona_time: "",
        request_persona_update: false, persona_update_reason: "",
        memories_since_last_persona: 0, scenes_processed: 0,
        runner_states: {}, pipeline_states: {},
        l0_conversations_count: 0,
        total_memories_extracted: 100, // inflated
      }),
      "utf-8",
    );

    const cleaner = new LocalMemoryCleaner({
      baseDir,
      retentionDays: 2,
      cleanTime: "03:00",
      onAfterCleanup: async () => {
        const { CheckpointManager } = await import("./checkpoint.js");
        await new CheckpointManager(baseDir).recalibrate();
      },
    });

    await cleaner.runOnce();

    // Date-sharded files should be deleted
    const remaining = await fs.readdir(path.join(baseDir, "records"));
    expect(remaining).not.toContain("2020-01-01.jsonl");
    expect(remaining).not.toContain("2020-06-15.jsonl");
    // Non-sharded files must survive
    expect(remaining).toContain("manual-export.jsonl");
    expect(remaining).toContain("backup-2024.jsonl");

    // Recalibrate counted the surviving non-sharded files: 1 + 2 = 3 lines
    const raw = JSON.parse(
      await fs.readFile(path.join(metadataDir, "recall_checkpoint.json"), "utf-8"),
    );
    expect(raw.total_memories_extracted).toBe(3);
    cleaner.destroy();
  });

  // ─── Production-format integration test ───

  it("full integration with production-format JSONL: cleaner → recalibrate → correct counters", async () => {
    const today = new Date();
    const fmtLocal = (d: Date) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    };
    const d0 = fmtLocal(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 5));
    const d1 = fmtLocal(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1));
    const d2 = fmtLocal(today);

    // Old data (will be cleaned)
    await writeL0Shard(path.join(baseDir, "conversations"), d0, 15);
    await writeL1Shard(path.join(baseDir, "records"), d0, 10);
    // Recent data (will survive)
    await writeL0Shard(path.join(baseDir, "conversations"), d1, 8);
    await writeL0Shard(path.join(baseDir, "conversations"), d2, 5);
    await writeL1Shard(path.join(baseDir, "records"), d1, 6);
    await writeL1Shard(path.join(baseDir, "records"), d2, 3);

    const metadataDir = path.join(baseDir, ".metadata");
    await fs.mkdir(metadataDir, { recursive: true });
    await fs.writeFile(
      path.join(metadataDir, "recall_checkpoint.json"),
      JSON.stringify({
        last_captured_timestamp: Date.now(),
        total_processed: 200,
        last_persona_at: 0, last_persona_time: "",
        request_persona_update: false, persona_update_reason: "",
        memories_since_last_persona: 0, scenes_processed: 2,
        runner_states: {
          "live-session": {
            last_captured_timestamp: Date.now(),
            last_l1_cursor: Date.now() - 3600000,
            last_scene_name: "daily-routine",
          },
        },
        pipeline_states: {},
        l0_conversations_count: 28,     // inflated (15 + 8 + 5)
        total_memories_extracted: 19,   // inflated (10 + 6 + 3)
      }, null, 2),
      "utf-8",
    );

    const cleaner = new LocalMemoryCleaner({
      baseDir,
      retentionDays: 2,
      cleanTime: "03:00",
      onAfterCleanup: async () => {
        const { CheckpointManager } = await import("./checkpoint.js");
        await new CheckpointManager(baseDir).recalibrate();
      },
    });

    await cleaner.runOnce();

    const raw = JSON.parse(
      await fs.readFile(path.join(metadataDir, "recall_checkpoint.json"), "utf-8"),
    );

    // Old file cleaned: records/ = d1(6) + d2(3) = 9
    expect(raw.total_memories_extracted).toBe(9);
    // conversations/ = d1(8) + d2(5) = 13, min(28, 13) = 13
    expect(raw.l0_conversations_count).toBe(13);
    // Untouched fields preserved
    expect(raw.total_processed).toBe(200);
    expect(raw.scenes_processed).toBe(2);
    // Runner state cursors intact
    expect(raw.runner_states["live-session"].last_scene_name).toBe("daily-routine");

    cleaner.destroy();
  });

  // ─── Cleaner with empty dirs and non-shard file only ───

  it("cleaner + recalibrate: only non-shard files remain → counters reflect their line count", async () => {
    // Only non-date-sharded files exist (e.g., user exported data manually)
    await fs.writeFile(
      path.join(baseDir, "conversations", "export.jsonl"),
      Array.from({ length: 4 }, (_, i) =>
        JSON.stringify({ sessionKey: "s", sessionId: "x", role: "user", content: `line ${i}` }),
      ).join("\n") + "\n",
      "utf-8",
    );

    const metadataDir = path.join(baseDir, ".metadata");
    await fs.mkdir(metadataDir, { recursive: true });
    await fs.writeFile(
      path.join(metadataDir, "recall_checkpoint.json"),
      JSON.stringify({
        last_captured_timestamp: 0, total_processed: 0,
        last_persona_at: 0, last_persona_time: "",
        request_persona_update: false, persona_update_reason: "",
        memories_since_last_persona: 0, scenes_processed: 0,
        runner_states: {}, pipeline_states: {},
        l0_conversations_count: 10,
        total_memories_extracted: 0,
      }),
      "utf-8",
    );

    const cleaner = new LocalMemoryCleaner({
      baseDir,
      retentionDays: 2,
      cleanTime: "03:00",
      onAfterCleanup: async () => {
        const { CheckpointManager } = await import("./checkpoint.js");
        await new CheckpointManager(baseDir).recalibrate();
      },
    });

    await cleaner.runOnce();

    const raw = JSON.parse(
      await fs.readFile(path.join(metadataDir, "recall_checkpoint.json"), "utf-8"),
    );

    // export.jsonl survived (non-date-sharded), 4 lines counted
    expect(raw.l0_conversations_count).toBe(4); // min(10, 4) = 4
    expect(raw.total_memories_extracted).toBe(0); // no records/ files

    cleaner.destroy();
  });
});

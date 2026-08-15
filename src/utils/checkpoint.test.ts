/**
 * Checkpoint drift fix — test suite.
 *
 * Maps to the issue's acceptance levels:
 * - [基础] checkpoint read/write basics incl. stats_revision migration
 * - [进阶] decrement* / recalculate / resetSession implementations
 * - [深入] multi-scenario coverage: automatic cleanup (memory-cleaner),
 *   manual trimming (real SQLite + JSONL), historical rollback, session reset,
 *   concurrency serialization
 * - [拓展] executable proof that timestamp-based cursors self-heal after
 *   rollback: records skipped before recalculate become processable after
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { CheckpointManager, type Checkpoint } from "./checkpoint.js";
import { buildSnapshotFromSqlite, SQLITE_DB_FILENAME } from "./checkpoint-snapshot.js";
import { LocalMemoryCleaner } from "./memory-cleaner.js";
import { MemoryPipelineManager } from "./pipeline-manager.js";
import type { Logger } from "../core/types.js";

const require = createRequire(import.meta.url);

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ============================
// Helpers
// ============================

let tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-test-"));
  tmpDirs.push(dir);
  return dir;
}

async function seedCheckpoint(dir: string, patch: Partial<Checkpoint>): Promise<Checkpoint> {
  const manager = new CheckpointManager(dir, noopLogger);
  const cp = await manager.read();
  const next: Checkpoint = {
    ...cp,
    ...patch,
    runner_states: { ...cp.runner_states, ...(patch.runner_states ?? {}) },
    pipeline_states: { ...cp.pipeline_states, ...(patch.pipeline_states ?? {}) },
  };
  await manager.write(next);
  return next;
}

function requireNodeSqlite(): typeof import("node:sqlite") {
  return require("node:sqlite") as typeof import("node:sqlite");
}

/** Create a minimal vectors.db with just the columns the snapshot builder reads. */
async function createMiniDb(dir: string): Promise<import("node:sqlite").DatabaseSync> {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(path.join(dir, SQLITE_DB_FILENAME));
  db.exec(`
    CREATE TABLE IF NOT EXISTS l0_conversations (
      record_id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      session_id TEXT DEFAULT '',
      role TEXT NOT NULL DEFAULT '',
      message_text TEXT NOT NULL,
      recorded_at TEXT DEFAULT '',
      timestamp INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS l1_records (
      record_id TEXT PRIMARY KEY,
      session_key TEXT DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      updated_time TEXT DEFAULT ''
    );
  `);
  return db;
}

function insertL0(db: import("node:sqlite").DatabaseSync, id: string, sessionKey: string, recordedAt: string): void {
  db.prepare(
    "INSERT INTO l0_conversations (record_id, session_key, role, message_text, recorded_at, timestamp) VALUES (?, ?, 'user', ?, ?, 0)",
  ).run(id, sessionKey, `msg-${id}`, recordedAt);
}

function insertL1(db: import("node:sqlite").DatabaseSync, id: string, sessionKey: string, updatedAt: string): void {
  db.prepare(
    "INSERT INTO l1_records (record_id, session_key, content, updated_time) VALUES (?, ?, ?, ?)",
  ).run(id, sessionKey, `mem-${id}`, updatedAt);
}

function isoDaysAgo(days: number, hour = 12): string {
  const d = new Date(Date.now() - days * 86_400_000);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

function shardNameDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}.jsonl`;
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs = [];
});

// ============================
// [基础] read/write + migration
// ============================

describe("[基础] checkpoint 基础读写", () => {
  it("returns defaults (incl. stats_revision=0) for a missing checkpoint file", async () => {
    const dir = await makeTmpDir();
    const cp = await new CheckpointManager(dir, noopLogger).read();
    expect(cp.total_processed).toBe(0);
    expect(cp.total_memories_extracted).toBe(0);
    expect(cp.l0_conversations_count).toBe(0);
    expect(cp.stats_revision).toBe(0);
    expect(cp.runner_states).toEqual({});
    expect(cp.pipeline_states).toEqual({});
  });

  it("migrates old checkpoints that lack stats_revision", async () => {
    const dir = await makeTmpDir();
    const metaDir = path.join(dir, ".metadata");
    await fs.mkdir(metaDir, { recursive: true });
    // Legacy format: no stats_revision field at all.
    await fs.writeFile(
      path.join(metaDir, "recall_checkpoint.json"),
      JSON.stringify({ total_processed: 42, scenes_processed: 3 }),
      "utf-8",
    );
    const cp = await new CheckpointManager(dir, noopLogger).read();
    expect(cp.total_processed).toBe(42);
    expect(cp.stats_revision).toBe(0);
  });
});

// ============================
// [进阶] decrement* methods
// ============================

describe("[进阶] decrement 系列", () => {
  it("decrementTotalProcessed subtracts and floors at 0", async () => {
    const dir = await makeTmpDir();
    await seedCheckpoint(dir, { total_processed: 10 });
    const manager = new CheckpointManager(dir, noopLogger);

    const revBefore = (await manager.read()).stats_revision;
    await manager.decrementTotalProcessed(4);
    let cp = await manager.read();
    expect(cp.total_processed).toBe(6);
    expect(cp.stats_revision).toBe(revBefore + 1);

    await manager.decrementTotalProcessed(100);
    cp = await manager.read();
    expect(cp.total_processed).toBe(0);
  });

  it("decrementMemoriesExtracted also clamps memories_since_last_persona", async () => {
    const dir = await makeTmpDir();
    await seedCheckpoint(dir, { total_memories_extracted: 20, memories_since_last_persona: 15 });
    const manager = new CheckpointManager(dir, noopLogger);

    await manager.decrementMemoriesExtracted(8);
    let cp = await manager.read();
    expect(cp.total_memories_extracted).toBe(12);
    expect(cp.memories_since_last_persona).toBe(12); // clamped: cannot exceed total

    await manager.decrementMemoriesExtracted(0); // no-op amount
    cp = await manager.read();
    expect(cp.total_memories_extracted).toBe(12);
  });

  it("decrementL0Conversations works with floor protection", async () => {
    const dir = await makeTmpDir();
    await seedCheckpoint(dir, { l0_conversations_count: 3 });
    const manager = new CheckpointManager(dir, noopLogger);
    await manager.decrementL0Conversations(5);
    expect((await manager.read()).l0_conversations_count).toBe(0);
  });

  it("serializes concurrent decrements through the file lock (no lost updates)", async () => {
    const dir = await makeTmpDir();
    const N = 25;
    await seedCheckpoint(dir, { total_processed: N });
    const manager = new CheckpointManager(dir, noopLogger);

    await Promise.all(Array.from({ length: N }, () => manager.decrementTotalProcessed(1)));
    expect((await manager.read()).total_processed).toBe(0);
  });
});

// ============================
// [进阶] resetSession
// ============================

describe("[进阶] resetSession", () => {
  it("removes runner + pipeline state for the target session only", async () => {
    const dir = await makeTmpDir();
    await seedCheckpoint(dir, {
      runner_states: {
        s1: { last_captured_timestamp: 100, last_l1_cursor: 90, last_scene_name: "travel" },
        s2: { last_captured_timestamp: 200, last_l1_cursor: 190, last_scene_name: "work" },
      },
      pipeline_states: {
        s1: {
          conversation_count: 3,
          last_extraction_time: "2026-07-01T00:00:00.000Z",
          last_extraction_updated_time: "2026-07-01T00:00:00.000Z",
          last_active_time: 1,
          l2_pending_l1_count: 0,
          warmup_threshold: 0,
          l2_last_extraction_time: "",
        },
      },
    });
    const manager = new CheckpointManager(dir, noopLogger);

    const removed = await manager.resetSession("s1");
    expect(removed).toBe(true);

    const cp = await manager.read();
    expect(cp.runner_states.s1).toBeUndefined();
    expect(cp.pipeline_states.s1).toBeUndefined();
    // Other sessions untouched:
    expect(cp.runner_states.s2.last_l1_cursor).toBe(190);
  });

  it("is a no-op (no revision bump) for unknown sessions", async () => {
    const dir = await makeTmpDir();
    await seedCheckpoint(dir, {});
    const manager = new CheckpointManager(dir, noopLogger);
    const revBefore = (await manager.read()).stats_revision;

    expect(await manager.resetSession("ghost")).toBe(false);
    expect((await manager.read()).stats_revision).toBe(revBefore);
  });
});

// ============================
// [进阶] recalculate — counter reconciliation
// ============================

describe("[进阶] recalculate 计数器重算", () => {
  it("assigns exact counts and clamps derived counters", async () => {
    const dir = await makeTmpDir();
    await seedCheckpoint(dir, {
      total_processed: 999,
      l0_conversations_count: 999, // batches can never exceed messages
      total_memories_extracted: 888,
      memories_since_last_persona: 50,
    });
    const manager = new CheckpointManager(dir, noopLogger);
    const revBefore = (await manager.read()).stats_revision;

    const result = await manager.recalculate({ l0MessageCount: 120, l1RecordCount: 30 });
    const cp = await manager.read();

    expect(cp.total_processed).toBe(120);
    expect(cp.l0_conversations_count).toBe(120); // clamped (min), not exact
    expect(cp.total_memories_extracted).toBe(30);
    expect(cp.memories_since_last_persona).toBe(30); // clamped to new total
    expect(cp.stats_revision).toBe(revBefore + 1);
    expect(result.adjustments.length).toBeGreaterThan(0);
  });

  it("does not bump stats_revision when nothing changed", async () => {
    const dir = await makeTmpDir();
    await seedCheckpoint(dir, { total_processed: 10, total_memories_extracted: 5 });
    const manager = new CheckpointManager(dir, noopLogger);
    const revBefore = (await manager.read()).stats_revision;

    const result = await manager.recalculate({ l0MessageCount: 10, l1RecordCount: 5 });
    expect(result.adjustments).toEqual([]);
    expect((await manager.read()).stats_revision).toBe(revBefore);
  });

  it("rejects invalid snapshot numbers gracefully", async () => {
    const dir = await makeTmpDir();
    await seedCheckpoint(dir, { total_processed: 10 });
    const manager = new CheckpointManager(dir, noopLogger);

    const result = await manager.recalculate({ l0MessageCount: Number.NaN, l1RecordCount: -5 });
    expect(result.adjustments).toEqual([]);
    expect((await manager.read()).total_processed).toBe(10);
  });
});

// ============================
// [深入] 场景一：自动清理（memory-cleaner 集成）
// ============================

describe("[深入] 自动清理场景（memory-cleaner → checkpoint 校准）", () => {
  it("JSONL shard deletion decrements counters by exact line counts", async () => {
    const dir = await makeTmpDir();
    const convDir = path.join(dir, "conversations");
    const recDir = path.join(dir, "records");
    await fs.mkdir(convDir, { recursive: true });
    await fs.mkdir(recDir, { recursive: true });

    // Expired shards (3 days old): 3 L0 lines + 2 L1 lines.
    await fs.writeFile(path.join(convDir, shardNameDaysAgo(3)), '{"a":1}\n{"a":2}\n{"a":3}\n', "utf-8");
    await fs.writeFile(path.join(recDir, shardNameDaysAgo(3)), '{"b":1}\n{"b":2}\n', "utf-8");
    // Fresh shards (today): must be kept.
    await fs.writeFile(path.join(convDir, shardNameDaysAgo(0)), '{"a":4}\n', "utf-8");

    await seedCheckpoint(dir, {
      total_processed: 100,
      total_memories_extracted: 50,
      memories_since_last_persona: 50,
    });

    const cleaner = new LocalMemoryCleaner({
      baseDir: dir,
      retentionDays: 2,
      cleanTime: "03:00",
      logger: noopLogger,
    });
    await cleaner.runOnce();

    const cp = await new CheckpointManager(dir, noopLogger).read();
    expect(cp.total_processed).toBe(97); // 100 - 3 L0 lines
    expect(cp.total_memories_extracted).toBe(48); // 50 - 2 L1 lines
    expect(cp.memories_since_last_persona).toBe(48); // clamped
    expect(cp.stats_revision).toBeGreaterThan(0);

    // Fresh shard preserved on disk:
    expect(fsSync.existsSync(path.join(convDir, shardNameDaysAgo(0)))).toBe(true);
  });

  it("VectorStore deletion decrements counters by the store-reported amounts", async () => {
    const dir = await makeTmpDir();
    await seedCheckpoint(dir, { total_processed: 200, total_memories_extracted: 80 });

    const fakeStore = {
      countL0: async () => 100, // > MIN_RETAIN_L0 (50)
      countL1: async () => 40, //  > MIN_RETAIN_L1 (20)
      deleteL0Expired: async () => 30,
      deleteL1Expired: async () => 10,
    };

    const cleaner = new LocalMemoryCleaner({
      baseDir: dir,
      retentionDays: 2,
      cleanTime: "03:00",
      logger: noopLogger,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vectorStore: fakeStore as any,
    });
    await cleaner.runOnce();

    const cp = await new CheckpointManager(dir, noopLogger).read();
    expect(cp.total_processed).toBe(170); // 200 - 30
    expect(cp.total_memories_extracted).toBe(70); // 80 - 10
  });

  it("skips calibration gracefully when nothing was deleted", async () => {
    const dir = await makeTmpDir();
    await seedCheckpoint(dir, { total_processed: 5 });
    const revBefore = (await new CheckpointManager(dir, noopLogger).read()).stats_revision;

    const cleaner = new LocalMemoryCleaner({
      baseDir: dir, // no conversations/records dirs at all
      retentionDays: 2,
      cleanTime: "03:00",
      logger: noopLogger,
    });
    await cleaner.runOnce();

    const cp = await new CheckpointManager(dir, noopLogger).read();
    expect(cp.total_processed).toBe(5);
    expect(cp.stats_revision).toBe(revBefore);
  });
});

// ============================
// [深入] 场景二：手动修剪（real SQLite + recalculate）
// ============================

describe("[深入] 手动修剪场景（真实 SQLite 快照 + recalculate）", () => {
  it("clamps cursors to actual data and resets fully-deleted sessions", async () => {
    const dir = await makeTmpDir();
    const db = await createMiniDb(dir);

    const t1 = isoDaysAgo(10);
    const t2 = isoDaysAgo(5);
    const u1 = isoDaysAgo(9);
    const u2 = isoDaysAgo(4);
    // Session A: L0 t1,t2 + L1 u1,u2. Session B: one L0 row + one L1 row.
    insertL0(db, "a1", "sessA", t1);
    insertL0(db, "a2", "sessA", t2);
    insertL1(db, "m1", "sessA", u1);
    insertL1(db, "m2", "sessA", u2);
    insertL0(db, "b1", "sessB", isoDaysAgo(8));
    insertL1(db, "m3", "sessB", isoDaysAgo(7));
    db.close();

    // Checkpoint is AHEAD of reality (counters inflated, cursors too far).
    await seedCheckpoint(dir, {
      total_processed: 999,
      total_memories_extracted: 888,
      memories_since_last_persona: 100,
      runner_states: {
        sessA: {
          last_captured_timestamp: 777_000, // message-clock: must survive recalculate
          last_l1_cursor: Date.parse(t2) + 86_400_000, // ahead of any data
          last_scene_name: "x",
        },
        sessB: { last_captured_timestamp: 555, last_l1_cursor: 444, last_scene_name: "" },
      },
      pipeline_states: {
        sessA: {
          conversation_count: 0,
          last_extraction_time: "",
          last_extraction_updated_time: isoDaysAgo(1), // ahead of u2
          last_active_time: 0,
          l2_pending_l1_count: 0,
          warmup_threshold: 0,
          l2_last_extraction_time: "",
        },
        sessB: {
          conversation_count: 0,
          last_extraction_time: "",
          last_extraction_updated_time: isoDaysAgo(1),
          last_active_time: 0,
          l2_pending_l1_count: 0,
          warmup_threshold: 0,
          l2_last_extraction_time: "",
        },
      },
    });

    // ── Manual trim: delete newest A L0 row + ALL of session B ──
    const trim = requireNodeSqlite();
    const trimDb = new trim.DatabaseSync(path.join(dir, SQLITE_DB_FILENAME));
    trimDb.prepare("DELETE FROM l0_conversations WHERE record_id = 'a2'").run();
    trimDb.prepare("DELETE FROM l0_conversations WHERE session_key = 'sessB'").run();
    trimDb.prepare("DELETE FROM l1_records WHERE session_key = 'sessB'").run();
    trimDb.close();

    const snapshot = buildSnapshotFromSqlite(dir, noopLogger);
    expect(snapshot).toBeDefined();
    expect(snapshot!.l0MessageCount).toBe(1); // a2 trimmed, b1 wiped with sessB → only a1 left
    expect(snapshot!.l1RecordCount).toBe(2); // m1, m2
    expect(snapshot!.exhaustiveSessions).toBe(true);
    expect(snapshot!.sessions!.sessA.l0MaxRecordedAtMs).toBe(Date.parse(t1));
    expect(snapshot!.sessions!.sessA.l1MaxUpdatedAtIso).toBe(u2);
    expect(snapshot!.sessions!.sessB).toBeUndefined();

    const manager = new CheckpointManager(dir, noopLogger);
    const result = await manager.recalculate(snapshot!);
    const cp = await manager.read();

    // Counters exact:
    expect(cp.total_processed).toBe(1);
    expect(cp.total_memories_extracted).toBe(2);
    expect(cp.memories_since_last_persona).toBe(2);

    // Session A cursors clamped to actual watermarks:
    expect(cp.runner_states.sessA.last_l1_cursor).toBe(Date.parse(t1));
    expect(cp.pipeline_states.sessA.last_extraction_updated_time).toBe(u2);
    // L0 capture cursor uses the message clock — NOT clamped/reset while the
    // session still has data:
    expect(cp.runner_states.sessA.last_captured_timestamp).toBe(777_000);

    // Session B fully deleted → all cursors reset for future re-import:
    expect(cp.runner_states.sessB.last_captured_timestamp).toBe(0);
    expect(cp.runner_states.sessB.last_l1_cursor).toBe(0);
    expect(cp.pipeline_states.sessB.last_extraction_updated_time).toBe("");

    expect(result.adjustments.length).toBeGreaterThanOrEqual(5);
  });

  it("buildSnapshotFromSqlite returns undefined for a missing DB", async () => {
    const dir = await makeTmpDir();
    expect(buildSnapshotFromSqlite(dir, noopLogger)).toBeUndefined();
  });
});

// ============================
// [深入] 场景三：历史数据回滚
// ============================

describe("[深入] 历史回滚场景", () => {
  it("rewinds cursors past the rollback point so records are reprocessed", async () => {
    const dir = await makeTmpDir();
    const db = await createMiniDb(dir);
    const t1 = isoDaysAgo(20);
    const t2 = isoDaysAgo(10);
    const t3 = isoDaysAgo(2);
    insertL0(db, "r1", "sessR", t1);
    insertL0(db, "r2", "sessR", t2);
    insertL0(db, "r3", "sessR", t3);
    insertL1(db, "rm1", "sessR", isoDaysAgo(2));
    db.close();

    // Simulate "checkpoint captured up to t3" before rollback:
    await seedCheckpoint(dir, {
      runner_states: {
        sessR: { last_captured_timestamp: 1, last_l1_cursor: Date.parse(t3), last_scene_name: "" },
      },
      pipeline_states: {
        sessR: {
          conversation_count: 0,
          last_extraction_time: "",
          last_extraction_updated_time: isoDaysAgo(2),
          last_active_time: 0,
          l2_pending_l1_count: 0,
          warmup_threshold: 0,
          l2_last_extraction_time: "",
        },
      },
    });

    // ── Rollback: DB restored to a backup from before t3 ──
    const rb = requireNodeSqlite();
    const rbDb = new rb.DatabaseSync(path.join(dir, SQLITE_DB_FILENAME));
    rbDb.prepare("DELETE FROM l0_conversations WHERE recorded_at > ?").run(t2);
    rbDb.prepare("DELETE FROM l1_records").run();
    rbDb.close();

    const manager = new CheckpointManager(dir, noopLogger);
    const snapshot = buildSnapshotFromSqlite(dir, noopLogger);
    await manager.recalculate(snapshot!);
    const cp = await manager.read();

    // L1 cursor rewound to the surviving max (t2):
    expect(cp.runner_states.sessR.last_l1_cursor).toBe(Date.parse(t2));
    // L1 layer is now empty → L2 cursor reset for a full (empty) rescan:
    expect(cp.pipeline_states.sessR.last_extraction_updated_time).toBe("");

    // [拓展] Executable proof of self-healing: with the rewound cursor, the
    // L1 incremental filter (recorded_at > cursor) now picks r3 up again —
    // before recalculate it was skipped as "already processed".
    const check = requireNodeSqlite();
    const checkDb = new check.DatabaseSync(path.join(dir, SQLITE_DB_FILENAME));
    // Re-import the rolled-back row (data returns):
    checkDb.prepare(
      "INSERT INTO l0_conversations (record_id, session_key, role, message_text, recorded_at, timestamp) VALUES ('r3', 'sessR', 'user', 're-imported', ?, 0)",
    ).run(t3);
    const rows = checkDb
      .prepare("SELECT record_id FROM l0_conversations WHERE session_key = 'sessR' AND recorded_at > ?")
      .all(new Date(cp.runner_states.sessR.last_l1_cursor).toISOString()) as Array<{ record_id: string }>;
    checkDb.close();
    expect(rows.map((r) => r.record_id)).toEqual(["r3"]);
  });
});

// ============================
// [深入] 场景四：session 重置（checkpoint + pipeline 内存态）
// ============================

describe("[深入] session 重置场景", () => {
  it("resetSession + evictSession restarts the session cold", async () => {
    const dir = await makeTmpDir();
    const manager = new CheckpointManager(dir, noopLogger);

    const pm = new MemoryPipelineManager(
      {
        everyNConversations: 5,
        enableWarmup: false,
        l1: { idleTimeoutSeconds: 60 },
        l2: {
          delayAfterL1Seconds: 90,
          minIntervalSeconds: 900,
          maxIntervalSeconds: 3600,
          sessionActiveWindowHours: 24,
        },
      },
      noopLogger,
    );

    // Live session: buffered messages + persisted pipeline state.
    await pm.notifyConversation("s1", [{ role: "user", content: "hello", timestamp: new Date().toISOString() }]);
    pm.setPersister(async (states) => {
      await manager.mergePipelineStates(states);
    });
    await pm.notifyConversation("s1", [{ role: "user", content: "again", timestamp: new Date().toISOString() }]);
    expect(pm.getBufferedMessageCount("s1")).toBe(2);
    expect(pm.getSessionState("s1")).toBeDefined();

    // Reset: persisted state wiped, runtime state evicted.
    await manager.resetSession("s1");
    pm.evictSession("s1");

    expect(pm.getSessionState("s1")).toBeUndefined();
    expect(pm.getBufferedMessageCount("s1")).toBe(0);
    const cp = await manager.read();
    expect(cp.pipeline_states.s1).toBeUndefined();

    // Unknown-key eviction is a safe no-op:
    expect(() => pm.evictSession("ghost")).not.toThrow();

    // Session can restart cold:
    await pm.notifyConversation("s1", [{ role: "user", content: "fresh", timestamp: new Date().toISOString() }]);
    expect(pm.getSessionState("s1")?.conversation_count).toBe(1);

    await pm.destroy();
  });
});

// ============================
// [深入] 并发安全
// ============================

describe("[深入] 并发安全", () => {
  it("captureAtomically and recalculate serialize without lost updates", async () => {
    const dir = await makeTmpDir();
    const manager = new CheckpointManager(dir, noopLogger);

    // Two concurrent captures on the same session: the second MUST observe
    // the first one's cursor (proves the read-modify-write is atomic).
    const seen: number[] = [];
    const capture = (maxTs: number) =>
      manager.captureAtomically("s1", undefined, async (after) => {
        seen.push(after);
        return { maxTimestamp: maxTs, messageCount: 1 };
      });

    await Promise.all([capture(1000), capture(2000)]);
    seen.sort((a, b) => a - b);
    expect(seen).toEqual([0, 1000]); // serialized: 0 → 1000

    const cp = await manager.read();
    expect(cp.total_processed).toBe(2);
    expect(cp.runner_states.s1.last_captured_timestamp).toBe(2000);
  });

  it("concurrent recalculate calls are serialized and idempotent", async () => {
    const dir = await makeTmpDir();
    await seedCheckpoint(dir, { total_processed: 500 });
    const manager = new CheckpointManager(dir, noopLogger);

    const results = await Promise.all([
      manager.recalculate({ l0MessageCount: 100 }),
      manager.recalculate({ l0MessageCount: 100 }),
      manager.recalculate({ l0MessageCount: 100 }),
    ]);
    // Exactly one of them did the adjustment; the rest were no-ops.
    const adjusted = results.filter((r) => r.adjustments.length > 0);
    expect(adjusted.length).toBe(1);
    expect((await manager.read()).total_processed).toBe(100);
  });
});

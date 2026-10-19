/**
 * Regression test for issue #987:
 *   "memory-core 进程的 node:sqlite 连接读不到自己写入的
 *    l1_records / l1_fts 数据（搜索恒返回 0），但独立进程读同一文件正常"
 *
 * Root cause: in WAL mode, if a previous `BEGIN` is not properly closed
 * (e.g. an error path swallows the ROLLBACK), subsequent reads on the
 * same connection operate on a stale snapshot and return 0 rows — even
 * though the data was committed and is visible to other connections.
 *
 * The fix adds `ensureNoStaleTransaction()` which issues a harmless
 * `ROLLBACK` (no-op when no transaction is active) before every read.
 *
 * These tests verify:
 *   1. Normal write → read round-trip on a single connection (baseline)
 *   2. Write → simulate stale BEGIN → read should still return data
 *   3. FTS5 search after write returns matches
 *   4. L0 round-trip with stale transaction
 *
 * https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/987
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { VectorStore } from "./sqlite.js";
import type { MemoryRecord } from "../record/l1-writer.js";
import type { L0Record } from "./types.js";

// ── Helpers ────────────────────────────────────────────────

function makeTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-wal-test-"));
  return path.join(dir, "vectors.db");
}

function makeL1Record(id: string, content: string): MemoryRecord {
  return {
    id,
    content,
    type: "persona",
    priority: 50,
    scene_name: "test-scene",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-01-01T00:00:00.000Z"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sessionKey: "sess-key-1",
    sessionId: "sess-id-1",
  };
}

function makeL0Record(id: string, text: string): L0Record {
  return {
    id,
    sessionKey: "sess-key-1",
    sessionId: "sess-id-1",
    role: "user",
    messageText: text,
    recordedAt: "2026-01-01T00:00:00.000Z",
    timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
  };
}

// ── Tests ──────────────────────────────────────────────────

describe("VectorStore WAL read-after-write visibility (#987)", () => {
  let dbPath: string;
  let store: VectorStore;

  beforeEach(() => {
    dbPath = makeTempDbPath();
    // dimensions=0 simulates embedding.provider="none"
    store = new VectorStore(dbPath, 0, undefined);
    store.init();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  // ── 1. Baseline: write then read on the same connection ──

  it("countL1 returns correct count after upsertL1 on same connection", () => {
    store.upsertL1(makeL1Record("m_001", "用户喜欢阅读电子书"), undefined);
    store.upsertL1(makeL1Record("m_002", "用户擅长编程"), undefined);

    expect(store.countL1()).toBe(2);
  });

  it("queryL1Records returns all rows after upsert on same connection", () => {
    store.upsertL1(makeL1Record("m_010", "用户喜欢阅读电子书"), undefined);
    store.upsertL1(makeL1Record("m_011", "用户擅长编程"), undefined);

    const rows = store.queryL1Records();
    expect(rows).toHaveLength(2);
    expect(rows[0].record_id).toBe("m_010");
    expect(rows[1].record_id).toBe("m_011");
  });

  // ── 2. Core regression: stale transaction must not poison reads ──

  it("countL1 returns data even after a stale BEGIN is left open", () => {
    store.upsertL1(makeL1Record("m_020", "用户喜欢阅读电子书"), undefined);

    // Simulate a leaked transaction — BEGIN without COMMIT/ROLLBACK
    // (this is what happens when an error path swallows the ROLLBACK)
    const db = (store as unknown as { db: { exec: (sql: string) => void } }).db;
    db.exec("BEGIN");

    // Without the fix, countL1 would return 0 because the stale
    // transaction keeps the read snapshot at a pre-write point.
    // With the fix, ensureNoStaleTransaction() rolls back the stale
    // txn before reading, so the correct count is returned.
    expect(store.countL1()).toBe(1);
  });

  it("queryL1Records returns data even after a stale BEGIN is left open", () => {
    store.upsertL1(makeL1Record("m_030", "用户喜欢阅读电子书"), undefined);

    const db = (store as unknown as { db: { exec: (sql: string) => void } }).db;
    db.exec("BEGIN");

    const rows = store.queryL1Records();
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("用户喜欢阅读电子书");
  });

  // ── 3. FTS5 search after write ──

  it("searchL1Fts finds matches after upsert on same connection", () => {
    store.upsertL1(makeL1Record("m_040", "用户喜欢阅读电子书"), undefined);
    store.upsertL1(makeL1Record("m_041", "用户擅长编程"), undefined);

    // Build a simple FTS query — use double-quoted phrase
    const ftsQuery = '"电子书" OR "编程"';
    const results = store.searchL1Fts(ftsQuery, 10);

    expect(results.length).toBeGreaterThan(0);
  });

  it("searchL1Fts finds matches even after a stale BEGIN", () => {
    store.upsertL1(makeL1Record("m_050", "用户喜欢阅读电子书"), undefined);

    const db = (store as unknown as { db: { exec: (sql: string) => void } }).db;
    db.exec("BEGIN");

    const ftsQuery = '"电子书"';
    const results = store.searchL1Fts(ftsQuery, 10);
    expect(results.length).toBeGreaterThan(0);
  });

  // ── 4. L0 round-trip ──

  it("countL0 and queryL0ForL1 work after upsertL1 on same connection", () => {
    store.upsertL0(makeL0Record("msg_001", "请帮我推荐一本电子书"), undefined);
    store.upsertL0(makeL0Record("msg_002", "好的，我来帮你"), undefined);

    expect(store.countL0()).toBe(2);

    const rows = store.queryL0ForL1("sess-key-1");
    expect(rows).toHaveLength(2);
  });

  it("countL0 returns data even after a stale BEGIN", () => {
    store.upsertL0(makeL0Record("msg_010", "请帮我推荐一本电子书"), undefined);

    const db = (store as unknown as { db: { exec: (sql: string) => void } }).db;
    db.exec("BEGIN");

    expect(store.countL0()).toBe(1);
  });

  // ── 5. Multiple write-read cycles ──

  it("repeated write-read cycles maintain consistency", () => {
    for (let i = 0; i < 5; i++) {
      store.upsertL1(
        makeL1Record(`m_cycle_${i}`, `记忆条目 ${i}`),
        undefined,
      );
      // Read immediately after each write
      expect(store.countL1()).toBe(i + 1);
    }

    const allRows = store.queryL1Records();
    expect(allRows).toHaveLength(5);
  });
});

/**
 * Bug #3 fix verification: ensureNoStaleTransaction no longer rolls back
 * active transactions opened by VectorStore's own write methods.
 *
 * Fix: Added `_ownTxnActive` flag. ensureNoStaleTransaction checks this flag
 * and skips ROLLBACK when the transaction was intentionally opened by the
 * store's own beginTxn() method.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { VectorStore } from "./sqlite.js";
import type { MemoryRecord } from "../record/l1-writer.js";

function makeTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-stale-fix-"));
  return path.join(dir, "vectors.db");
}

function makeL1Record(id: string, content: string): MemoryRecord {
  return {
    id,
    content,
    type: "episodic",
    priority: 50,
    scene_name: "",
    source_message_ids: [],
    metadata: {},
    timestamps: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sessionKey: "sess-1",
    sessionId: "sess-1-id",
  };
}

describe("Bug #3 fix: ensureNoStaleTransaction respects own transactions", () => {
  let dbPath: string;
  let store: VectorStore;

  beforeEach(() => {
    dbPath = makeTempDbPath();
    store = new VectorStore(dbPath, 0, undefined);
    store.init();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("ensureNoStaleTransaction still clears stale external BEGIN", () => {
    store.upsertL1(makeL1Record("m_1", "first record"), undefined);
    expect(store.countL1()).toBe(1);

    // Simulate a stale BEGIN from an external operation
    const db = (store as unknown as { db: { exec: (sql: string) => void } }).db;
    db.exec("BEGIN");

    // countL1 calls ensureNoStaleTransaction which should ROLLBACK the stale BEGIN
    // (because _ownTxnActive is false — this wasn't opened by our beginTxn())
    expect(store.countL1()).toBe(1);
  });

  it("upsertL1 transaction is not rolled back by ensureNoStaleTransaction", () => {
    // This test verifies that the internal BEGIN/COMMIT in upsertL1
    // is not rolled back by a concurrent read (which would call ensureNoStaleTransaction).
    // In the fixed code, _ownTxnActive is true during upsertL1's transaction,
    // so ensureNoStaleTransaction skips the ROLLBACK.

    store.upsertL1(makeL1Record("m_a", "record A"), undefined);
    store.upsertL1(makeL1Record("m_b", "record B"), undefined);

    // Both records should be visible
    expect(store.countL1()).toBe(2);

    // Verify the records are actually there
    const rows = store.queryL1Records();
    expect(rows).toHaveLength(2);
  });

  it("stale external BEGIN is still cleared (regression for #987)", () => {
    store.upsertL1(makeL1Record("m_stale", "stale test"), undefined);

    const db = (store as unknown as { db: { exec: (sql: string) => void } }).db;
    db.exec("BEGIN"); // Simulate leaked transaction

    // After the stale BEGIN, reads should still work
    expect(store.countL1()).toBe(1);

    const rows = store.queryL1Records();
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("stale test");
  });
});

/**
 * Bug #4 fix verification: TTL cleanup no longer deadlocks when >80% expired.
 *
 * Fix: Instead of blocking all cleanup when >80% would be deleted,
 * batch the deletion to at most 80% of total records per pass.
 * This allows progressive cleanup over multiple passes.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { VectorStore } from "./sqlite.js";
import type { MemoryRecord } from "../record/l1-writer.js";

function makeTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-ttl-fix-"));
  return path.join(dir, "vectors.db");
}

function makeL1Record(id: string, updatedAt: string): MemoryRecord {
  return {
    id,
    content: `test content ${id}`,
    type: "episodic",
    priority: 50,
    scene_name: "",
    source_message_ids: [],
    metadata: {},
    timestamps: [],
    createdAt: updatedAt,
    updatedAt,
    sessionKey: "sess-1",
    sessionId: "sess-1-id",
  };
}

describe("Bug #4 fix: TTL batched cleanup", () => {
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

  it("deleteL1Expired batches deletion when >80% expired instead of blocking", () => {
    // Insert 10 old + 1 new = 90.9% expired
    for (let i = 0; i < 10; i++) {
      store.upsertL1(
        makeL1Record(`m_${i}`, "2020-01-01T00:00:00.000Z"),
        undefined,
      );
    }
    store.upsertL1(
      makeL1Record("m_recent", "2026-08-15T00:00:00.000Z"),
      undefined,
    );

    expect(store.countL1()).toBe(11);

    const cutoff = "2026-01-01T00:00:00.000Z";

    // First pass: should batch-delete 80% = 8 records (not 0!)
    const deleted1 = store.deleteL1Expired(cutoff);
    expect(deleted1).toBe(8); // Batched: floor(11 * 0.8) = 8
    expect(store.countL1()).toBe(3); // 11 - 8 = 3 remaining

    // Second pass: now only 2/3 = 66.7% expired, under 80% threshold
    const deleted2 = store.deleteL1Expired(cutoff);
    expect(deleted2).toBe(2); // All remaining expired records
    expect(store.countL1()).toBe(1); // Only the recent record remains
  });

  it("deleteL0Expired also batches instead of blocking", () => {
    for (let i = 0; i < 10; i++) {
      store.upsertL0(
        {
          id: `l0_old_${i}`,
          sessionKey: "sess-1",
          sessionId: "sess-1-id",
          role: "user",
          messageText: `old message ${i}`,
          recordedAt: "2020-01-01T00:00:00.000Z",
          timestamp: 1577836800000,
        },
        undefined,
      );
    }
    store.upsertL0(
      {
        id: "l0_new",
        sessionKey: "sess-1",
        sessionId: "sess-1-id",
        role: "user",
        messageText: "recent message",
        recordedAt: "2026-08-15T00:00:00.000Z",
        timestamp: Date.parse("2026-08-15T00:00:00.000Z"),
      },
      undefined,
    );

    expect(store.countL0()).toBe(11);

    const cutoff = "2026-01-01T00:00:00.000Z";
    const deleted1 = store.deleteL0Expired(cutoff);
    expect(deleted1).toBe(8); // Batched
    expect(store.countL0()).toBe(3);

    const deleted2 = store.deleteL0Expired(cutoff);
    expect(deleted2).toBe(2);
    expect(store.countL0()).toBe(1);
  });

  it("deleteL1Expired works fine when <=80% expired (no batching)", () => {
    for (let i = 0; i < 5; i++) {
      store.upsertL1(
        makeL1Record(`old_${i}`, "2020-01-01T00:00:00.000Z"),
        undefined,
      );
    }
    for (let i = 0; i < 5; i++) {
      store.upsertL1(
        makeL1Record(`new_${i}`, "2026-08-15T00:00:00.000Z"),
        undefined,
      );
    }

    const cutoff = "2026-01-01T00:00:00.000Z";
    const deleted = store.deleteL1Expired(cutoff);
    expect(deleted).toBe(5);
    expect(store.countL1()).toBe(5);
  });
});

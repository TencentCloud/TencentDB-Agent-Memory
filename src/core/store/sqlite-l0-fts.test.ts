/**
 * Regression tests for the L0 FTS sync in the SQLite store (issue #1876).
 *
 * `l0_fts.record_id` is UNINDEXED, so `DELETE FROM l0_fts WHERE record_id = ?`
 * is a full virtual-table scan even when the id is brand new — a batch of M
 * messages over N historical rows paid M × N scans on the Node main thread.
 * The fix skips that DELETE for records that do not exist yet, and makes
 * deleteL0Expired remove the FTS rows it previously orphaned.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { VectorStore } from "./sqlite.js";
import type { L0Record } from "./types.js";

let dir: string;
let store: VectorStore;

function makeRecord(id: string, text: string, recordedAt: string): L0Record {
  return {
    id,
    sessionKey: "sess-key-1",
    sessionId: "sess-1",
    role: "user",
    messageText: text,
    recordedAt,
    timestamp: Date.parse(recordedAt),
  };
}

function ftsRowCount(recordId: string): number {
  // The UNINDEXED filter scans, but these test tables are tiny.
  const rows = (
    store as unknown as { db: { prepare(s: string): { all(...p: unknown[]): unknown[] } } }
  ).db
    .prepare("SELECT rowid FROM l0_fts WHERE record_id = ?")
    .all(recordId);
  return rows.length;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bsk-l0-fts-"));
  store = new VectorStore(join(dir, "test.db"), 0);
  const init = store.init();
  expect(init.needsReindex).toBe(false);
});

afterAll(() => {
  try {
    store.close();
  } catch {
    // already closed
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // WAL files can outlive the handle briefly on Windows; the temp dir
    // is cleaned by the OS either way.
  }
});

describe("L0 FTS sync (issue #1876)", () => {
  it("indexes a brand-new record without the pointless FTS delete", () => {
    const rec = makeRecord("msg-new-1", "hello brave new world", "2026-10-24T00:00:01Z");

    expect(store.upsertL0(rec, undefined)).toBe(true);
    // The insert still lands in FTS.
    expect(ftsRowCount("msg-new-1")).toBe(1);
    const hits = store.searchL0Fts("brave");
    expect(hits.some((h) => h.record_id === "msg-new-1")).toBe(true);
  });

  it("keeps delete+re-insert sync when an existing record is updated", () => {
    const first = makeRecord("msg-dup-1", "original wording", "2026-10-24T00:00:01Z");
    expect(store.upsertL0(first, undefined)).toBe(true);

    const updated = makeRecord("msg-dup-1", "replacement wording", "2026-10-24T00:00:02Z");
    expect(store.upsertL0(updated, undefined)).toBe(true);

    expect(ftsRowCount("msg-dup-1")).toBe(1);
    const hits = store.searchL0Fts("replacement");
    expect(hits.some((h) => h.record_id === "msg-dup-1")).toBe(true);
    const stale = store.searchL0Fts("original");
    expect(stale.some((h) => h.record_id === "msg-dup-1")).toBe(false);
  });

  it("deleteL0Expired removes the FTS rows together with the metadata", () => {
    const old1 = makeRecord("msg-old-1", "ancient message alpha", "2026-10-01T00:00:00Z");
    const old2 = makeRecord("msg-old-2", "ancient message beta", "2026-10-01T00:00:01Z");
    const fresh = makeRecord("msg-new-2", "recent message gamma", "2026-10-24T00:00:00Z");
    for (const rec of [old1, old2, fresh]) {
      expect(store.upsertL0(rec, undefined)).toBe(true);
    }

    const deleted = store.deleteL0Expired("2026-10-10T00:00:00Z");
    expect(deleted).toBe(2);

    expect(ftsRowCount("msg-old-1")).toBe(0);
    expect(ftsRowCount("msg-old-2")).toBe(0);
    expect(ftsRowCount("msg-new-2")).toBe(1);
    // No orphaned FTS rows for expired ids are searchable.
    const hits = store.searchL0Fts("ancient");
    expect(hits).toHaveLength(0);
  });

  it("re-adding a record id after expiry does not duplicate FTS rows", () => {
    // Keep the expiry pass under the 80% ratio-protection threshold.
    const rec = makeRecord("msg-cycle-1", "first life text", "2026-10-01T00:00:00Z");
    const filler = makeRecord("msg-keep-1", "stays put text", "2026-10-24T00:00:05Z");
    expect(store.upsertL0(rec, undefined)).toBe(true);
    expect(store.upsertL0(filler, undefined)).toBe(true);
    expect(store.deleteL0Expired("2026-10-10T00:00:00Z")).toBe(1);

    const reborn = makeRecord("msg-cycle-1", "second life text", "2026-10-24T00:00:00Z");
    expect(store.upsertL0(reborn, undefined)).toBe(true);
    expect(ftsRowCount("msg-cycle-1")).toBe(1);
    const hits = store.searchL0Fts("second");
    expect(hits.some((h) => h.record_id === "msg-cycle-1")).toBe(true);
  });
});

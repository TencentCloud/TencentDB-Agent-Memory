/**
 * Regression tests for L1 primary-key lookup on the SQLite store.
 *
 * `queryL1Records({ recordIds })` used to ignore `recordIds` and fall back to
 * a full-table scan, so a primary-key lookup returned the *first row of the
 * whole table* instead of the requested record. Two callers were affected:
 *
 *   - `/v2/atomic/update` — mis-reported "belongs to a different user" (403)
 *     and could overwrite an unrelated record.
 *   - `l1-writer` version merging — `nextVersion` was derived from an
 *     unrelated row, inflating version numbers across the whole table.
 *
 * The MongoDB and tcvdb stores already honoured `recordIds`; this pins the
 * SQLite store to the same behaviour.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VectorStore } from "./memory-store.js";
import type { MemoryRecord } from "../../record/l1-writer.js";

function makeRecord(id: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id,
    content: `content of ${id}`,
    type: "episodic",
    priority: 50,
    scene_name: "test-scene",
    source_message_ids: [`msg-${id}`],
    metadata: {} as Record<string, never>,
    timestamps: [now],
    createdAt: now,
    updatedAt: now,
    version: 1,
    ...overrides,
  } as MemoryRecord;
}

describe("VectorStore.queryL1Records — recordIds primary-key lookup", () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "l1-recordids-"));
    store = new VectorStore(join(dir, "vectors.db"), 0);
    store.init();
  });

  afterEach(() => {
    try {
      store.close?.();
    } catch {
      /* best effort */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns only the requested record, not the first row of the table", () => {
    // Insert the *target* last so a full-table scan would return "first".
    store.upsertL1(makeRecord("rec-first", { content: "first row content" }), undefined);
    store.upsertL1(makeRecord("rec-second", { content: "second row content" }), undefined);
    store.upsertL1(makeRecord("rec-target", { content: "target row content" }), undefined);

    const rows = store.queryL1Records({ recordIds: ["rec-target"] });

    expect(rows).toHaveLength(1);
    expect(rows[0].record_id).toBe("rec-target");
    expect(rows[0].content).toBe("target row content");
  });

  it("returns an empty array for an unknown id instead of the first row", () => {
    store.upsertL1(makeRecord("rec-first", { content: "first row content" }), undefined);

    const rows = store.queryL1Records({ recordIds: ["rec-does-not-exist"] });

    expect(rows).toHaveLength(0);
  });

  it("supports multiple ids at once", () => {
    store.upsertL1(makeRecord("rec-a"), undefined);
    store.upsertL1(makeRecord("rec-b"), undefined);
    store.upsertL1(makeRecord("rec-c"), undefined);

    const rows = store.queryL1Records({ recordIds: ["rec-a", "rec-c"] });

    expect(rows.map((r) => r.record_id).sort()).toEqual(["rec-a", "rec-c"]);
  });

  it("keeps isolation filters applied on top of the primary-key lookup", () => {
    store.upsertL1(makeRecord("rec-mine", { userId: "alice" }), undefined);
    store.upsertL1(makeRecord("rec-theirs", { userId: "bob" }), undefined);

    const rows = store.queryL1Records({ recordIds: ["rec-mine", "rec-theirs"], userId: "alice" });

    expect(rows).toHaveLength(1);
    expect(rows[0].record_id).toBe("rec-mine");
  });

  it("still falls back to session lookups when no ids are given", () => {
    store.upsertL1(makeRecord("rec-s1", { sessionId: "sess-a" }), undefined);
    store.upsertL1(makeRecord("rec-s2", { sessionId: "sess-b" }), undefined);

    const rows = store.queryL1Records({ sessionId: "sess-b" });

    expect(rows).toHaveLength(1);
    expect(rows[0].record_id).toBe("rec-s2");
  });
});

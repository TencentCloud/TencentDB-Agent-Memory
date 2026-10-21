/**
 * Regression tests for https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/1027
 *
 * The sqlite store's queryL1Records() ignored `filter.recordIds`, returning
 * rows from the whole table instead of the requested primary keys. The v3
 * `/atomic/update` handler loads the target note via
 * `queryL1Records({ recordIds: [id] })` and takes `existing[0]`, so with more
 * than one row present it could read another agent's note and fail ownership
 * checks with a spurious 403.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StatementSync } from "node:sqlite";

import { VectorStore } from "./sqlite/memory-store.js";
import type { MemoryRecord } from "../record/l1-writer.js";

function makeRecord(id: string, agentId: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id,
    content: `note for ${id}`,
    type: "episodic",
    priority: 50,
    scene_name: "default",
    source_message_ids: [],
    metadata: {},
    timestamps: [now],
    createdAt: now,
    updatedAt: now,
    version: 1,
    sessionKey: "sess-1",
    sessionId: "sess-1",
    teamId: "team-1",
    userId: "user-1",
    agentId,
    ...overrides,
  };
}

describe("VectorStore.queryL1Records recordIds filter", () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "tdai-sqlite-test-"));
    // dimensions=0 → metadata/FTS-only mode, no sqlite-vec extension needed.
    store = new VectorStore(path.join(dir, "test.db"), 0);
    store.init();
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns only the records matching filter.recordIds", async () => {
    store.upsertL1(makeRecord("mem-a", "agent-a"), undefined);
    store.upsertL1(makeRecord("mem-b", "agent-b"), undefined);

    const rows = await store.queryL1Records({ recordIds: ["mem-b"] });

    expect(rows.map((r) => r.record_id)).toEqual(["mem-b"]);
  });

  it("returns no rows when none of the recordIds exist", async () => {
    store.upsertL1(makeRecord("mem-a", "agent-a"), undefined);

    const rows = await store.queryL1Records({ recordIds: ["mem-missing"] });

    expect(rows).toEqual([]);
  });

  it("recordIds combine with isolation dimensions", async () => {
    store.upsertL1(makeRecord("mem-a", "agent-a"), undefined);
    store.upsertL1(makeRecord("mem-b", "agent-b"), undefined);

    const rows = await store.queryL1Records({
      recordIds: ["mem-a", "mem-b"],
      agentId: "agent-b",
    });

    expect(rows.map((r) => r.record_id)).toEqual(["mem-b"]);
  });

  it("uses one primary-key read per distinct ID without scanning the table", async () => {
    store.upsertL1(makeRecord("mem-a", "agent-a"), undefined);
    store.upsertL1(makeRecord("mem-b", "agent-b"), undefined);
    const expected = await store.queryL1Records({ agentId: "agent-b" });
    const scan = vi.spyOn(StatementSync.prototype, "all");
    const lookup = vi.spyOn(StatementSync.prototype, "get");

    const rows = await store.queryL1Records({ recordIds: ["mem-b", "missing", "mem-b"] });

    expect(rows).toEqual(expected);
    expect(scan).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("keeps time ordering, strict time filtering, and sessionId precedence", async () => {
    const first = "2026-01-01T00:00:00.000Z";
    store.upsertL1(makeRecord("mem-a", "agent-a", { updatedAt: first }), undefined);
    store.upsertL1(makeRecord("mem-b", "agent-a", {
      sessionId: "sess-2", sessionKey: "key-2", updatedAt: "2026-01-02T00:00:00.000Z",
    }), undefined);
    store.upsertL1(makeRecord("mem-c", "agent-a", { updatedAt: "2026-01-03T00:00:00.000Z" }), undefined);
    const recordIds = ["mem-c", "mem-b", "mem-a"];

    expect((await store.queryL1Records({ recordIds })).map((r) => r.record_id))
      .toEqual(["mem-a", "mem-b", "mem-c"]);
    expect((await store.queryL1Records({ recordIds, updatedAfter: first })).map((r) => r.record_id))
      .toEqual(["mem-b", "mem-c"]);
    expect((await store.queryL1Records({ recordIds, sessionKey: "key-2" })).map((r) => r.record_id))
      .toEqual(["mem-b"]);
    expect((await store.queryL1Records({
      recordIds, sessionId: "sess-1", sessionKey: "key-2", updatedAfter: first,
    })).map((r) => r.record_id)).toEqual(["mem-c"]);
  });

  it.each(["teamId", "userId", "agentId", "taskId"] as const)("keeps the %s filter on ID lookups", async (dimension) => {
    store.upsertL1(makeRecord("mem-a", "agent-a", { [dimension]: "wanted" }), undefined);
    store.upsertL1(makeRecord("mem-b", "agent-b", { [dimension]: "other" }), undefined);

    const rows = await store.queryL1Records({ recordIds: ["mem-a", "mem-b"], [dimension]: "wanted" });

    expect(rows.map((r) => r.record_id)).toEqual(["mem-a"]);
  });

  it("retains the normal scan when recordIds is empty", async () => {
    store.upsertL1(makeRecord("mem-a", "agent-a"), undefined);

    expect((await store.queryL1Records({ recordIds: [] })).map((r) => r.record_id)).toEqual(["mem-a"]);
  });
});

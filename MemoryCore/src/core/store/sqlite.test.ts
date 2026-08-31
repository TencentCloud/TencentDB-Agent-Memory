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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { VectorStore } from "./sqlite.js";
import type { MemoryRecord } from "../record/l1-writer.js";

function makeRecord(id: string, agentId: string): MemoryRecord {
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
});

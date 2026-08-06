import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MemoryRecord } from "../record/l1-writer";
import { VectorStore } from "./sqlite";

function makeRecord(id: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    content: `content-${id}`,
    type: "episodic",
    priority: 50,
    scene_name: "",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-01-01T00:00:00.000Z"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
    sessionKey: "session-key",
    sessionId: "session-id",
    ...overrides,
  };
}

describe("VectorStore.queryL1Records with recordIds", () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "l1-recordids-test-"));
    store = new VectorStore(path.join(dir, "vectors.db"), 0);
    store.init();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns only the record matching the requested primary key, not the oldest record in the table", () => {
    // Insert an older record first, then the one we'll actually query for.
    store.upsertL1(makeRecord("older-record", { updatedAt: "2026-01-01T00:00:00.000Z" }), undefined);
    store.upsertL1(makeRecord("target-record", { updatedAt: "2026-02-01T00:00:00.000Z" }), undefined);

    const results = store.queryL1Records({ recordIds: ["target-record"] });

    expect(results).toHaveLength(1);
    expect(results[0].record_id).toBe("target-record");
  });

  it("returns an empty array for a recordId that does not exist, even when other records are present", () => {
    store.upsertL1(makeRecord("existing-record"), undefined);

    const results = store.queryL1Records({ recordIds: ["does-not-exist"] });

    expect(results).toEqual([]);
  });

  it("looks up multiple recordIds and preserves isolation filtering afterward", () => {
    store.upsertL1(makeRecord("rec-a", { teamId: "team-1" }), undefined);
    store.upsertL1(makeRecord("rec-b", { teamId: "team-2" }), undefined);

    const results = store.queryL1Records({ recordIds: ["rec-a", "rec-b"], teamId: "team-1" });

    expect(results.map((r) => r.record_id)).toEqual(["rec-a"]);
  });
});

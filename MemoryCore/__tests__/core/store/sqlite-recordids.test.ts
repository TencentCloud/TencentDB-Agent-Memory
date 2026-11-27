/**
 * Regression tests for two defects that together made `/v3/atomic/update`
 * silently destroy a memory row:
 *
 * 1. `VectorStore.queryL1Records({ recordIds })` ignored `recordIds` on the
 *    SQLite backend and returned the whole table ordered by `updated_time ASC`.
 *    Callers took `rows[0]` — the *oldest* record — as the baseline. That made
 *    atomic/update (a) 403 against an unrelated owner and (b) copy the oldest
 *    record's team/user/agent/task/type/scene onto the target, so the edited
 *    note left its tenancy bucket and disappeared from query/search.
 *
 * 2. `upsertL1()` skipped the vec row when the embedding was unavailable,
 *    leaving the *old* vector in place — KNN could then recall stale content
 *    for a row that had already been rewritten.
 *
 * 3. L1 dedup (`writeMemory`) deleted `target_ids` without checking whether a
 *    human had edited them. Manual edits are now protected: the action is
 *    downgraded to `store` and nothing is deleted/overwritten.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VectorStore } from "../../../src/core/store/sqlite/memory-store";
import { writeMemory } from "../../../src/core/record/l1-writer";
import type { MemoryRecord } from "../../../src/core/record/l1-writer";

function makeRecord(overrides: Partial<MemoryRecord> & { id: string }): MemoryRecord {
  return {
    content: "content",
    type: "work_fact",
    priority: 50,
    scene_name: "scene",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-01-01T00:00:00.000Z"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
    sessionKey: "session-key",
    sessionId: "session-1",
    teamId: "team-a",
    userId: "user-a",
    agentId: "agent-a",
    taskId: "task-a",
    ...overrides,
  };
}

describe("sqlite VectorStore.queryL1Records({ recordIds })", () => {
  let store: VectorStore;

  beforeEach(() => {
    const dir = mkdtempSync(path.join(tmpdir(), "tdai-recordids-"));
    // dimensions = 0 → no vec0 tables; metadata + FTS only, which is all these
    // assertions need (and it keeps the test independent of sqlite-vec).
    store = new VectorStore(path.join(dir, "vectors.db"), 0);
    store.init();
  });

  afterEach(() => {
    store.close();
  });

  it("returns exactly the requested row instead of the whole table", () => {
    store.upsertL1(
      makeRecord({ id: "m_oldest", content: "oldest", createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z" }),
      undefined,
    );
    store.upsertL1(
      makeRecord({ id: "m_target", content: "edited", updatedAt: "2026-06-01T00:00:00.000Z" }),
      undefined,
    );

    const rows = store.queryL1Records({ recordIds: ["m_target"] });
    expect(rows.map((row) => row.record_id)).toEqual(["m_target"]);
    expect(rows[0].content).toBe("edited");
  });

  it("returns an empty array for unknown ids (no full-table fallback)", () => {
    store.upsertL1(makeRecord({ id: "m_other" }), undefined);
    expect(store.queryL1Records({ recordIds: ["m_missing"] })).toEqual([]);
  });

  it("keeps combining recordIds with isolation filters", () => {
    store.upsertL1(makeRecord({ id: "m_a", userId: "user-a" }), undefined);
    store.upsertL1(makeRecord({ id: "m_b", userId: "user-b" }), undefined);

    expect(store.queryL1Records({ recordIds: ["m_a", "m_b"], userId: "user-b" }).map((row) => row.record_id)).toEqual([
      "m_b",
    ]);
  });
});

describe("l1-writer manual-edit protection", () => {
  function fakeStore(rows: Array<{ record_id: string; metadata_json: string; version?: number }>) {
    return {
      queryL1Records: vi.fn().mockResolvedValue(
        rows.map((row) => ({
          record_id: row.record_id,
          content: "old",
          type: "work_fact",
          priority: 50,
          scene_name: "scene",
          session_key: "session-key",
          session_id: "session-1",
          team_id: "team-a",
          task_id: "task-a",
          user_id: "user-a",
          agent_id: "agent-a",
          version: row.version ?? 1,
          timestamp_str: "2026-01-01T00:00:00.000Z",
          timestamp_start: "2026-01-01T00:00:00.000Z",
          timestamp_end: "2026-01-01T00:00:00.000Z",
          created_time: "2026-01-01T00:00:00.000Z",
          updated_time: "2026-01-01T00:00:00.000Z",
          metadata_json: row.metadata_json,
        })),
      ),
      deleteL1Batch: vi.fn().mockResolvedValue(true),
      upsertL1: vi.fn().mockResolvedValue(true),
    };
  }

  it("downgrades merge to store and never deletes a manually edited target", async () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), "tdai-l1writer-"));
    const vectorStore = fakeStore([{ record_id: "m_manual", metadata_json: JSON.stringify({ manual_edited_at: "2026-06-01T00:00:00.000Z" }) }]);

    const written = await writeMemory({
      memory: { content: "new fact", type: "work_fact", priority: 80, scene_name: "scene", source_message_ids: [], metadata: {} } as never,
      decision: { record_id: "m_manual", action: "merge", target_ids: ["m_manual"], merged_content: "merged fact" },
      baseDir,
      sessionKey: "session-key",
      sessionId: "session-1",
      teamId: "team-a",
      userId: "user-a",
      agentId: "agent-a",
      vectorStore: vectorStore as never,
    });

    expect(vectorStore.deleteL1Batch).not.toHaveBeenCalled();
    expect(written).not.toBeNull();
    expect(written!.id).not.toBe("m_manual");
    expect(written!.content).toBe("new fact");
    expect(vectorStore.upsertL1).toHaveBeenCalledTimes(1);
  });

  it("still merges normally when no target was manually edited", async () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), "tdai-l1writer-"));
    const vectorStore = fakeStore([{ record_id: "m_auto", metadata_json: "{}" }]);

    const written = await writeMemory({
      memory: { content: "new fact", type: "work_fact", priority: 80, scene_name: "scene", source_message_ids: [], metadata: {} } as never,
      decision: { record_id: "m_auto", action: "merge", target_ids: ["m_auto"], merged_content: "merged fact" },
      baseDir,
      sessionKey: "session-key",
      sessionId: "session-1",
      teamId: "team-a",
      userId: "user-a",
      agentId: "agent-a",
      vectorStore: vectorStore as never,
    });

    expect(vectorStore.deleteL1Batch).toHaveBeenCalledWith(["m_auto"], expect.anything());
    expect(written!.content).toBe("merged fact");
  });
});

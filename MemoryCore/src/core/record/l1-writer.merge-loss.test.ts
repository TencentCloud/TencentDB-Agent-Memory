/**
 * Regression: merge/update must not silently drop the facts of the records it
 * deletes.
 *
 * Contract gap in upstream MemoryCore (`src/core/record/l1-writer.ts`):
 *
 *   finalContent = decision.merged_content ?? memory.content;
 *
 *   1. `??` only falls back on null/undefined. A model that returns
 *      `merged_content: ""` (empty string) — which it does, see the production
 *      observation below — yields a record whose content is EMPTY, while the
 *      target records have already been deleted from the VectorStore.
 *   2. Even with a non-empty `merged_content`, nothing verifies that the
 *      written text still covers the facts of every target record. The model
 *      is free to restate only the new memory, and the target's facts then
 *      disappear from the store with no trace.
 *
 * Both cases are permanent, silent data loss on the default (SQLite) backend:
 * `deleteL1Batch(decision.target_ids, ...)` removes the rows, and the
 * replacement row is upserted with whatever text the model produced.
 *
 * Production observation (TDAI, 2026-11-21, model qwen3.5:9b-mlx):
 * the conflict-detection step answers `merged_content: ""` for skip/store
 * decisions, and the merge path is entered with `merge_count=6 /
 * store_count=0` in a single batch — i.e. six records were merged into
 * existing targets in one pass, each merge deleting its targets.
 */
import { describe, it, expect } from "vitest";
import { writeMemory } from "./l1-writer.js";

interface StoreDouble {
  deleted: string[];
  upserted: Array<{ id: string; content: string }>;
  isFtsAvailable: () => boolean;
  countL1: () => Promise<number>;
  getCapabilities: () => { vectorSearch: boolean; nativeHybridSearch: boolean };
  queryL1Records: (opts: { recordIds?: string[] }) => Promise<unknown[]>;
  deleteL1Batch: (ids: string[]) => Promise<boolean>;
  upsertL1: (record: { id: string; content: string }) => Promise<boolean>;
}

function makeStore(): StoreDouble {
  const deleted: string[] = [];
  const upserted: Array<{ id: string; content: string }> = [];
  return {
    deleted,
    upserted,
    isFtsAvailable: () => true,
    countL1: async () => 10,
    getCapabilities: () => ({ vectorSearch: true, nativeHybridSearch: false }),
    queryL1Records: async (opts: { recordIds?: string[] }) =>
      (opts.recordIds ?? []).map((id) => ({
        record_id: id,
        content: "用户在 2026-11-19 确认旧事实：MemoryProxy 端口 8096 保持闲置。",
        type: "episodic",
        priority: 70,
        scene_name: "scene",
        version: 1,
        timestamp_str: "2026-11-20T01:00:00.000Z",
        timestamp_start: "2026-11-20T01:00:00.000Z",
        timestamp_end: "2026-11-20T01:00:00.000Z",
        metadata_json: "{}",
        session_key: "sess",
        session_id: "sess",
      })),
    deleteL1Batch: async (ids: string[]) => {
      deleted.push(...ids);
      return true;
    },
    upsertL1: async (record: { id: string; content: string }) => {
      upserted.push({ id: record.id, content: record.content });
      return true;
    },
  };
}

const base = {
  baseDir: "/tmp/merge-loss",
  sessionKey: "sess",
  sessionId: "sess",
  taskId: "task",
  teamId: "team",
  userId: "user",
  agentId: "agent",
};

const newMemory = {
  record_id: "m_new_01",
  content: "用户确认 MemoryCore 端口 8420。",
  type: "episodic" as const,
  priority: 70,
  scene_name: "端口配置",
  source_message_ids: ["msg-2"],
  metadata: {},
  event_time: "2026-11-20T02:00:00.000Z",
};

describe("writeMemory merge/update content guards", () => {
  it("does not write an empty record when the model returns empty merged_content", async () => {
    const vectorStore = makeStore();

    const record = await writeMemory({
      memory: newMemory,
      decision: {
        record_id: "m_new_01",
        action: "merge",
        target_ids: ["m_tgt_01"],
        merged_content: "",
        merged_type: "episodic",
        merged_priority: 75,
        merged_timestamps: ["2026-11-20T02:00:00.000Z"],
      },
      vectorStore,
      ...base,
    });

    // The new memory's own fact must survive.
    expect(record?.content ?? "").toContain("8420");
    // The upserted row must not be empty.
    expect((vectorStore.upserted[0]?.content ?? "").length).toBeGreaterThan(0);
  });

  it("does not delete a target whose facts are absent from merged_content", async () => {
    const vectorStore = makeStore();

    await writeMemory({
      memory: newMemory,
      decision: {
        record_id: "m_new_01",
        action: "merge",
        target_ids: ["m_tgt_01"],
        // The model restated only the new memory — the target's own fact
        // ("旧事实") is nowhere in this text.
        merged_content: "用户确认 MemoryCore 端口 8420。",
        merged_type: "episodic",
        merged_priority: 75,
        merged_timestamps: ["2026-11-20T02:00:00.000Z"],
      },
      vectorStore,
      ...base,
    });

    // merged_content dropped the target's fact, so the target must NOT be
    // deleted — otherwise the fact is gone from the store forever.
    expect(vectorStore.deleted).not.toContain("m_tgt_01");
  });
  it("allows a merge whose merged_content covers the target facts", async () => {
    const vectorStore = makeStore();

    const record = await writeMemory({
      memory: newMemory,
      decision: {
        record_id: "m_new_01",
        action: "merge",
        target_ids: ["m_tgt_01"],
        // Legitimate merge: restates the target AND adds the new fact.
        merged_content:
          "用户在 2026-11-19 确认旧事实：MemoryProxy 端口 8096 保持闲置；" +
          "用户在 2026-11-20 确认 MemoryCore 端口 8420。",
        merged_type: "episodic",
        merged_priority: 80,
        merged_timestamps: ["2026-11-20T02:00:00.000Z"],
      },
      vectorStore,
      ...base,
    });

    // The guard must NOT block a merge that carried the facts over.
    expect(vectorStore.deleted).toContain("m_tgt_01");
    expect(record?.content ?? "").toContain("8420");
    expect(record?.content ?? "").toContain("8096");
  });
});

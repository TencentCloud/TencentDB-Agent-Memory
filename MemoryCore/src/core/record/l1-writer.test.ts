/**
 * Unit tests for writeMemory — batch intra-dedup branches.
 *
 * Focus:
 * - skip → returns null, writes/appends nothing
 * - merge with empty target_ids (pure batch dedup) → appends merged content,
 *   does NOT call deleteL1Batch, upserts merged record
 *
 * Mock style: hand-written mocks (MockVectorStore / MockStorage), matching the
 * repo's existing convention (see sdk/typescript/tests/client.test.ts).
 */

import { describe, it, expect } from "vitest";
import { writeMemory } from "./l1-writer.js";
import type { ExtractedMemory, DedupDecision, MemoryRecord } from "./l1-writer.js";
import type { IMemoryStore } from "../store/types.js";
import type { StorageAdapter } from "../storage/adapter.js";

function mkMemory(): ExtractedMemory {
  return {
    content: "用户决定前端框架从 Vue 2 迁移到 Vue 3",
    type: "episodic",
    priority: 80,
    source_message_ids: ["msg-1"],
    metadata: {},
    scene_name: "default",
  };
}

interface MockVectorStore {
  /** Records the (ids, filter) passed to each deleteL1Batch call. */
  deleted: Array<{ ids: string[]; filter: unknown }>;
  upserted: Array<{ record: MemoryRecord; hasEmbedding: boolean }>;
  /** Existing records returned by queryL1Records (used by update/merge to read version). */
  existing: MemoryRecord[];
}

/**
 * Minimal IMemoryStore mock recording deleteL1Batch / upsertL1 / queryL1Records calls.
 * deleteL1Batch 记录传入的 filter，以便断言隔离过滤器的形状。
 */
function mkVectorStore(existing: MemoryRecord[] = []): IMemoryStore & MockVectorStore {
  const mock: MockVectorStore = { deleted: [], upserted: [], existing };
  return {
    ...mock,
    deleteL1Batch: async (ids: string[], filter?: unknown) => {
      mock.deleted.push({ ids, filter });
      return true;
    },
    upsertL1: async (record: MemoryRecord, embedding?: Float32Array) => {
      mock.upserted.push({ record, hasEmbedding: embedding !== undefined });
      return true;
    },
    queryL1Records: async (_params: { recordIds: string[] }) => mock.existing,
  } as unknown as IMemoryStore & MockVectorStore;
}

interface MockStorage {
  appended: Array<{ key: string; content: string }>;
}

/** Minimal StorageAdapter mock recording appendFile calls. */
function mkStorage(): StorageAdapter & MockStorage {
  const mock: MockStorage = { appended: [] };
  return {
    ...mock,
    appendFile: async (key: string, content: string) => {
      mock.appended.push({ key, content });
    },
  } as unknown as StorageAdapter & MockStorage;
}

describe("writeMemory - batch intra-dedup branches", () => {
  it("skip returns null and writes/appends nothing", async () => {
    const vs = mkVectorStore();
    const storage = mkStorage();

    const result = await writeMemory({
      memory: mkMemory(),
      decision: { record_id: "m4", action: "skip", target_ids: [] } satisfies DedupDecision,
      baseDir: "/tmp",
      sessionKey: "s1",
      vectorStore: vs,
      storage,
    });

    expect(result).toBeNull();
    expect(storage.appended).toHaveLength(0);
    expect(vs.deleted).toHaveLength(0);
    expect(vs.upserted).toHaveLength(0);
  });

  it("merge with empty target_ids appends merged content, does not delete, upserts merged record", async () => {
    const vs = mkVectorStore();
    const storage = mkStorage();
    const merged = "用户决定前端框架从 Vue 2 迁移到 Vue 3，预计 Q3 完成";

    const result = await writeMemory({
      memory: mkMemory(),
      decision: {
        record_id: "m1",
        action: "merge",
        target_ids: [],
        merged_content: merged,
        merged_type: "episodic",
        merged_priority: 85,
        merged_timestamps: ["t1", "t2"],
      } satisfies DedupDecision,
      baseDir: "/tmp",
      sessionKey: "s1",
      vectorStore: vs,
      storage,
    });

    expect(result).not.toBeNull();
    expect(result!.content).toBe(merged);
    expect(result!.priority).toBe(85);
    // empty target_ids → goes through the append (store-like) branch, no deletion
    expect(vs.deleted).toHaveLength(0);
    // merged record appended to JSONL
    expect(storage.appended).toHaveLength(1);
    expect(storage.appended[0]!.content).toContain(merged);
    // dual-write upserts the merged record (no embedding service → undefined embedding)
    expect(vs.upserted).toHaveLength(1);
    expect(vs.upserted[0]!.record.content).toBe(merged);
    expect(vs.upserted[0]!.hasEmbedding).toBe(false);
  });

  it("update with non-empty target_ids deletes targets with scope-only filter (no sessionId/sessionKey)", async () => {
    // Regression guard: when update replaces a cross-session old record, the delete
    // filter must isolate only by scope (team/user/agent) without sessionId/sessionKey
    // — otherwise rowMatchesIsolation filters out the cross-session old record and
    // update cannot actually delete it (old and new coexist). See deleteFilter in l1-writer.ts.
    const existingOld = { id: "c1", version: 2 } as unknown as MemoryRecord;
    const vs = mkVectorStore([existingOld]);
    const storage = mkStorage();
    const updated = "用户不喜欢喝单丛茶。";

    const result = await writeMemory({
      memory: mkMemory(),
      decision: {
        record_id: "m1",
        action: "update",
        target_ids: ["c1"],
        merged_content: updated,
        merged_type: "persona",
        merged_priority: 85,
        merged_timestamps: ["t1", "t2"],
      } satisfies DedupDecision,
      baseDir: "/tmp",
      sessionKey: "sess-correct-tea-vfy3",
      sessionId: "sess-correct-tea-vfy3",
      teamId: "team-vswf3d49st",
      userId: "usr-tnw0vg7cdv",
      agentId: "agt-vswfutdjgl",
      vectorStore: vs,
      storage,
    });

    expect(result).not.toBeNull();
    // Old record deleted
    expect(vs.deleted).toHaveLength(1);
    expect(vs.deleted[0]!.ids).toEqual(["c1"]);
    // Key assertion: filter contains only the scope triple, no sessionId / sessionKey
    const filter = vs.deleted[0]!.filter as Record<string, unknown>;
    expect(filter).toEqual({
      teamId: "team-vswf3d49st",
      userId: "usr-tnw0vg7cdv",
      agentId: "agt-vswfutdjgl",
    });
    expect(filter).not.toHaveProperty("sessionId");
    expect(filter).not.toHaveProperty("sessionKey");
    // New record written, version = old version + 1
    expect(vs.upserted).toHaveLength(1);
    expect(vs.upserted[0]!.record.content).toBe(updated);
    expect(vs.upserted[0]!.record.version).toBe(3);
  });

  it("update without scope fields still passes a normalised default-bucket filter", async () => {
    // When team/user/agent are all absent, the filter must not disappear (that would
    // allow cross-tenant unisolated deletes); instead it normalizes to the default
    // bucket: { userId: "default", agentId: "default" } with no teamId key.
    const existingOld = { id: "c1", version: 0 } as unknown as MemoryRecord;
    const vs = mkVectorStore([existingOld]);
    const storage = mkStorage();

    await writeMemory({
      memory: mkMemory(),
      decision: {
        record_id: "m1",
        action: "update",
        target_ids: ["c1"],
        merged_content: "更新后的内容",
        merged_type: "episodic",
        merged_priority: 80,
        merged_timestamps: ["t1"],
      } satisfies DedupDecision,
      baseDir: "/tmp",
      sessionKey: "s1",
      vectorStore: vs,
      storage,
    });

    expect(vs.deleted).toHaveLength(1);
    expect(vs.deleted[0]!.ids).toEqual(["c1"]);
    const filter = vs.deleted[0]!.filter as Record<string, unknown>;
    expect(filter).toEqual({ userId: "default", agentId: "default" });
    expect(filter).not.toHaveProperty("teamId");
    expect(filter).not.toHaveProperty("sessionId");
  });
});

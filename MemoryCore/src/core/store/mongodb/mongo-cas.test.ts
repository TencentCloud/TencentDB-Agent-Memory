import { describe, expect, it, vi } from "vitest";
import type { MemoryRecord } from "../../record/l1-writer.js";
import { MongoMemoryStore } from "./memory-store.js";
import { l1RecordToDoc } from "./doc-mappers.js";
import { handleV2Route, type V2RouterDeps } from "../../../gateway/v2-router.js";
import { COLLECTIONS } from "./collections.js";

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "memory-1", content: "original", type: "persona", priority: 50,
    scene_name: "default", source_message_ids: [], metadata: {}, timestamps: [],
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
    version: 2, sessionKey: "session-key", sessionId: "session-1",
    teamId: "team-1", userId: "user-1", agentId: "agent-1", taskId: "task-1",
    ...overrides,
  };
}

function harness(initial: MemoryRecord | undefined = record()) {
  let doc: Record<string, unknown> | undefined = initial ? l1RecordToDoc(initial) as unknown as Record<string, unknown> : undefined;
  const collection = {
    updateOne: vi.fn(async (filter: Record<string, unknown>, update: any, options: any) => {
      expect(options).toEqual({ upsert: false });
      if (!doc || !Object.entries(filter).every(([key, value]) => doc![key] === value)) {
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      }
      doc = { ...doc, ...update.$set, version: Number(doc.version) + update.$inc.version };
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
    }),
    findOne: vi.fn(async () => doc ? { ...doc } : null),
    find: vi.fn(() => ({ toArray: async () => doc ? [{ ...doc }] : [] })),
  };
  const store = new MongoMemoryStore({ pool: {} as any, mongoConfig: { database: "test" } as any });
  // Exercise the real adapter while isolating network/index initialization.
  Object.assign(store, { db: { collection: vi.fn((name) => {
    expect(name).toBe(COLLECTIONS.L1);
    return collection;
  }) } });
  return { store, collection, read: () => doc, remove: () => { doc = undefined; } };
}

describe("MongoMemoryStore.compareAndSwapL1 (deterministic collection fake)", () => {
  it("atomically allocates the committed version and rejects a superseded token", async () => {
    const { store, collection, read } = harness();
    expect(await store.compareAndSwapL1(record({ version: 999, content: "winner", createdAt: "wrong" }), 2))
      .toEqual({ status: "updated", version: 3 });
    expect(collection.updateOne).toHaveBeenCalledWith(
      { _id: "memory-1", version: 2, team_id: "team-1", agent_id: "agent-1", user_id: "user-1", task_id: "task-1" },
      { $set: expect.objectContaining({ content: "winner" }), $inc: { version: 1 } },
      { upsert: false },
    );
    expect(read()).toMatchObject({ version: 3, content: "winner", created_time: "2026-09-01T00:00:00.000Z" });
    expect(collection.findOne).not.toHaveBeenCalled();
    expect(await store.compareAndSwapL1(record({ content: "stale" }), 2))
      .toEqual({ status: "conflict", currentVersion: 3 });
    expect(read()?.content).toBe("winner");
  });

  it("permits exactly one writer for a shared expected version", async () => {
    const { store } = harness();
    const results = await Promise.all([
      store.compareAndSwapL1(record({ content: "first" }), 2),
      store.compareAndSwapL1(record({ content: "second" }), 2),
    ]);
    expect(results.filter((r) => r.status === "updated")).toEqual([{ status: "updated", version: 3 }]);
    expect(results.filter((r) => r.status === "conflict")).toEqual([{ status: "conflict", currentVersion: 3 }]);
  });

  it.each(["teamId", "agentId", "userId", "taskId"] as const)("keeps the %s isolation predicate", async (field) => {
    const { store, read } = harness();
    expect(await store.compareAndSwapL1(record({ [field]: "other" }), 2))
      .toEqual({ status: "conflict", currentVersion: 2 });
    expect(read()?.content).toBe("original");
  });

  it("does not recreate deleted records", async () => {
    const { store, remove } = harness();
    remove();
    expect(await store.compareAndSwapL1(record(), 2)).toEqual({ status: "not_found" });
  });

  it("does not retry or infer a conflict after an ambiguous write error", async () => {
    const { store, collection } = harness();
    collection.updateOne.mockRejectedValue(new Error("response lost after possible commit"));
    expect(await store.compareAndSwapL1(record(), 2)).toEqual({ status: "failed" });
    expect(collection.updateOne).toHaveBeenCalledTimes(1);
    expect(collection.findOne).not.toHaveBeenCalled();
  });

  it("does not report success for an unacknowledged write", async () => {
    const { store, collection } = harness();
    collection.updateOne.mockResolvedValue({ acknowledged: false, matchedCount: 0, modifiedCount: 0 });
    expect(await store.compareAndSwapL1(record(), 2)).toEqual({ status: "failed" });
    expect(collection.findOne).not.toHaveBeenCalled();
  });

  it.each([Number.MAX_SAFE_INTEGER, NaN, -1, 1.5])("rejects unsafe expected version %s before writing", async (version) => {
    const { store, collection } = harness();
    expect(await store.compareAndSwapL1(record(), version)).toEqual({ status: "failed" });
    expect(collection.updateOne).not.toHaveBeenCalled();
  });
  it.each([true, false])("supports gateway clients and committed response/audit (guarded competitors: %s)", async (guardedCompetitors) => {
    const { store, read } = harness();
    const audit = vi.spyOn(store, "appendAudit").mockResolvedValue(undefined);
    const upsert = vi.spyOn(store, "upsertL1");
    let entered!: () => void;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    const deps: V2RouterDeps = {
      getStore: () => store,
      getStorage: () => undefined,
      getEmbedding: () => ({ embed: async (content: string) => {
        if (content === "legacy") { entered(); await resume; }
        return new Float32Array(0);
      } }) as any,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      deployMode: "standalone",
    };
    async function update(content: string, expected_version?: number) {
      let response: { status: number; body: any } | undefined;
      await handleV2Route(
        { headers: { authorization: "Bearer test-key", "x-tdai-service-id": "service-1" }, url: "/v3/atomic/update" } as any,
        {} as any, "/v3/atomic/update", "POST",
        async <T,>() => ({ team_id: "team-1", user_id: "user-1", agent_id: "agent-1", task_id: "task-1", session_id: "session-1", id: "memory-1", content, ...(expected_version !== undefined ? { expected_version } : {}) }) as T,
        (_res, status, body) => { response = { status, body }; }, deps,
      );
      return response!;
    }
    const legacy = update("legacy");
    await paused;
    expect((await update("first", guardedCompetitors ? 2 : undefined)).body.data.version).toBe("v3");
    expect((await update("second", guardedCompetitors ? 3 : undefined)).body.data.version).toBe("v4");
    release();
    expect((await legacy).body.data.version).toBe("v5");
    expect(read()).toMatchObject({ content: "legacy", version: 5 });
    expect(audit.mock.calls.map(([entry]) => entry.version)).toEqual([3, 4, 5]);
    expect(upsert).not.toHaveBeenCalled();
    expect((await update("stale", 3)).status).toBe(409);
    expect(read()).toMatchObject({ content: "legacy", version: 5 });
  });

});

import { describe, expect, it, vi } from "vitest";
import type { MemoryRecord } from "../../record/l1-writer.js";
import { MongoMemoryStore } from "./memory-store.js";

function record(content: string): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id: "approved-memory-1",
    content,
    type: "persona",
    priority: 50,
    scene_name: "",
    source_message_ids: [],
    metadata: { source: "lifeos", approval_ref: "approval-1" },
    timestamps: [now],
    createdAt: now,
    updatedAt: now,
    sessionKey: "session-1",
    sessionId: "session-1",
    teamId: "team-1",
    agentId: "agent-1",
    userId: "user-1",
  };
}

describe("MongoMemoryStore createL1", () => {
  it("treats duplicate _id as a conflict and never replaces the stored document", async () => {
    const docs = new Map<string, Record<string, unknown>>();
    const insertOne = vi.fn(async (doc: Record<string, unknown>) => {
      const id = String(doc._id);
      if (docs.has(id)) throw Object.assign(new Error("duplicate key"), { code: 11000 });
      docs.set(id, doc);
      return { acknowledged: true, insertedId: id };
    });
    const fakeStore = Object.create(MongoMemoryStore.prototype) as unknown as {
      coll: () => Promise<unknown>;
      createL1: MongoMemoryStore["createL1"];
      topology: "replicaSet";
      db: object;
    };
    fakeStore.topology = "replicaSet";
    fakeStore.db = {};
    fakeStore.coll = async () => ({ insertOne }) as never;

    expect(await fakeStore.createL1!(record("original approved content"))).toBe(true);
    expect(await fakeStore.createL1!(record("conflicting payload"))).toBe(false);
    expect(insertOne).toHaveBeenCalledTimes(2);
    expect(docs.get("approved-memory-1")?.content).toBe("original approved content");
  });

  it("does not classify unrelated Mongo errors as duplicate conflicts", async () => {
    const insertOne = vi.fn(async () => { throw new Error("network unavailable"); });
    const fakeStore = Object.create(MongoMemoryStore.prototype) as unknown as {
      coll: () => Promise<unknown>;
      createL1: MongoMemoryStore["createL1"];
      topology: "replicaSet";
      db: object;
    };
    fakeStore.topology = "replicaSet";
    fakeStore.db = {};
    fakeStore.coll = async () => ({ insertOne }) as never;

    await expect(fakeStore.createL1!(record("payload"))).rejects.toThrow("network unavailable");
  });

  it("disables atomic create for sharded topology", async () => {
    const fakeStore = Object.create(MongoMemoryStore.prototype) as unknown as {
      createL1: MongoMemoryStore["createL1"];
      topology: "sharded";
      db: object;
    };
    fakeStore.topology = "sharded";
    fakeStore.db = {};

    expect(fakeStore.createL1).toBeDefined();
    await expect(fakeStore.createL1!(record("payload"))).rejects.toThrow("non-sharded MongoDB");
  });
});

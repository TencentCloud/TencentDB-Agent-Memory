import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryRecord } from "../record/l1-writer.js";
import { VectorStore } from "./sqlite.js";

const tempDirs: string[] = [];

function provider(model: string, schemaIdentity: string, modelRevision: string) {
  return { provider: "openai", model, schemaIdentity, modelRevision, normalization: "l2-v1" };
}

function l1Record(): MemoryRecord {
  const now = new Date(0).toISOString();
  return {
    id: "l1-source",
    content: "durable structured memory",
    type: "episodic",
    priority: 50,
    scene_name: "test",
    source_message_ids: ["l0-source"],
    metadata: {},
    timestamps: [now],
    createdAt: now,
    updatedAt: now,
    sessionKey: "session",
    sessionId: "session",
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("non-destructive embedding migration", () => {
  it("preserves active vectors across failure/restart, resumes, and atomically cuts over", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-embedding-migration-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "vectors.db");

    let store = new VectorStore(dbPath, 3);
    expect(store.init(provider("runtime-old", "bge-m3", "rev-1")).needsReindex).toBe(false);
    expect(store.upsertL1(l1Record(), new Float32Array([1, 0, 0]))).toBe(true);
    expect(store.upsertL0({
      id: "l0-source",
      sessionKey: "session",
      sessionId: "session",
      role: "user",
      messageText: "durable raw conversation",
      recordedAt: new Date(0).toISOString(),
      timestamp: 0,
    }, new Float32Array([1, 0, 0]))).toBe(true);
    expect(store.searchL0Vector(new Float32Array([1, 0, 0]), 1)).toHaveLength(1);
    store.close();

    store = new VectorStore(dbPath, 4);
    const migrationInit = store.init(provider("runtime-new", "bge-multilingual", "rev-2"));
    expect(migrationInit.needsReindex).toBe(true);
    expect(migrationInit.migration?.state).toBe("required");
    const activeDdl = (store.getRawDb().prepare("SELECT sql FROM sqlite_master WHERE name='l0_vec'").get() as { sql: string }).sql;
    expect(activeDdl).toContain("float[3]");
    expect(store.getAllL0Texts()).toHaveLength(1);
    expect(store.searchL0Vector(new Float32Array(4), 1)).toEqual([]);
    expect(store.searchL0Vector(new Float32Array([1, 0, 0]), 1)).toHaveLength(1);

    await store.reindexAll(async (text) => {
      if (text.includes("raw")) throw new Error("transient embedding outage");
      return new Float32Array([0, 1, 0, 0]);
    });
    expect(store.getEmbeddingMigrationStatus()).toMatchObject({
      state: "failed",
      l0: { sourceRows: 1, migratedRows: 0, coverage: 0 },
      l1: { sourceRows: 1, migratedRows: 1, coverage: 1 },
    });
    expect(() => store.commitEmbeddingMigration(0)).toThrow(/threshold must be greater than 0/);
    expect(() => store.commitEmbeddingMigration()).toThrow(/coverage below readiness threshold/);
    expect((store.getRawDb().prepare("SELECT COUNT(*) AS count FROM l0_vec").get() as { count: number }).count).toBe(1);
    expect(store.searchL0Vector(new Float32Array([1, 0, 0]), 1)).toHaveLength(1);
    store.close();

    // Restart resumes from persisted shadow state without dropping the active index.
    store = new VectorStore(dbPath, 4);
    expect(store.init(provider("runtime-new", "bge-multilingual", "rev-2")).needsReindex).toBe(true);
    await store.reindexAll(async () => new Float32Array([0, 1, 0, 0]));
    expect(store.getEmbeddingMigrationStatus()).toMatchObject({
      state: "ready",
      l0: { coverage: 1 },
      l1: { coverage: 1 },
    });
    expect((store.getRawDb().prepare("SELECT sql FROM sqlite_master WHERE name='l0_vec'").get() as { sql: string }).sql).toContain("float[3]");

    expect(store.commitEmbeddingMigration(1).state).toBe("none");
    const replacementDdl = (store.getRawDb().prepare("SELECT sql FROM sqlite_master WHERE name='l0_vec'").get() as { sql: string }).sql;
    expect(replacementDdl).toContain("float[4]");
    expect(store.countL0()).toBe(1);
    expect(store.countL1()).toBe(1);
    const directRows = store.getRawDb().prepare(
      "SELECT record_id, distance FROM l0_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance",
    ).all(Buffer.from(new Float32Array([0, 1, 0, 0]).buffer), 11);
    expect(directRows).toHaveLength(1);
    expect(store.searchL0Vector(new Float32Array([0, 1, 0, 0]), 1)).toHaveLength(1);
    store.close();

    // A serving alias change with the same schema identity/revision is runtime-only.
    store = new VectorStore(dbPath, 4);
    const aliasInit = store.init(provider("runtime-new-alias", "bge-multilingual", "rev-2"));
    expect(aliasInit.needsReindex).toBe(false);
    expect(store.searchL0Vector(new Float32Array([0, 1, 0, 0]), 1)).toHaveLength(1);
    store.close();
  });

  it("rolls back a partial shadow index without touching active vectors or sources", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-embedding-rollback-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "vectors.db");
    let store = new VectorStore(dbPath, 3);
    store.init(provider("old", "model-a", "1"));
    store.upsertL0({
      id: "source",
      sessionKey: "s",
      sessionId: "s",
      role: "user",
      messageText: "source",
      recordedAt: new Date(0).toISOString(),
      timestamp: 0,
    }, new Float32Array([1, 0, 0]));
    store.close();

    store = new VectorStore(dbPath, 4);
    store.init(provider("new", "model-b", "2"));
    await store.reindexAll(async () => { throw new Error("offline"); });
    const rolledBack = store.rollbackEmbeddingMigration();
    expect(rolledBack.state).toBe("none");
    expect(store.getRawDb().prepare("SELECT 1 FROM sqlite_master WHERE name='l0_vec_next'").get()).toBeUndefined();
    expect((store.getRawDb().prepare("SELECT COUNT(*) AS count FROM l0_vec").get() as { count: number }).count).toBe(1);
    expect(store.countL0()).toBe(1);
    store.close();
  });
});

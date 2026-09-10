import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VectorStore } from "../store/sqlite/memory-store.js";
import { TcvdbMemoryStore } from "../store/tcvdb/memory-store.js";
import type { MemoryRecord } from "./l1-writer.js";
import { writeMemory } from "./l1-writer.js";
import { recallL1Candidates } from "../tools/l1-candidate-recall.js";
import { queryMemoryRecords } from "./l1-reader.js";

const now = "2026-08-17T00:00:00.000Z";

function memoryRecord(id: string, sourceMessageIds: string[]): MemoryRecord {
  return {
    id,
    content: `memory ${id} about provenance`,
    type: "episodic",
    priority: 50,
    scene_name: "test",
    source_message_ids: sourceMessageIds,
    metadata: {},
    timestamps: [now],
    createdAt: now,
    updatedAt: now,
    version: 0,
    sessionKey: "session-a",
    sessionId: "session-a",
  };
}

describe("L1 source message provenance", () => {
  let directory: string;
  let databasePath: string;
  let store: VectorStore | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "tdai-l1-provenance-"));
    databasePath = path.join(directory, "vectors.db");
  });

  afterEach(async () => {
    store?.close();
    store = undefined;
    await rm(directory, { recursive: true, force: true });
  });

  function createStore(): VectorStore {
    store = new VectorStore(databasePath, 0);
    store.init();
    return store;
  }

  it("round-trips source IDs through the SQLite L1 read path", async () => {
    const vectorStore = createStore();
    expect(vectorStore.upsertL1(memoryRecord("l1-roundtrip", ["msg-1", "msg-2", "msg-1"]))).toBe(true);

    const records = await queryMemoryRecords(vectorStore, { recordIds: ["l1-roundtrip"] });
    expect(records).toHaveLength(1);
    expect(records[0].source_message_ids).toEqual(["msg-1", "msg-2"]);

    const recalled = await recallL1Candidates({ query: "provenance", topK: 1, vectorStore });
    expect(recalled.hits[0].source_message_ids_json).toBe('["msg-1","msg-2"]');
  });

  it("migrates existing SQLite databases with empty provenance", async () => {
    // A persisted database without the new column models the previous schema.
    const initial = createStore();
    initial.upsertL1(memoryRecord("legacy", []));
    initial.close();
    store = undefined;
    const legacyDb = new DatabaseSync(databasePath);
    legacyDb.exec("ALTER TABLE l1_records DROP COLUMN source_message_ids_json");
    legacyDb.close();

    const vectorStore = createStore();
    const records = await queryMemoryRecords(vectorStore, { recordIds: ["legacy"] });
    expect(records[0].source_message_ids).toEqual([]);
  });

  it.each(["teamId", "userId", "agentId", "sessionId", "sessionKey"] as const)("keeps merge provenance inside the replacement scope (%s)", async (dimension) => {
    const vectorStore = createStore();
    expect(vectorStore.upsertL1({ ...memoryRecord("target", ["msg-old"]), teamId: "team", userId: "user", agentId: "agent" })).toBe(true);
    expect(vectorStore.upsertL1(memoryRecord("unrelated", ["msg-unrelated"]))).toBe(true);

    expect(vectorStore.upsertL1({ ...memoryRecord("outside", ["msg-outside"]),
      teamId: "team", userId: "user", agentId: "agent", [dimension]: "other" })).toBe(true);

    const written = await writeMemory({
      memory: {
        content: "updated memory about provenance",
        type: "episodic",
        priority: 50,
        scene_name: "test",
        source_message_ids: ["msg-new"],
        metadata: {},
      },
      decision: {
        record_id: "replacement",
        action: "merge",
        target_ids: ["target", "outside"],
        merged_content: "merged memory about provenance",
      },
      baseDir: directory,
      sessionKey: "session-a",
      sessionId: "session-a",
      teamId: "team", userId: "user", agentId: "agent",
      vectorStore,
    });

    expect(written?.source_message_ids).toEqual(["msg-old", "msg-new"]);
    expect(vectorStore.queryL1Records({ recordIds: ["outside"] })).toHaveLength(1);
    const records = await queryMemoryRecords(vectorStore, { recordIds: ["replacement"] });
    expect(records[0].source_message_ids).toEqual(["msg-old", "msg-new"]);
  });

  it("serializes provenance for TCVDB", async () => {
    const vectorStore = new TcvdbMemoryStore({
      url: "http://localhost:8080",
      username: "test-user",
      apiKey: "test-key",
      database: "test",
      embeddingModel: "test-model",
    });
    const client = {
      upsert: vi.fn().mockResolvedValue(undefined),
    };
    (vectorStore as unknown as { client: typeof client }).client = client;

    await expect(vectorStore.upsertL1(memoryRecord("tcvdb", ["msg-1", "msg-1", "msg-2"]))).resolves.toBe(true);
    expect(client.upsert).toHaveBeenCalledWith(
      "test_l1_memories",
      [expect.objectContaining({ source_message_ids_json: '["msg-1","msg-2"]' })],
    );

  });
});

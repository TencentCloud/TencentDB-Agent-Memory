import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VectorStore } from "../store/sqlite.js";
import { TcvdbMemoryStore } from "../store/tcvdb.js";
import type { MemoryRecord } from "./l1-writer.js";
import { writeMemory } from "./l1-writer.js";
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

    const rows = vectorStore.queryL1Records({ recordIds: ["l1-roundtrip"] });
    expect(rows).toHaveLength(1);
    expect(rows[0].source_message_ids_json).toBe('["msg-1","msg-2"]');

    const records = await queryMemoryRecords(vectorStore, { recordIds: ["l1-roundtrip"] });
    expect(records).toHaveLength(1);
    expect(records[0].source_message_ids).toEqual(["msg-1", "msg-2"]);

    if (vectorStore.isFtsAvailable()) {
      const ftsResults = vectorStore.searchL1Fts("provenance", 1);
      expect(ftsResults[0].source_message_ids_json).toBe('["msg-1","msg-2"]');
    }
  });

  it("migrates existing SQLite databases with empty provenance", async () => {
    const legacyDb = new DatabaseSync(databasePath);
    legacyDb.exec(`
      CREATE TABLE l1_records (
        record_id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        type TEXT DEFAULT '',
        priority INTEGER DEFAULT 50,
        scene_name TEXT DEFAULT '',
        session_key TEXT DEFAULT '',
        session_id TEXT DEFAULT 'default',
        team_id TEXT DEFAULT 'default',
        task_id TEXT DEFAULT '',
        user_id TEXT NOT NULL DEFAULT 'default',
        agent_id TEXT NOT NULL DEFAULT 'default',
        version INTEGER NOT NULL DEFAULT 0,
        timestamp_str TEXT DEFAULT '',
        timestamp_start TEXT DEFAULT '',
        timestamp_end TEXT DEFAULT '',
        created_time TEXT DEFAULT '',
        updated_time TEXT DEFAULT '',
        metadata_json TEXT DEFAULT '{}'
      )
    `);
    legacyDb.prepare("INSERT INTO l1_records (record_id, content) VALUES (?, ?)").run("legacy", "legacy memory");
    legacyDb.close();

    const vectorStore = createStore();
    const sourceColumn = vectorStore.getRawDb()
      .prepare("SELECT source_message_ids_json FROM l1_records WHERE record_id = ?")
      .get("legacy") as { source_message_ids_json: string };
    expect(sourceColumn.source_message_ids_json).toBe("[]");

    const records = await queryMemoryRecords(vectorStore, { recordIds: ["legacy"] });
    expect(records[0].source_message_ids).toEqual([]);
  });

  it("keeps provenance from only the records replaced by an L1 merge", async () => {
    const vectorStore = createStore();
    expect(vectorStore.upsertL1(memoryRecord("target", ["msg-old"]))).toBe(true);
    expect(vectorStore.upsertL1(memoryRecord("unrelated", ["msg-unrelated"]))).toBe(true);

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
        target_ids: ["target"],
        merged_content: "merged memory about provenance",
      },
      baseDir: directory,
      sessionKey: "session-a",
      sessionId: "session-a",
      vectorStore,
    });

    expect(written?.source_message_ids).toEqual(["msg-old", "msg-new"]);
    const records = await queryMemoryRecords(vectorStore, { recordIds: ["replacement"] });
    expect(records[0].source_message_ids).toEqual(["msg-old", "msg-new"]);
  });

  it("serializes provenance for TCVDB and tolerates legacy documents", async () => {
    const vectorStore = new TcvdbMemoryStore({
      url: "http://localhost:8080",
      username: "test-user",
      apiKey: "test-key",
      database: "test",
      embeddingModel: "test-model",
    });
    const client = {
      upsert: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue({
        documents: [{
          id: "legacy",
          text: "legacy memory",
          type: "episodic",
          priority: 50,
        }],
      }),
    };
    (vectorStore as unknown as { client: typeof client }).client = client;

    await expect(vectorStore.upsertL1(memoryRecord("tcvdb", ["msg-1", "msg-1", "msg-2"]))).resolves.toBe(true);
    expect(client.upsert).toHaveBeenCalledWith(
      "test_l1_memories",
      [expect.objectContaining({ source_message_ids_json: '["msg-1","msg-2"]' })],
    );

    await expect(vectorStore.queryL1Records({ recordIds: ["legacy"] })).resolves.toEqual([
      expect.objectContaining({ record_id: "legacy", source_message_ids_json: "[]" }),
    ]);
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { queryMemoryRecords } from "./l1-reader.js";
import { writeMemory, type MemoryRecord } from "./l1-writer.js";
import type { IMemoryStore, L1RecordRow } from "../store/types.js";

describe("L1 provenance fields", () => {
  it("persists source, credibility_score, and namespace in JSONL and vector metadata", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-l1-provenance-"));
    let upserted: MemoryRecord | undefined;

    const vectorStore = {
      upsertL1: (record: MemoryRecord) => {
        upserted = record;
        return true;
      },
      deleteL1Batch: () => true,
    } as unknown as IMemoryStore;

    const record = await writeMemory({
      memory: {
        content: "User prefers source-aware recall.",
        type: "persona",
        priority: 80,
        source_message_ids: ["m1"],
        metadata: {},
        source: "seed-import",
        credibility_score: 0.82,
        namespace: "workspace-a",
        scene_name: "memory provenance",
      },
      decision: { record_id: "rec-provenance", action: "store", target_ids: [] },
      baseDir,
      sessionKey: "session-a",
      vectorStore,
    });

    expect(record).toMatchObject({
      source: "seed-import",
      credibility_score: 0.82,
      namespace: "workspace-a",
    });
    expect(record?.metadata).toMatchObject({
      source: "seed-import",
      credibility_score: 0.82,
      namespace: "workspace-a",
    });
    expect(upserted?.metadata).toMatchObject(record?.metadata ?? {});

    const files = await fs.readdir(path.join(baseDir, "records"));
    const raw = await fs.readFile(path.join(baseDir, "records", files[0]), "utf-8");
    const persisted = JSON.parse(raw.trim()) as MemoryRecord;
    expect(persisted.source).toBe("seed-import");
    expect(persisted.metadata.namespace).toBe("workspace-a");
  });

  it("restores provenance fields from SQLite metadata_json rows", async () => {
    const row: L1RecordRow = {
      record_id: "rec-row",
      content: "Remember the provenance row.",
      type: "episodic",
      priority: 60,
      scene_name: "debugging",
      session_key: "session-a",
      session_id: "sid-a",
      timestamp_str: "2026-07-14T00:00:00.000Z",
      timestamp_start: "2026-07-14T00:00:00.000Z",
      timestamp_end: "2026-07-14T00:00:00.000Z",
      created_time: "2026-07-14T00:00:00.000Z",
      updated_time: "2026-07-14T00:00:00.000Z",
      metadata_json: JSON.stringify({
        source: "trace",
        credibility_score: 0.67,
        namespace: "workspace-b",
      }),
    };

    const vectorStore = {
      queryL1Records: () => [row],
    } as unknown as IMemoryStore;

    const records = await queryMemoryRecords(vectorStore);
    expect(records[0]).toMatchObject({
      source: "trace",
      credibility_score: 0.67,
      namespace: "workspace-b",
    });
  });
});


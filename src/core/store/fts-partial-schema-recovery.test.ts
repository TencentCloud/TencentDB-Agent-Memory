import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MemoryRecord } from "../record/l1-writer.js";
import type { L0Record } from "./types.js";
import {
  _resetJiebaForTest,
  _setJiebaForTest,
  buildFtsQuery,
  VectorStore,
} from "./sqlite.js";

const RECORDED_AT = "2026-08-02T00:00:00.000Z";

function makeL1Record(): MemoryRecord {
  return {
    id: "l1-healthy-index",
    content: "healthy l1 index",
    type: "persona",
    priority: 50,
    scene_name: "test",
    source_message_ids: [],
    metadata: {},
    timestamps: [RECORDED_AT],
    createdAt: RECORDED_AT,
    updatedAt: RECORDED_AT,
    sessionKey: "session-key",
    sessionId: "session-id",
  };
}

function makeL0Record(): L0Record {
  return {
    id: "l0-recovery-target",
    sessionKey: "session-key",
    sessionId: "session-id",
    role: "user",
    messageText: "recoverable l0 content",
    recordedAt: RECORDED_AT,
    timestamp: Date.parse(RECORDED_AT),
  };
}

function query(text: string): string {
  const result = buildFtsQuery(text);
  if (!result) throw new Error(`Expected an FTS query for ${text}`);
  return result;
}

describe("partial FTS schema recovery", () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "tdai-partial-fts-"));
    dbPath = join(testDir, "memory.db");
    _setJiebaForTest(null);
  });

  afterEach(async () => {
    _resetJiebaForTest();
    await rm(testDir, { recursive: true, force: true });
  });

  function seedStore(): void {
    const store = new VectorStore(dbPath, 0);
    try {
      store.init();
      expect(store.upsertL1(makeL1Record(), undefined)).toBe(true);
      expect(store.upsertL0(makeL0Record(), undefined)).toBe(true);
    } finally {
      store.close();
    }
  }

  function expectRecoveredStore(): void {
    const store = new VectorStore(dbPath, 0);
    try {
      store.init();

      expect(store.isFtsAvailable()).toBe(true);
      expect(store.searchL0Fts(query("recoverable")).map((row) => row.record_id)).toEqual([
        "l0-recovery-target",
      ]);
      expect(store.searchL1Fts(query("healthy")).map((row) => row.record_id)).toEqual([
        "l1-healthy-index",
      ]);
    } finally {
      store.close();
    }
  }

  it("recreates and repopulates a missing L0 FTS table", () => {
    seedStore();

    const db = new DatabaseSync(dbPath);
    db.exec("DROP TABLE l0_fts");
    db.close();

    expectRecoveredStore();
  });

  it("migrates an isolated legacy L0 FTS table without disabling FTS", () => {
    seedStore();

    const db = new DatabaseSync(dbPath);
    db.exec(`
      DROP TABLE l0_fts;
      CREATE VIRTUAL TABLE l0_fts USING fts5(
        message_text,
        record_id UNINDEXED,
        session_key UNINDEXED,
        session_id UNINDEXED,
        role UNINDEXED,
        recorded_at UNINDEXED,
        timestamp UNINDEXED
      )
    `);
    db.close();

    expectRecoveredStore();
  });
});

import { afterEach, describe, expect, it } from "vitest";
import type { MemoryRecord } from "../record/l1-writer.js";
import type { L0Record } from "./types.js";
import {
  _resetJiebaForTest,
  _setJiebaForTest,
  buildFtsQuery,
  VectorStore,
} from "./sqlite.js";

const EXPIRED_AT = "2024-01-01T00:00:00.000Z";
const FRESH_AT = "2026-01-01T00:00:00.000Z";
const CUTOFF = "2025-01-01T00:00:00.000Z";

let store: VectorStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
  _resetJiebaForTest();
});

function createStore(): VectorStore {
  const instance = new VectorStore(":memory:", 0);
  instance.init();
  _setJiebaForTest(null);
  store = instance;
  return instance;
}

function l1Record(index: number): MemoryRecord {
  const at = index === 0 ? EXPIRED_AT : FRESH_AT;
  return {
    id: `l1-${index}`,
    content: index === 0 ? "expiredl1token" : `freshl1token${index}`,
    type: "persona",
    priority: 50,
    scene_name: "test",
    source_message_ids: [],
    metadata: {},
    timestamps: [at],
    createdAt: at,
    updatedAt: at,
    sessionKey: "session",
    sessionId: "session-id",
  };
}

function l0Record(index: number): L0Record {
  const at = index === 0 ? EXPIRED_AT : FRESH_AT;
  return {
    id: `l0-${index}`,
    sessionKey: "session",
    sessionId: "session-id",
    role: "user",
    messageText: index === 0 ? "expiredl0token" : `freshl0token${index}`,
    recordedAt: at,
    timestamp: Date.parse(at),
  };
}

function query(text: string): string {
  const result = buildFtsQuery(text);
  if (!result) throw new Error(`Expected an FTS query for ${text}`);
  return result;
}

describe("TTL cleanup FTS synchronization", () => {
  it("removes expired L1 records from keyword search", () => {
    const db = createStore();
    for (let index = 0; index < 5; index++) {
      expect(db.upsertL1(l1Record(index), undefined)).toBe(true);
    }

    expect(db.searchL1Fts(query("expiredl1token"))).toHaveLength(1);
    expect(db.deleteL1Expired(CUTOFF)).toBe(1);

    expect(db.countL1()).toBe(4);
    expect(db.searchL1Fts(query("expiredl1token"))).toEqual([]);
    expect(db.searchL1Fts(query("freshl1token1")).map((row) => row.record_id)).toEqual([
      "l1-1",
    ]);
  });

  it("removes expired L0 records from keyword search", () => {
    const db = createStore();
    for (let index = 0; index < 5; index++) {
      expect(db.upsertL0(l0Record(index), undefined)).toBe(true);
    }

    expect(db.searchL0Fts(query("expiredl0token"))).toHaveLength(1);
    expect(db.deleteL0Expired(CUTOFF)).toBe(1);

    expect(db.countL0()).toBe(4);
    expect(db.searchL0Fts(query("expiredl0token"))).toEqual([]);
    expect(db.searchL0Fts(query("freshl0token1")).map((row) => row.record_id)).toEqual([
      "l0-1",
    ]);
  });
});

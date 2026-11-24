/**
 * Regression: TTL cleanup (`deleteL1Expired` / `deleteL0Expired`) must also
 * remove the expired rows' FTS5 entries. Keyword search reads `l1_fts` /
 * `l0_fts` directly, so leaving those rows behind keeps expired memories
 * (with their full original text) recallable after retention removed them.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { VectorStore, buildFtsQuery } from "./memory-store.js";
import type { MemoryRecord } from "../../record/l1-writer.js";
import type { L0Record } from "../types.js";

const OLD = "2020-01-01T00:00:00.000Z";
const NEW = "2099-01-01T00:00:00.000Z";
const CUTOFF = "2021-01-01T00:00:00.000Z";

function l1(id: string, content: string, updatedAt: string): MemoryRecord {
  return {
    id,
    content,
    type: "persona",
    priority: 50,
    scene_name: "",
    source_message_ids: [],
    metadata: {},
    timestamps: [updatedAt],
    createdAt: updatedAt,
    updatedAt,
    sessionKey: "sk",
    sessionId: "sid",
  } as MemoryRecord;
}

function l0(id: string, messageText: string, recordedAt: string): L0Record {
  return {
    id,
    sessionKey: "sk",
    sessionId: "sid",
    role: "user",
    messageText,
    recordedAt,
    timestamp: Date.parse(recordedAt),
  };
}

describe("SQLite TTL cleanup keeps FTS in sync", () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "tdai-ttl-fts-"));
    store = new VectorStore(path.join(dir, "vectors.db"), 4);
    store.init();
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("deleteL1Expired removes expired rows from l1_fts", () => {
    expect(store.isFtsAvailable()).toBe(true);
    store.upsertL1(l1("old-1", "User home address is Elmstreet twelve", OLD), undefined);
    for (let i = 0; i < 4; i++) {
      store.upsertL1(l1(`new-${i}`, `User likes Elmstreet bakery number ${i}`, NEW), undefined);
    }
    const q = buildFtsQuery("Elmstreet");
    expect(q).toBeTruthy();
    expect(store.searchL1Fts(q!, 10).map((r) => r.record_id)).toContain("old-1");

    expect(store.deleteL1Expired(CUTOFF)).toBe(1);

    const ids = store.searchL1Fts(q!, 10).map((r) => r.record_id);
    expect(ids).not.toContain("old-1");
    expect(ids.sort()).toEqual(["new-0", "new-1", "new-2", "new-3"]);
  });

  it("deleteL0Expired removes expired rows from l0_fts", () => {
    store.upsertL0(l0("old-l0", "my locker code is Quokka seven", OLD), undefined);
    for (let i = 0; i < 4; i++) {
      store.upsertL0(l0(`new-l0-${i}`, `Quokka photo number ${i}`, NEW), undefined);
    }
    const q = buildFtsQuery("Quokka");
    expect(q).toBeTruthy();
    expect(store.searchL0Fts(q!, 10).map((r) => r.record_id)).toContain("old-l0");

    expect(store.deleteL0Expired(CUTOFF)).toBe(1);

    const ids = store.searchL0Fts(q!, 10).map((r) => r.record_id);
    expect(ids).not.toContain("old-l0");
    expect(ids.sort()).toEqual(["new-l0-0", "new-l0-1", "new-l0-2", "new-l0-3"]);
  });

  it("leaves FTS untouched when the 80% safety guard blocks the delete", () => {
    for (let i = 0; i < 5; i++) {
      store.upsertL1(l1(`old-${i}`, `Elmstreet note ${i}`, OLD), undefined);
    }
    store.upsertL1(l1("new-0", "Elmstreet note fresh", NEW), undefined);
    const q = buildFtsQuery("Elmstreet")!;

    expect(store.deleteL1Expired(CUTOFF)).toBe(0);
    expect(store.searchL1Fts(q, 10)).toHaveLength(6);
  });
});

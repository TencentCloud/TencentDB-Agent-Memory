import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VectorStore } from "./memory-store.js";
import type { MemoryRecord } from "../../record/l1-writer.js";

function makeRecord(id: string): MemoryRecord {
  const timestamp = new Date().toISOString();
  return {
    id,
    content: "remember this",
    type: "persona",
    priority: 50,
    scene_name: "",
    source_message_ids: [],
    metadata: {},
    timestamps: [timestamp],
    createdAt: timestamp,
    updatedAt: timestamp,
    sessionKey: "session-1",
    sessionId: "session-1",
  };
}

describe("VectorStore.deleteL1", () => {
  let dbDir: string;
  let store: VectorStore;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), "memory-core-delete-"));
    store = new VectorStore(join(dbDir, "test.db"), 4);
    store.init();
  });

  afterEach(() => {
    try {
      store.close();
    } finally {
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  it("returns false for a missing record", () => {
    expect(store.deleteL1("missing")).toBe(false);
  });

  it("keeps the default non-throwing behavior for storage failures", () => {
    store.close();
    expect(store.deleteL1("missing")).toBe(false);
  });

  it("rethrows storage failures when requested by the gateway", () => {
    store.close();
    expect(() => store.deleteL1("missing", undefined, { throwOnError: true })).toThrow();
  });

  it("returns true when a record is deleted", () => {
    expect(store.upsertL1(makeRecord("memory-1"), undefined)).toBe(true);
    expect(store.deleteL1("memory-1")).toBe(true);
  });
});

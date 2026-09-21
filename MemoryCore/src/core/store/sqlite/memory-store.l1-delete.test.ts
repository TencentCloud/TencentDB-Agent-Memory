/**
 * Store-level tests for deleteL1's throwOnError contract (#1434).
 *
 * deleteL1 historically returned `false` for BOTH "record not found" and
 * "the store failed" (degraded mode, DB errors). The gateway delete endpoint
 * counts that boolean into `deleted_count` and answers 200 — a swallowed
 * failure was indistinguishable from a genuine miss. With
 * `opts.throwOnError` the failure must reject instead.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VectorStore } from "./memory-store.js";
import type { MemoryRecord } from "../../types.js";

function makeRecord(id: string): MemoryRecord {
  const ts = new Date().toISOString();
  return {
    id,
    content: "remember this",
    type: "persona",
    priority: 50,
    scene_name: "",
    source_message_ids: [],
    metadata: {},
    timestamps: [ts],
    createdAt: ts,
    updatedAt: ts,
    sessionKey: "s1",
    sessionId: "s1",
  } as unknown as MemoryRecord;
}

describe("VectorStore.deleteL1 — throwOnError contract", () => {
  let dbDir: string;
  let store: VectorStore;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), "l1-delete-throwonerror-"));
    store = new VectorStore(join(dbDir, "test.db"), 4);
    store.init(); // build schema so upsert/delete operate on real tables
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      // already closed by the test
    }
    rmSync(dbDir, { recursive: true, force: true });
  });

  it("returns false for a missing record (genuine not-found, unchanged)", async () => {
    expect(store.deleteL1("no-such-id")).toBe(false);
  });

  it("returns true for an existing record", async () => {
    store.upsertL1(makeRecord("rec-1"), undefined);
    expect(store.deleteL1("rec-1")).toBe(true);
    expect(store.deleteL1("rec-1")).toBe(false); // gone now
  });

  it("returns false by default when the store fails (non-fatal contract preserved)", () => {
    store.close(); // force a failure: deletes against a closed DB throw
    expect(store.deleteL1("rec-1")).toBe(false);
  });

  it("rethrows the failure when throwOnError is set (delete endpoint path)", () => {
    store.close();
    expect(() => store.deleteL1("rec-1", undefined, { throwOnError: true })).toThrow();
  });
});

/**
 * Store-level tests for queryL0GroupedBySessionId's throwOnError contract.
 *
 * The sqlite store swallows query failures into `[]` so most callers stay
 * non-fatal. The L1 dedup guard (countPendingL0Rows) acts on a "zero rows"
 * verdict — if a store failure were read as empty there, the timer-fired L1
 * would be skipped and the backlog stranded. So the store must rethrow when
 * the caller opts in.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VectorStore } from "./memory-store.js";

describe("VectorStore.queryL0GroupedBySessionId — throwOnError contract", () => {
  let dbDir: string;
  let store: VectorStore;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), "l0-query-throwonerror-"));
    store = new VectorStore(join(dbDir, "test.db"), 4);
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      // already closed by the test
    }
    rmSync(dbDir, { recursive: true, force: true });
  });

  it("returns [] by default when the query fails (non-fatal contract preserved)", () => {
    store.close(); // force a failure: queries against a closed DB throw
    expect(store.queryL0GroupedBySessionId("s1", undefined, 10)).toEqual([]);
  });

  it("rethrows the failure when throwOnError is set (guard path)", () => {
    store.close();
    expect(() => store.queryL0GroupedBySessionId("s1", undefined, 10, { throwOnError: true })).toThrow();
  });
});

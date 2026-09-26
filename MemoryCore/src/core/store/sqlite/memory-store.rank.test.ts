// Regression: a truncated per-token scan must not be treated as "not matching".
//
// Reported on PR #1506 (kvnloo, 2026-09-25): with TOKEN_SCAN_LIMIT=200, a document
// that matches *two* very common tokens can rank 4th in the combined OR search yet
// fall outside the top-200 of each individual token scan. The per-token sets are then
// missing its id, coverage computes to 0, and the coverage gate drops a
// high-ranked hit entirely.
//
// Fixture mirrors that shape: 250 short "alpha" docs + 250 short "beta" docs, three
// short two-token docs (they activate the gate), and one LONG two-token target — BM25
// length normalisation pushes the target to the bottom of each single-token scan.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "./memory-store.js";
import { buildFtsQuery } from "../tokenize.js";
import type { MemoryRecord } from "../types.js";

let dir: string;
let store: VectorStore;

function mem(id: string, content: string): MemoryRecord {
  return {
    id,
    content,
    type: "episodic",
    priority: 70,
    scene_name: "scan-truncation",
    source_message_ids: [],
    metadata: {},
    timestamps: [],
    createdAt: new Date(1_700_000_000_000).toISOString(),
    updatedAt: new Date(1_700_000_000_000).toISOString(),
    version: 0,
    sessionKey: "scan-truncation",
    sessionId: "default",
    userId: "default",
    agentId: "default",
  } as unknown as MemoryRecord;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tdai-scan-trunc-"));
  store = new VectorStore(join(dir, "vectors.db"), 4);
  store.init();
});
afterEach(() => {
  try {
    store.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe("per-token scan truncation (#1506 review)", () => {
  it("keeps a two-token document that falls outside every truncated single-token scan", () => {
    for (let i = 0; i < 250; i++) store.upsertL1(mem(`a${i}`, "alpha"), undefined);
    for (let i = 0; i < 250; i++) store.upsertL1(mem(`b${i}`, "beta"), undefined);
    // three short two-token docs → these are the "strong" hits that activate the gate
    store.upsertL1(mem("strong1", "alpha beta gamma"), undefined);
    store.upsertL1(mem("strong2", "alpha beta delta"), undefined);
    store.upsertL1(mem("strong3", "alpha beta epsilon"), undefined);
    // The target: its repeated term occurrences lift it to ~4th in the combined OR
    // search, while its extra length pushes it past the 200 short single-token docs
    // in each per-term scan. Verified positions with a probe over this fixture:
    // combined rank = 4, absent from both 200-row per-term scans.
    store.upsertL1(mem("target", `alpha alpha alpha beta beta beta ${"padding ".repeat(4)}`), undefined);

    const hits = store.searchL1Fts(buildFtsQuery("alpha beta")!, 5);
    const ids = hits.map((h) => h.record_id);

    // Sanity: this document is a genuine top hit of the OR query.
    expect(ids.length).toBeGreaterThan(0);
    expect(ids, "truncated per-token scans must not drop a genuine OR-search hit").toContain("target");
  });

  it("still ranks by coverage when no per-token scan is truncated", () => {
    for (let i = 0; i < 10; i++) store.upsertL1(mem(`c${i}`, "common"), undefined);
    store.upsertL1(mem("wide", "common rare token"), undefined);
    store.upsertL1(mem("narrow", "common"), undefined);
    const ids = store
      .searchL1Fts(buildFtsQuery("common rare token")!, 5)
      .map((h) => h.record_id);
    expect(ids[0]).toBe("wide");
    expect(ids).not.toContain("narrow");
  });
});

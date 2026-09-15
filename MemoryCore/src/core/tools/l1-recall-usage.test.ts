/**
 * Usage write-back + recency/frequency boost self-check.
 *
 * Covers: FTS-only VectorStore (dimensions=0) → search returns usage fields,
 * explicit selected-memory feedback bumps use_count/last_used_ms, and the usage boost can
 * outrank a newer-but-never-used memory. Also covers the ALTER-TABLE backfill
 * for DBs created before the use_count/last_used_ms columns existed.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { VectorStore } from "../store/sqlite/memory-store.js";
import { recallL1Candidates } from "./l1-candidate-recall.js";
import { executeMemorySearch, formatSearchResponse, recordMemoryUsage } from "./memory-search.js";
import type { MemoryRecord } from "../record/l1-writer.js";

const dir = mkdtempSync(join(tmpdir(), "tdai-usage-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const DAY = 86_400_000;

function makeRecord(id: string, content: string, ageMs: number): MemoryRecord {
  const ts = new Date(Date.now() - ageMs).toISOString();
  return {
    id,
    content,
    type: "persona",
    priority: 50,
    scene_name: "",
    source_message_ids: [],
    metadata: {},
    timestamps: [ts],
    createdAt: ts,
    updatedAt: ts,
    sessionKey: "sk-test",
    sessionId: "sid-test",
    teamId: "t",
    userId: "u",
    agentId: "a",
  };
}

describe("L1 usage write-back and recency/frequency boost", () => {
  it("only selected memories receive usage write-back and boost reorders", async () => {
    const store = new VectorStore(join(dir, "usage.db"), 0);
    store.init();
    // Equal relevance: use history, not write time, must decide the re-rank.
    store.upsertL1(makeRecord("cold", "billing service deployment notes", DAY), undefined);
    store.upsertL1(makeRecord("hot", "billing service deployment notes", 30 * DAY), undefined);

    const dedupCandidates = await recallL1Candidates({ query: "billing service", topK: 5, vectorStore: store, bypassUsageBoost: true });
    expect(dedupCandidates.hits.map((r) => r.record_id)).toEqual(["cold", "hot"]);

    // Fresh records have no usage data → boost = 1.0, pure similarity order.
    const r1 = await executeMemorySearch({ query: "billing service", limit: 5, vectorStore: store });
    expect(r1.strategy).toBe("fts");
    expect(r1.results.map((r) => r.id)).toEqual(["cold", "hot"]);
    expect(r1.results[0].use_count).toBe(0);
    expect(formatSearchResponse(r1)).toContain("[id: cold]");

    // Search alone is neutral; only an explicit selection counts as use.
    const r2 = await executeMemorySearch({ query: "billing service", limit: 5, vectorStore: store });
    const byId = new Map(r2.results.map((r) => [r.id, r]));
    expect(byId.get("hot")!.use_count).toBe(0);
    expect(byId.get("cold")!.use_count).toBe(0);

    // Simulate the agent selecting "hot" repeatedly → usage boost wins the tie.
    for (let i = 0; i < 10; i++) expect(await recordMemoryUsage(store, ["hot"])).toBe(1);
    const r3 = await executeMemorySearch({ query: "billing service", limit: 5, vectorStore: store });
    expect(r3.results.map((r) => r.id)).toEqual(["hot", "cold"]);
    expect(r3.results[0].use_count).toBe(10);
    expect(r3.results[1].use_count).toBe(0);
    store.close();
  });

  it("touchL1Usage with unknown ids returns 0 and never throws", () => {
    const store = new VectorStore(join(dir, "touch.db"), 0);
    store.init();
    expect(store.touchL1Usage([])).toBe(0);
    expect(store.touchL1Usage(["nope"])).toBe(0);
    store.close();
  });

  it("pre-existing DB without usage columns is migrated on init", () => {
    const dbPath = join(dir, "legacy.db");
    // Old-schema l1_records: every column a pre-usage deployment had, minus
    // the two new usage columns (as the ALTER-TABLE migration would see it).
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`CREATE TABLE l1_records (
      record_id TEXT PRIMARY KEY, content TEXT NOT NULL, type TEXT DEFAULT '',
      priority INTEGER DEFAULT 50, scene_name TEXT DEFAULT '', session_key TEXT DEFAULT '',
      session_id TEXT DEFAULT 'default', team_id TEXT DEFAULT 'default',
      task_id TEXT DEFAULT '', user_id TEXT NOT NULL DEFAULT 'default',
      agent_id TEXT NOT NULL DEFAULT 'default', version INTEGER NOT NULL DEFAULT 0,
      timestamp_str TEXT DEFAULT '', timestamp_start TEXT DEFAULT '',
      timestamp_end TEXT DEFAULT '', created_time TEXT DEFAULT '',
      updated_time TEXT DEFAULT '', metadata_json TEXT DEFAULT '{}'
    )`);
    legacy.prepare(
      "INSERT INTO l1_records (record_id, content, updated_time) VALUES (?, ?, ?)",
    ).run("legacy-1", "legacy billing note", new Date().toISOString());
    legacy.close();

    const store = new VectorStore(dbPath, 0);
    expect(() => store.init()).not.toThrow();
    expect(store.touchL1Usage(["legacy-1"])).toBe(1);
    store.close();
  });
});

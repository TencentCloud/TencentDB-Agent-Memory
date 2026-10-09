/**
 * Regression tests for sqlite `VectorStore.queryL1Records({ recordIds })`.
 *
 * The sqlite backend used to ignore `filter.recordIds` entirely and fall back
 * to the widest query shape (a full table scan). Callers that read a single
 * record by primary key took `rows[0]` from that scan, so any other agent's
 * row could be returned — `/v3/atomic/update` then answered
 * `403 Atomic note ... belongs to a different agent`, and the L1 writer's
 * reinforcement pass operated on the wrong records.
 *
 * The tcvdb (`documentIds`) and mongodb (`_id: { $in }`) backends have always
 * honoured `recordIds`; these tests pin the sqlite path to the same contract.
 *
 * Fixes #1027.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "./memory-store.js";
import type { MemoryRecord } from "../../record/l1-writer.js";

/** dimensions = 0 → metadata + FTS only, no sqlite-vec needed. */
const DIMENSIONS = 0;

function makeL1(id: string, content: string, over: Partial<MemoryRecord> = {}): MemoryRecord {
  const ts = new Date().toISOString();
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
    sessionKey: "sk-regression",
    sessionId: "sid-regression",
    ...over,
  };
}

describe("VectorStore.queryL1Records — recordIds primary-key lookup (sqlite)", () => {
  let dir: string;
  let store: VectorStore;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tdai-sqlite-record-ids-"));
    store = new VectorStore(join(dir, "memory.db"), DIMENSIONS);
    store.init();

    // Two records owned by two different agents in the same team. Scanning the
    // table would surface both; a correct primary-key lookup surfaces one.
    // `undefined` embedding → metadata + FTS only, no vector table required.
    const wroteA = store.upsertL1(makeL1("l1-agent-a", "Agent A prefers dark mode", {
      teamId: "team-1",
      userId: "user-1",
      agentId: "agent-a",
    }), undefined);
    const wroteB = store.upsertL1(makeL1("l1-agent-b", "Agent B writes TypeScript", {
      teamId: "team-1",
      userId: "user-2",
      agentId: "agent-b",
    }), undefined);
    expect([wroteA, wroteB, store.isDegraded()]).toEqual([true, true, false]);
  });

  afterAll(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns only the requested record", () => {
    const rows = store.queryL1Records({ recordIds: ["l1-agent-b"] });
    expect(rows.map((r) => r.record_id)).toEqual(["l1-agent-b"]);
    expect(rows[0].content).toBe("Agent B writes TypeScript");
  });

  it("returns every record when several ids are requested, and only those", () => {
    const rows = store.queryL1Records({ recordIds: ["l1-agent-a", "l1-agent-b", "l1-missing"] });
    expect(rows.map((r) => r.record_id).sort()).toEqual(["l1-agent-a", "l1-agent-b"]);
  });

  it("returns nothing for an unknown id instead of another record", () => {
    expect(store.queryL1Records({ recordIds: ["l1-nope"] })).toEqual([]);
  });

  it("combines recordIds with isolation filters", () => {
    // Correct id but the wrong agent → the isolation predicate must still apply.
    expect(store.queryL1Records({ recordIds: ["l1-agent-a"], agentId: "agent-b" })).toEqual([]);
    expect(store.queryL1Records({ recordIds: ["l1-agent-a"], agentId: "agent-a" })).toHaveLength(1);
  });

  it("takes primary-key priority over wider predicates in the same filter", () => {
    // sessionKey/sessionId describe neither record; a query that ignores
    // recordIds would return both, one that honours it returns only one.
    const rows = store.queryL1Records({
      recordIds: ["l1-agent-b"],
      sessionKey: "sk-regression",
      sessionId: "sid-regression",
    });
    expect(rows.map((r) => r.record_id)).toEqual(["l1-agent-b"]);
  });
});

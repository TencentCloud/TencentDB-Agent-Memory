/**
 * Cross-backend conformance for the ledger row codec: the same MemoryEvent
 * appended to each backend must read back as the same decoded event. Covers
 * every optional field the review/revert paths depend on (supersedes,
 * origin_*, snapshot_json, reviewer_id, target_event_id, scope, until, layer,
 * source, task_id) and an empty (userless) isolation id.
 *
 * Backends: SQLite (real, node:sqlite) and TCVDB (store code over an
 * in-memory document stub — exercises encode/decode, not server filtering).
 * MongoDB is not covered here: its codec needs a live server
 * (mongodb-memory-server would download a mongod binary in CI).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemoryEvent } from "./types.js";
import { TcvdbMemoryStore } from "./tcvdb/memory-store.js";
import { VectorStore } from "./sqlite/memory-store.js";
import { reviewEventId } from "./review.js";

const id = (c: string) => `evt-${c.repeat(32)}`;
const TS = "2026-03-01T10:00:00.000Z";

/** Representative rows: one per shape the writers actually produce. */
const FIXTURES: MemoryEvent[] = [
  {
    event_id: id("6"), event_ts: TS, session_key: "sk", session_id: "ses", team_id: "t1", user_id: "u1", agent_id: "a1",
    op: "restored", record_id: "m_root", content: "", reason: "checked", source: "review", layer: "l1", version: 0,
    review: { protocol: 2, operation_id: `rop-${"a".repeat(64)}`, request_hash: "b".repeat(64), previous_status: "quarantined", observed: [id("7")] },
  },
  {
    event_id: id("8"), event_ts: TS, session_key: "sk", session_id: "ses", team_id: "t1", user_id: "u1", agent_id: "a1",
    op: "created", record_id: "m_child", content: "new", source: "extraction", layer: "l1", version: 0,
    review: { protocol: 2, sources: ["m_root"], guard_at: TS },
  },
  { // extraction write replacing two records
    event_id: id("1"), event_ts: TS, session_key: "sk", session_id: "ses",
    team_id: "t1", user_id: "u1", agent_id: "a1", task_id: "task-9",
    op: "merged", record_id: "m_new", content: "merged text", memory_type: "fact", version: 3,
    supersedes: ["m_a", "m_b"], layer: "l1", source: "extraction",
  },
  { // superseded partner with origin session and pre-image
    event_id: id("2"), event_ts: TS, session_key: "sk", session_id: "ses",
    origin_session_id: "ses-old", origin_session_key: "sk-old",
    team_id: "t1", user_id: "u1", agent_id: "a1",
    op: "superseded", record_id: "m_a", content: "old text", version: 1,
    superseded_by: "m_new", snapshot_json: JSON.stringify({ record_id: "m_a", content: "old text" }),
    layer: "l1", source: "extraction",
  },
  { // review revert pointing at the exact write
    event_id: id("3"), event_ts: TS, session_key: "sk", session_id: "ses",
    team_id: "t1", user_id: "u1", agent_id: "a1",
    op: "reverted", record_id: "m_new", content: "", version: 0,
    supersedes: ["m_a"], reviewer_id: "reviewer-1", reason: "wrong", target_event_id: id("1"),
    layer: "l1", source: "review", review: { protocol: 2, operation_id: `rop-${"c".repeat(64)}`, request_hash: "d".repeat(64), missing: [] },
  },
  { // userless agent-scope management clear
    event_id: id("4"), event_ts: TS, session_key: "", session_id: "",
    team_id: "t1", user_id: "", agent_id: "a1",
    op: "deleted", record_id: "chat_memory-t1-a1", content: "", version: 0,
    scope: "agent", until: TS, layer: "l3", source: "api_mutation", request_id: "req-1",
  },
  { // L2 management update: operation fact only
    event_id: id("5"), event_ts: TS, session_key: "", session_id: "",
    team_id: "t1", user_id: "u1", agent_id: "a1",
    op: "updated", record_id: "blocks/scene.md", content: "", version: 2,
    layer: "l2", source: "api_mutation", request_id: "req-2",
  },
];

/** Fields whose absence and empty value are equivalent on the wire. */
function normalize(e: MemoryEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) {
    if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return out;
}

function makeTcvdb(): TcvdbMemoryStore {
  const docs = new Map<string, Record<string, unknown>>();
  const store = new TcvdbMemoryStore({
    url: "http://stub", username: "u", apiKey: "k", database: "db", embeddingModel: "m", timeout: 5000,
  });
  (store as unknown as { client: unknown }).client = {
    upsert: async (_c: string, batch: Array<Record<string, unknown>>) => { for (const d of batch) docs.set(String(d.id), d); },
    count: async (_c: string, filter?: string) => {
      const m = filter ? /record_id = "([^"]*)"/.exec(filter) : null;
      return [...docs.values()].filter((d) => !m || d.record_id === m[1]).length;
    },
    query: async (_c: string, p: Record<string, unknown>) => {
      const ids = p.documentIds as string[] | undefined;
      const all = ids ? ids.flatMap((i) => (docs.has(i) ? [docs.get(i)!] : [])) : [...docs.values()];
      // Emulate the one filter this test relies on: record_id equality.
      const m = typeof p.filter === "string" ? /record_id = "([^"]*)"/.exec(p.filter) : null;
      return { documents: m ? all.filter((d) => d.record_id === m[1]) : all };
    },
  };
  return store;
}

describe("memory_events codec conformance (sqlite ↔ tcvdb)", () => {
  let dir: string;
  let sqlite: VectorStore;
  let tcvdb: TcvdbMemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mem-conf-"));
    sqlite = new VectorStore(path.join(dir, "vectors.db"), 0);
    sqlite.init();
    tcvdb = makeTcvdb();
  });
  afterEach(() => {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("invalid review metadata is rejected before commit on both durable implementations", async () => {
    const event: MemoryEvent = { ...FIXTURES[0]!, review: { protocol: 2, observed: Array.from({ length: 50_001 }, () => "token") } };
    expect(() => sqlite.appendMemoryEvent(event)).toThrow("Invalid review protocol payload");
    await expect(tcvdb.appendMemoryEvent(event)).rejects.toThrow("Invalid review protocol payload");
    expect(sqlite.queryMemoryEvents({})).toEqual([]);
    expect(await tcvdb.queryMemoryEvents({})).toEqual([]);
  });

  for (const fixture of FIXTURES) {
    const fx = fixture.source === "review" ? { ...fixture, event_id: reviewEventId(fixture) } : fixture;
    it(`${fx.op}/${fx.layer}/${fx.source} ${fx.source === "review" ? "round-trips in SQLite and rejects native TCVDB writes" : "round-trips identically"}`, async () => {
      await sqlite.appendMemoryEvent(fx);
      if (fx.source === "review") {
        await expect(tcvdb.appendMemoryEvent(fx)).rejects.toThrow("shared atomic ledger");
        expect(normalize(sqlite.queryMemoryEvents({ record_id: fx.record_id })[0]!)).toEqual(normalize(fx));
        return;
      }
      await tcvdb.appendMemoryEvent(fx);
      const [a] = await sqlite.queryMemoryEvents({ record_id: fx.record_id });
      const [b] = await tcvdb.queryMemoryEvents({ record_id: fx.record_id });
      expect(a, "sqlite").toBeDefined();
      expect(b, "tcvdb").toBeDefined();
      expect(normalize(b!)).toEqual(normalize(a!));
      // And both preserve exactly what the writer said (store layer is
      // mechanics only; '' → "default" healing happens in appendLedgerEvent).
      expect(normalize(a!)).toEqual(normalize(fx));
    });
  }
});

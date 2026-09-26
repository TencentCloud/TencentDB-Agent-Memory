/**
 * TCVDB memory_events 在降级（init 失败）时必须拒绝写入，
 * 让账本 wrapper 保留 pending，直到真正写入成功。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendLedgerEvent, getLedgerHealth, replayLedgerEvents } from "../../record/event-ledger.js";
import { StorageAdapter } from "../../storage/adapter.js";
import { createLocalStorageBackend } from "../../storage/factory.js";
import type { MemoryEvent } from "../types.js";
import { TcvdbMemoryStore } from "./memory-store.js";

const silent = { warn() {}, debug() {}, info() {}, error() {} };

const ev = (over: Partial<MemoryEvent> = {}): MemoryEvent => ({
  event_ts: "2026-03-01T10:00:00.000Z", session_key: "sk", session_id: "ses",
  team_id: "t1", agent_id: "a1", op: "created", record_id: "m_x", content: "v1", ...over,
});

describe("tcvdb memory_events when degraded", () => {
  let dir: string;
  let storage: StorageAdapter;
  let store: TcvdbMemoryStore;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "tcvdb-ledger-"));
    storage = new StorageAdapter(createLocalStorageBackend(path.join(dir, "data")));
    store = new TcvdbMemoryStore({
      url: "http://127.0.0.1:1", username: "root", apiKey: "k", database: "db",
      embeddingModel: "none", timeout: 500, logger: silent,
    });
    await store.init();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports an L1 upsert as failed instead of acknowledging a write that never landed", async () => {
    const ts = "2026-03-01T10:00:00.000Z";
    const ok = await store.upsertL1({
      id: "m_x", content: "v2", type: "persona", priority: 50, scene_name: "",
      source_message_ids: [], metadata: {}, timestamps: [ts], createdAt: ts, updatedAt: ts,
      sessionKey: "sk", sessionId: "ses",
    });
    expect(ok).toBe(false);
  });

  it("rejects appends so a failed write and a replay both keep the event pending", async () => {
    await expect(store.appendMemoryEvent(ev({ event_id: "evt-direct" }))).rejects.toThrow(/degraded/);

    const r = await appendLedgerEvent({ store, storage, event: ev(), logger: silent });
    expect(r).toMatchObject({ jsonl: true, store: false });
    const scope = { team_id: "t1", agent_id: "a1" };
    expect(getLedgerHealth(store, scope)).toMatchObject({ degraded: true, pending_store_events: 1 });

    const replay = await replayLedgerEvents({ store, storage, logger: silent });
    expect(replay).toMatchObject({ replayed: 0, failed: 1 });
    expect(getLedgerHealth(store, scope)).toMatchObject({ degraded: true, pending_store_events: 1 });
  });

  it("rejects queries instead of reporting an empty ledger", async () => {
    await expect(store.queryMemoryEvents({ record_id: "m_x" })).rejects.toThrow(/degraded/);
  });
});

describe("tcvdb L1 delete honours the isolation filter", () => {
  /**
   * In-memory /document/delete model: documentIds narrows the candidate set,
   * the filter expression is ANDed on top (server semantics). A stub that
   * ignores the filter would pass a filter-blind implementation — this one
   * actually evaluates `field = "v"` conditions.
   */
  function makeStore() {
    const docs = new Map<string, Record<string, unknown>>([
      ["m_t1", { id: "m_t1", team_id: "t1", agent_id: "a1", user_id: "u1" }],
      ["m_t2", { id: "m_t2", team_id: "t2", agent_id: "a1", user_id: "u1" }],
    ]);
    const calls: Array<{ documentIds?: string[]; filter?: string }> = [];
    const stubClient = {
      deleteDoc: async (_collection: string, params: { query?: { documentIds?: string[]; filter?: string } }) => {
        const q = params.query ?? {};
        calls.push(q);
        const conds = (q.filter ?? "").split(" and ").filter(Boolean).map((c) => /^(\w+) = "(.*)"$/.exec(c));
        let affected = 0;
        for (const id of q.documentIds ?? []) {
          const doc = docs.get(id);
          if (!doc) continue;
          if (conds.every((m) => m && String(doc[m[1]!]) === m[2])) { docs.delete(id); affected += 1; }
        }
        return affected;
      },
    };
    const store = new TcvdbMemoryStore({
      url: "http://stub", username: "u", apiKey: "k", database: "db",
      embeddingModel: "none", timeout: 1000, logger: silent,
    });
    (store as unknown as { client: unknown }).client = stubClient;
    return { store, docs, calls };
  }

  it("deleteL1 cannot remove another tenant's row", async () => {
    const { store, docs, calls } = makeStore();
    expect(await store.deleteL1("m_t2", { teamId: "t1" })).toBe(false);
    expect(docs.has("m_t2")).toBe(true);
    expect(calls[0]!.filter).toContain('team_id = "t1"');
    expect(await store.deleteL1("m_t2", { teamId: "t2" })).toBe(true);
    expect(docs.has("m_t2")).toBe(false);
  });

  it("deleteL1Batch applies the same filter to every id", async () => {
    const { store, docs, calls } = makeStore();
    expect(await store.deleteL1Batch(["m_t1", "m_t2"], { teamId: "t2", agentId: "a1" })).toBe(true);
    expect(docs.has("m_t1")).toBe(true);
    expect(docs.has("m_t2")).toBe(false);
    expect(calls[0]!.filter).toContain('team_id = "t2"');
  });
});

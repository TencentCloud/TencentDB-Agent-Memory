/**
 * memory_events 表（session 变更集）存储层测试。
 *
 * 覆盖：
 *  - appendMemoryEvent / queryMemoryEvents round-trip
 *  - session_id / op / origin_session_id / 时间窗 / 租户维度过滤
 *  - seq 追加顺序、limit/offset 分页
 *  - 追加-only 语义：同 record_id 可多次出现（superseded + created 历史共存）
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { L0Record, MemoryEvent } from "../types.js";
import type { MemoryRecord } from "../../record/l1-writer.js";
import { TcvdbMemoryStore } from "../tcvdb/memory-store.js";
import { VectorStore } from "./memory-store.js";

function makeEvent(over: Partial<MemoryEvent>): MemoryEvent {
  return {
    event_ts: "2026-01-01T00:00:00.000Z",
    session_key: "sk-a",
    session_id: "ses-a",
    team_id: "t1",
    user_id: "u1",
    agent_id: "a1",
    op: "created",
    record_id: "m_1",
    content: "content",
    ...over,
  };
}

describe("memory_events", () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mem-events-"));
    // dimensions=0 → metadata/FTS-only mode, no sqlite-vec extension needed.
    store = new VectorStore(path.join(dir, "vectors.db"), 0);
    store.init();
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends a created event and reads it back", () => {
    store.appendMemoryEvent(makeEvent({}));
    const rows = store.queryMemoryEvents({ session_id: "ses-a" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      op: "created",
      record_id: "m_1",
      content: "content",
      session_id: "ses-a",
      session_key: "sk-a",
      team_id: "t1",
      user_id: "u1",
      agent_id: "a1",
    });
  });

  it("persists superseded snapshots with origin session metadata", () => {
    // ses-a writes a record, then ses-b supersedes it.
    store.appendMemoryEvent(makeEvent({ record_id: "m_old", content: "salary 5000" }));
    store.appendMemoryEvent(
      makeEvent({
        session_id: "ses-b",
        session_key: "sk-b",
        op: "superseded",
        record_id: "m_old",
        content: "salary 5000",
        version: 1,
        origin_session_id: "ses-a",
        origin_session_key: "sk-a",
        superseded_by: "m_new",
      }),
    );
    store.appendMemoryEvent(
      makeEvent({
        session_id: "ses-b",
        session_key: "sk-b",
        op: "updated",
        record_id: "m_new",
        content: "salary 6000",
        version: 2,
        supersedes: ["m_old"],
      }),
    );

    // Forward view: what did ses-b change?
    const sesB = store.queryMemoryEvents({ session_id: "ses-b" });
    expect(sesB.map((r) => r.op)).toEqual(["superseded", "updated"]);
    expect(sesB[0].superseded_by).toBe("m_new");
    expect(sesB[0].origin_session_id).toBe("ses-a");
    expect(sesB[0].origin_session_key).toBe("sk-a");
    expect(sesB[1].supersedes).toEqual(["m_old"]);

    // Reverse view: which of ses-a's records got replaced?
    const supersededFromSesA = store.queryMemoryEvents({ origin_session_id: "ses-a" });
    expect(supersededFromSesA).toHaveLength(1);
    expect(supersededFromSesA[0].session_id).toBe("ses-b");
  });

  it("filters by op", () => {
    store.appendMemoryEvent(makeEvent({ record_id: "m_1" }));
    store.appendMemoryEvent(makeEvent({ op: "superseded", record_id: "m_1", superseded_by: "m_2" }));
    store.appendMemoryEvent(makeEvent({ op: "updated", record_id: "m_2", supersedes: ["m_1"] }));

    const created = store.queryMemoryEvents({ session_id: "ses-a", op: "created" });
    expect(created).toHaveLength(1);
    expect(created[0].record_id).toBe("m_1");

    const superseded = store.queryMemoryEvents({ session_id: "ses-a", op: "superseded" });
    expect(superseded).toHaveLength(1);
  });

  it("filters by time window (ISO 8601 string order)", () => {
    store.appendMemoryEvent(makeEvent({ record_id: "m_1", event_ts: "2026-01-01T10:00:00.000Z" }));
    store.appendMemoryEvent(makeEvent({ record_id: "m_2", event_ts: "2026-01-02T10:00:00.000Z" }));
    store.appendMemoryEvent(makeEvent({ record_id: "m_3", event_ts: "2026-01-03T10:00:00.000Z" }));

    const rows = store.queryMemoryEvents({
      session_id: "ses-a",
      since: "2026-01-02T00:00:00.000Z",
      until: "2026-01-02T23:59:59.999Z",
    });
    expect(rows.map((r) => r.record_id)).toEqual(["m_2"]);
  });

  it("filters by tenancy isolation dimensions", () => {
    store.appendMemoryEvent(makeEvent({ record_id: "m_mine" }));
    store.appendMemoryEvent(
      makeEvent({ record_id: "m_other", team_id: "t2", user_id: "u2", agent_id: "a2" }),
    );

    const mine = store.queryMemoryEvents({ session_id: "ses-a", team_id: "t1", user_id: "u1", agent_id: "a1" });
    expect(mine.map((r) => r.record_id)).toEqual(["m_mine"]);
  });

  it("preserves insertion order and paginates", () => {
    for (let i = 0; i < 5; i++) {
      store.appendMemoryEvent(makeEvent({ record_id: `m_${i}` }));
    }
    const page1 = store.queryMemoryEvents({ session_id: "ses-a", limit: 2, offset: 0 });
    const page2 = store.queryMemoryEvents({ session_id: "ses-a", limit: 2, offset: 2 });
    expect(page1.map((r) => r.record_id)).toEqual(["m_0", "m_1"]);
    expect(page2.map((r) => r.record_id)).toEqual(["m_2", "m_3"]);
  });

  it("keeps superseded rows after the record is replaced (append-only)", () => {
    // Same record_id appears twice across its lifetime — nothing is overwritten.
    store.appendMemoryEvent(makeEvent({ record_id: "m_x", content: "v1" }));
    store.appendMemoryEvent(
      makeEvent({ op: "superseded", record_id: "m_x", content: "v1", superseded_by: "m_y" }),
    );
    const rows = store.queryMemoryEvents({ record_id: "m_x" });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.op)).toEqual(["created", "superseded"]);
  });

  it("round-trips reviewer_id on reverted events", () => {
    store.appendMemoryEvent(
      makeEvent({ op: "reverted", record_id: "m_1", reviewer_id: "u-reviewer", supersedes: ["m_old"] }),
    );
    const rows = store.queryMemoryEvents({ record_id: "m_1", op: "reverted" });
    expect(rows).toHaveLength(1);
    expect(rows[0].reviewer_id).toBe("u-reviewer");
    expect(rows[0].supersedes).toEqual(["m_old"]);
  });

  it("leaves reviewer_id undefined for events that predate the column", () => {
    store.appendMemoryEvent(makeEvent({ record_id: "m_1" }));
    const rows = store.queryMemoryEvents({ record_id: "m_1" });
    expect(rows[0].reviewer_id).toBeUndefined();
  });
});

describe("memory_events migration", () => {
  it("backfills reviewer_id onto a pre-existing table", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mem-events-mig-"));
    try {
      const dbPath = path.join(dir, "vectors.db");
      // Simulate an install from before the reviewer_id column existed.
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbPath);
      db.exec(`CREATE TABLE memory_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, event_ts TEXT NOT NULL,
        session_key TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL DEFAULT '',
        origin_session_id TEXT NOT NULL DEFAULT '', origin_session_key TEXT NOT NULL DEFAULT '',
        team_id TEXT NOT NULL DEFAULT '', user_id TEXT NOT NULL DEFAULT '',
        agent_id TEXT NOT NULL DEFAULT '', task_id TEXT NOT NULL DEFAULT '',
        op TEXT NOT NULL, record_id TEXT NOT NULL, content TEXT NOT NULL,
        memory_type TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 0,
        supersedes TEXT NOT NULL DEFAULT '[]', superseded_by TEXT NOT NULL DEFAULT '',
        snapshot_json TEXT NOT NULL DEFAULT '')`);
      db.exec(`INSERT INTO memory_events (event_ts, op, record_id, content) VALUES ('2020-01-01T00:00:00Z','created','m_old','legacy')`);
      db.close();

      const store = new VectorStore(dbPath, 0);
      store.init();
      store.appendMemoryEvent({
        event_ts: "2026-01-01T00:00:00Z", session_key: "sk", session_id: "ses",
        op: "reverted", record_id: "m_old", content: "rejected", reviewer_id: "u-r",
      });
      const rows = store.queryMemoryEvents({ record_id: "m_old" });
      expect(rows).toHaveLength(2);
      expect(rows[0].reviewer_id).toBeUndefined(); // legacy row
      expect(rows[1].reviewer_id).toBe("u-r");
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rebuilds a legacy CHECK table so op='deleted' becomes writable, preserving rows", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mem-events-check-"));
    try {
      const dbPath = path.join(dir, "vectors.db");
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbPath);
      // Pre-ledger schema: op CHECK without 'deleted', no layer/source/request_id.
      db.exec(`CREATE TABLE memory_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, event_ts TEXT NOT NULL,
        session_key TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL DEFAULT '',
        origin_session_id TEXT NOT NULL DEFAULT '', origin_session_key TEXT NOT NULL DEFAULT '',
        team_id TEXT NOT NULL DEFAULT '', user_id TEXT NOT NULL DEFAULT '',
        agent_id TEXT NOT NULL DEFAULT '', task_id TEXT NOT NULL DEFAULT '',
        op TEXT NOT NULL CHECK (op IN ('created','updated','merged','superseded','reverted')),
        record_id TEXT NOT NULL, content TEXT NOT NULL,
        memory_type TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 0,
        supersedes TEXT NOT NULL DEFAULT '[]', superseded_by TEXT NOT NULL DEFAULT '',
        snapshot_json TEXT NOT NULL DEFAULT '', reviewer_id TEXT NOT NULL DEFAULT '')`);
      db.exec(`INSERT INTO memory_events (event_ts, op, record_id, content) VALUES ('2020-01-01T00:00:00Z','created','m_a','legacy-a')`);
      db.exec(`INSERT INTO memory_events (event_ts, op, record_id, content) VALUES ('2020-01-02T00:00:00Z','reverted','m_b','legacy-b')`);
      db.close();

      const store = new VectorStore(dbPath, 0);
      store.init();

      // Legacy rows survive the rebuild with inferred source and layer='l1'.
      const legacy = store.queryMemoryEvents({ limit: 10 });
      expect(legacy).toHaveLength(2);
      expect(legacy[0]).toMatchObject({ op: "created", source: "extraction", layer: "l1" });
      expect(legacy[1]).toMatchObject({ op: "reverted", source: "review", layer: "l1" });

      // The rebuilt CHECK accepts the new op.
      store.appendMemoryEvent({
        event_ts: "2026-01-01T00:00:00Z", session_key: "", session_id: "",
        op: "deleted", record_id: "m_a", content: "",
        layer: "l1", source: "api_mutation", request_id: "req-1",
      });
      const deleted = store.queryMemoryEvents({ op: "deleted" });
      expect(deleted).toHaveLength(1);
      expect(deleted[0]).toMatchObject({ record_id: "m_a", layer: "l1", source: "api_mutation", request_id: "req-1" });
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates the ORIGINAL schema too (no snapshot_json / reviewer_id columns)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mem-events-orig-"));
    try {
      const dbPath = path.join(dir, "vectors.db");
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbPath);
      // First shipped schema: no snapshot_json, no reviewer_id, CHECK without
      // 'reverted'/'deleted'. The copy SELECT references snapshot_json — it
      // only works because initSchema ALTER-backfills the column first.
      db.exec(`CREATE TABLE memory_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, event_ts TEXT NOT NULL,
        session_key TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL DEFAULT '',
        origin_session_id TEXT NOT NULL DEFAULT '', origin_session_key TEXT NOT NULL DEFAULT '',
        team_id TEXT NOT NULL DEFAULT '', user_id TEXT NOT NULL DEFAULT '',
        agent_id TEXT NOT NULL DEFAULT '', task_id TEXT NOT NULL DEFAULT '',
        op TEXT NOT NULL CHECK (op IN ('created','updated','merged','superseded')),
        record_id TEXT NOT NULL, content TEXT NOT NULL,
        memory_type TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 0,
        supersedes TEXT NOT NULL DEFAULT '[]', superseded_by TEXT NOT NULL DEFAULT '')`);
      db.exec(`INSERT INTO memory_events (event_ts, op, record_id, content) VALUES ('2020-01-01T00:00:00Z','created','m_oldest','v1')`);
      db.close();

      const store = new VectorStore(dbPath, 0);
      store.init();
      const rows = store.queryMemoryEvents({ record_id: "m_oldest" });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ op: "created", layer: "l1", source: "extraction" });
      store.appendMemoryEvent({
        event_ts: "2026-01-01T00:00:00Z", session_key: "", session_id: "",
        op: "deleted", record_id: "m_oldest", content: "", source: "api_mutation",
      });
      expect(store.queryMemoryEvents({ op: "deleted" })).toHaveLength(1);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("order:'desc' returns newest events first", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mem-events-desc-"));
    try {
      const store = new VectorStore(path.join(dir, "vectors.db"), 0);
      store.init();
      for (let i = 0; i < 3; i++) {
        store.appendMemoryEvent({
          event_ts: `2026-01-0${i + 1}T00:00:00Z`, session_key: "sk", session_id: "ses",
          op: "created", record_id: `m_${i}`, content: `c${i}`,
        });
      }
      const asc = store.queryMemoryEvents({ limit: 10 });
      const desc = store.queryMemoryEvents({ limit: 10, order: "desc" });
      expect(asc.map((e) => e.record_id)).toEqual(["m_0", "m_1", "m_2"]);
      expect(desc.map((e) => e.record_id)).toEqual(["m_2", "m_1", "m_0"]);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// TCVDB upsert 对相同文档 id 是整体替换：事件 id 若仅是 (event_ts,
// record_id, op, layer) 元组，同毫秒同记录同操作的**不同**事件会互相
// 覆盖、静默丢账。id 必须携带每次 append 独立的随机后缀。
describe("tcvdb memory_events document id uniqueness", () => {
  /** 内存后端，建模 VectorDB upsert 的 replace 语义：同 id 覆盖。 */
  function makeTcvdbStore() {
    const docs = new Map<string, Record<string, unknown>>();
    const upsertCalls: Array<Array<Record<string, unknown>>> = [];
    const stubClient = {
      upsert: async (_collection: string, batch: Array<Record<string, unknown>>) => {
        upsertCalls.push(batch);
        for (const d of batch) docs.set(String(d.id), d);
      },
      query: async (_collection: string, params: Record<string, unknown>) => {
        const all = [...docs.values()];
        const limit = Number(params.limit ?? 100);
        const offset = Number(params.offset ?? 0);
        return { documents: all.slice(offset, offset + limit) };
      },
    };
    // _initPromise 未设置时 _ensureInit 立即返回；直接替换 client 即可白盒注入。
    const store = new TcvdbMemoryStore({
      url: "http://stub", username: "u", apiKey: "k",
      database: "db", embeddingModel: "m", timeout: 5000,
    });
    (store as unknown as { client: unknown }).client = stubClient;
    return { store, docs, upsertCalls };
  }

  it("distinct same-tuple events all survive upsert replace semantics", async () => {
    const { store, docs } = makeTcvdbStore();
    const base = {
      event_ts: "2026-01-01T00:00:00.000Z",
      session_key: "sk", session_id: "ses",
      op: "updated" as const, record_id: "m_x", layer: "l1" as const,
    };
    await store.appendMemoryEvent({ ...base, content: "v1", request_id: "r1", version: 1 });
    await store.appendMemoryEvent({ ...base, content: "v2", request_id: "r2", version: 2 });
    await Promise.all([
      store.appendMemoryEvent({ ...base, content: "v3", request_id: "r3", version: 3 }),
      store.appendMemoryEvent({ ...base, content: "v4", request_id: "r4", version: 4 }),
    ]);
    expect(docs.size).toBe(4);
    const events = await store.queryMemoryEvents({ record_id: "m_x", limit: 10 });
    expect(events.map((e) => e.content).sort()).toEqual(["v1", "v2", "v3", "v4"]);
  });

  it("same request body replayed stays a single document (id stable per call)", async () => {
    const { store, docs, upsertCalls } = makeTcvdbStore();
    await store.appendMemoryEvent({
      event_ts: "2026-01-01T00:00:00.000Z", session_key: "sk", session_id: "ses",
      op: "updated", record_id: "m_x", layer: "l1", content: "v1",
    });
    const doc = upsertCalls[0]![0]!;
    expect(/^evt-[0-9a-f]{32}$/.test(String(doc.id))).toBe(true);
    await (store as unknown as { client: { upsert: (c: string, b: unknown[]) => Promise<void> } })
      .client.upsert("events", [doc]);
    expect(docs.size).toBe(1);
  });

  it("document id stays within the 128-char TCVDB limit for long record_ids", async () => {
    const { store, upsertCalls } = makeTcvdbStore();
    await store.appendMemoryEvent({
      event_ts: "2026-01-01T00:00:00.000Z", session_key: "", session_id: "",
      op: "deleted", record_id: `chat_memory-${"t".repeat(80)}-${"a".repeat(80)}`, layer: "l3", content: "",
    });
    expect(String(upsertCalls[0]![0]!.id).length <= 128).toBe(true);
  });

  it("re-appending the same event_id is idempotent and round-trips event_id", async () => {
    const { store, docs } = makeTcvdbStore();
    const ev = {
      event_id: "evt-0123456789abcdef0123456789abcdef",
      event_ts: "2026-01-01T00:00:00.000Z", session_key: "sk", session_id: "ses",
      op: "created" as const, record_id: "m_x", content: "v1",
    };
    await store.appendMemoryEvent(ev);
    await store.appendMemoryEvent(ev);
    expect(docs.size).toBe(1);
    const [got] = await store.queryMemoryEvents({ record_id: "m_x" });
    expect(got!.event_id).toBe(ev.event_id);
  });
});

describe("sqlite memory_events event_id", () => {
  let dir: string;
  let store: VectorStore;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ev-id-"));
    store = new VectorStore(path.join(dir, "vectors.db"), 0);
    store.init();
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const ev = (over: Record<string, unknown> = {}) => ({
    event_ts: "2026-01-01T00:00:00.000Z", session_key: "sk", session_id: "ses",
    op: "created" as const, record_id: "m_x", content: "v1", ...over,
  });

  it("assigns an event_id when the caller omits one", () => {
    store.appendMemoryEvent(ev());
    store.appendMemoryEvent(ev());
    const events = store.queryMemoryEvents({ record_id: "m_x" });
    expect(events).toHaveLength(2);
    expect(/^evt-[0-9a-f]{32}$/.test(events[0]!.event_id ?? "")).toBe(true);
    expect(events[0]!.event_id).not.toBe(events[1]!.event_id);
  });

  it("duplicate event_id is a no-op (replay idempotency)", () => {
    const e = ev({ event_id: "evt-dup" });
    store.appendMemoryEvent(e);
    store.appendMemoryEvent(e);
    expect(store.queryMemoryEvents({ record_id: "m_x" })).toHaveLength(1);
  });

  it("orders by event_ts (seq only breaks ties), so backfilled older events keep their place", () => {
    store.appendMemoryEvent(ev({ event_id: "evt-new", op: "updated", event_ts: "2026-01-02T00:00:00.000Z" }));
    store.appendMemoryEvent(ev({ event_id: "evt-old", op: "created", event_ts: "2026-01-01T00:00:00.000Z" }));
    expect(store.queryMemoryEvents({ record_id: "m_x" }).map((e) => e.op)).toEqual(["created", "updated"]);
    expect(store.queryMemoryEvents({ record_id: "m_x", order: "desc" }).map((e) => e.op)).toEqual(["updated", "created"]);
  });

  it("redaction blanks content/snapshot but keeps the metadata skeleton", () => {
    store.appendMemoryEvent(ev({ event_id: "evt-a", team_id: "t1", agent_id: "a1", snapshot_json: "{\"x\":1}" }));
    store.appendMemoryEvent(ev({ event_id: "evt-b", team_id: "t2", agent_id: "a1" }));
    const n = store.redactMemoryEvents({ team_id: "t1", agent_id: "a1", until: "2026-12-31T00:00:00.000Z" });
    expect(n).toBe(1);
    const [a, b] = store.queryMemoryEvents({ record_id: "m_x" });
    expect(a).toMatchObject({ event_id: "evt-a", op: "created", content: "" });
    expect(a.snapshot_json ?? "").toBe("");
    expect(b.content).toBe("v1");
  });

  it("degraded store rejects appends so the ledger records them as pending", () => {
    (store as unknown as { degraded: boolean }).degraded = true;
    expect(() => store.appendMemoryEvent(ev({ event_id: "evt-deg" }))).toThrow();
  });

  it("invalid op is still rejected rather than silently ignored", () => {
    expect(() => store.appendMemoryEvent(ev({ event_id: "evt-bad", op: "bogus" }) as never)).toThrow();
  });
});

describe("sqlite store-level instant/filter contract", () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mem-contract-"));
    store = new VectorStore(path.join(dir, "vectors.db"), 0);
    store.init();
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const ev = (over: Partial<MemoryEvent> = {}): MemoryEvent => ({
    event_ts: "2026-01-01T00:00:00.000Z", session_key: "sk", session_id: "ses",
    team_id: "t1", agent_id: "a1", op: "created", record_id: "m_x", content: "v1", ...over,
  });
  const rec = (over: Partial<MemoryRecord> = {}): MemoryRecord => ({
    id: "m_rec", content: "c", type: "work_fact", priority: 50, scene_name: "default",
    source_message_ids: [], metadata: {}, timestamps: [],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    sessionKey: "sk", sessionId: "ses", teamId: "t1", userId: "u1", agentId: "a1",
    ...over,
  });
  const l0 = (over: Partial<L0Record> = {}): L0Record => ({
    id: "l0_1", sessionKey: "sk", sessionId: "ses", role: "user",
    messageText: "hi", recordedAt: "2026-01-01T00:00:00.000Z", timestamp: 0, ...over,
  });

  it("appendMemoryEvent enforces canonical event_ts at store level", () => {
    expect(() => store.appendMemoryEvent(ev({ event_ts: "March 5, 2026" }))).toThrow(/non-canonical/);
    expect(() => store.appendMemoryEvent(ev({ event_ts: "2026-01-01T00:00:00.123456Z" }))).toThrow(/non-canonical/);
    // 等价拼法在写入点坍缩为规范形——+08:00 = 02:00Z
    store.appendMemoryEvent(ev({ event_ts: "2026-01-01T10:00:00+08:00", record_id: "m_off" }));
    expect(store.queryMemoryEvents({ record_id: "m_off" })[0]!.event_ts).toBe("2026-01-01T02:00:00.000Z");
  });

  it("redactMemoryEvents refuses filters carrying fields outside the whitelist", () => {
    store.appendMemoryEvent(ev({ record_id: "m_keep" }));
    const n = store.redactMemoryEvents({ team_id: "t1", agent_id: "a1", task_id: "tk", until: "2026-12-31T00:00:00.000Z" } as never);
    expect(n).toBe(0);
    expect(store.queryMemoryEvents({ record_id: "m_keep" })[0]!.content).toBe("v1");
  });

  it("upsertL1 rejects non-canonical instants and normalizes equivalent forms", () => {
    expect(store.upsertL1(rec({ updatedAt: "yesterday" }), undefined)).toBe(false);
    expect(store.upsertL1(rec({ id: "m_bad", createdAt: "not a date" }), undefined)).toBe(false);
    // "" 是不朽哨兵（兼作 80% 护栏下的 keeper 行）
    expect(store.upsertL1(rec({ id: "m_imm", updatedAt: "" }), undefined)).toBe(true);
    // "+08:00" → 02:00Z：cutoff 03:00Z 下按过期删除（存原始串会词法漏删）
    expect(store.upsertL1(rec({ id: "m_off", updatedAt: "2026-01-01T10:00:00+08:00" }), undefined)).toBe(true);
    expect(store.deleteL1Expired("2026-01-01T03:00:00.000Z")).toBe(1);
    // 余下只有 '' 哨兵行——TTL 永不删
    expect(store.deleteL1Expired("2026-01-01T03:00:00.000Z")).toBe(0);
  });

  it("upsertL0 rejects a non-canonical recordedAt", () => {
    expect(store.upsertL0(l0({ recordedAt: "March 5, 2026" }), undefined)).toBe(false);
    expect(store.upsertL0(l0({ id: "l0_keep", recordedAt: "" }), undefined)).toBe(true); // '' keeper
    expect(store.upsertL0(l0({ id: "l0_ok", recordedAt: "2026-01-01T10:00:00+08:00" }), undefined)).toBe(true);
    expect(store.deleteL0Expired("2026-01-01T03:00:00.000Z")).toBe(1);
  });

  it("'' and 'default' are the same isolation bucket on query and redact", () => {
    store.appendMemoryEvent(ev({ record_id: "m_leg", team_id: "" }));        // legacy/foreign form
    store.appendMemoryEvent(ev({ record_id: "m_def", team_id: "default" })); // contract form
    store.appendMemoryEvent(ev({ record_id: "m_t1", team_id: "t1" }));
    // 一个 "default" 过滤同时覆盖两种存储形态；"" 过滤愈合为同一过滤
    for (const team_id of ["default", ""]) {
      const ids = store.queryMemoryEvents({ team_id }).map((e) => e.record_id).sort();
      expect(ids).toEqual(["m_def", "m_leg"]);
    }
    // 擦除同样双形态命中（marker 侧覆盖语义由 markerCovers 的对称愈合保证）
    expect(store.redactMemoryEvents({ team_id: "default", until: "2027-01-01T00:00:00.000Z" })).toBe(2);
    expect(store.redactMemoryEvents({ team_id: "t1", until: "2027-01-01T00:00:00.000Z" })).toBe(1);
  });

  it("init normalizes legacy '' isolation ids and non-canonical instant columns", async () => {
    const migDir = mkdtempSync(path.join(tmpdir(), "mem-contract-mig-"));
    try {
      const dbPath = path.join(migDir, "vectors.db");
      const seed = new VectorStore(dbPath, 0);
      seed.init();
      seed.close();
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbPath);
      db.exec(`INSERT INTO memory_events (event_ts, op, record_id, content, team_id, user_id, agent_id)
        VALUES ('2020-01-01T00:00:00.000Z', 'created', 'm_leg', 'x', '', '', '')`);
      db.exec(`INSERT INTO l1_records (record_id, content, updated_time) VALUES
        ('m_t', 'x', '2020-03-01T10:00:00+08:00'), ('m_k', 'x', '2030-01-01T00:00:00.000Z')`);
      db.exec(`INSERT INTO l0_conversations (record_id, session_key, message_text, recorded_at) VALUES
        ('l0_t', 'sk', 'hi', '2020-03-01T10:00:00+08:00'), ('l0_k', 'sk', 'hi', '2030-01-01T00:00:00.000Z')`);
      db.close();

      const reopened = new VectorStore(dbPath, 0);
      try {
        reopened.init();
        const row = reopened.queryMemoryEvents({ record_id: "m_leg" })[0]!;
        expect(row).toMatchObject({ team_id: "default", user_id: "default", agent_id: "default" });
        // +08:00 → 02:00Z → cutoff 03:00Z 下过期（未归一化的字符串会漏删；
        // keeper 行把比例压到 50%，不触发 80% 护栏）
        expect(reopened.deleteL1Expired("2020-03-01T03:00:00.000Z")).toBe(1);
        expect(reopened.deleteL0Expired("2020-03-01T03:00:00.000Z")).toBe(1);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(migDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

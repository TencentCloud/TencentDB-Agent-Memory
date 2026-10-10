import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { VectorStore as SqliteMemoryStore, buildFtsQuery } from "../store/sqlite/memory-store.js";
import type { MemoryRecord } from "../store/types.js";
import { SqliteAtomicMemoryPort, type AtomicMemoryScope } from "./sqlite-atomic-port.js";

const scope: AtomicMemoryScope = { teamId: "pilot-team", userId: "pilot-user", agentId: "pilot-agent", taskId: "" };
const other = { ...scope, userId: "other-user" };
const logger = { debug() {}, info() {}, warn() {}, error() {} };
function record(id = "MEM-01", content = "PostgreSQL", version = 1, target = scope): MemoryRecord {
  return { id, content, version, type: "instruction", priority: 50, scene_name: "",
    source_message_ids: ["TURN-01"], metadata: {}, timestamps: ["2026-09-05T00:00:00.000Z"],
    createdAt: "2026-09-05T00:00:00.000Z", updatedAt: "2026-09-05T00:00:00.000Z",
    sessionKey: "pilot-session", sessionId: "pilot-session", ...target };
}
function fixture(t: { after: (fn: () => void) => void }, dimensions = 0) {
  const dir = mkdtempSync(join(tmpdir(), "memory-chain-port-"));
  const path = join(dir, "memory.sqlite");
  const store = new SqliteMemoryStore(path, dimensions, logger);
  store.init();
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(store.isDegraded(), false, "real MemoryCore SQLite must initialize");
  assert.equal(store.isFtsAvailable(), true, "FTS capability is required, not skipped");
  return { store, port: new SqliteAtomicMemoryPort(store), path };
}

test("exact ID reads use the primary-key index and preserve all four scope boundaries", (t) => {
  const { port, store } = fixture(t);
  for (const [id, content, s] of [["MEM-01", "MySQL", scope], ["MEM-02", "PostgreSQL", scope], ["MEM-03", "Redis", other]] as const) {
    assert.equal(port.createIfAbsent(s, record(id, content, 1, s)).status, "applied");
  }
  assert.equal(port.getExact(scope, "MEM-02")?.content, "PostgreSQL");
  assert.equal(port.getExact(scope, "does-not-exist"), null);
  for (const key of ["teamId", "userId", "agentId", "taskId"] as const) assert.equal(port.getExact({ ...scope, [key]: "foreign" }, "MEM-02"), null);
  assert.deepEqual(port.createIfAbsent(scope, record("MEM-03")).status, "conflict");
  const plan = store.getRawDb().prepare("EXPLAIN QUERY PLAN SELECT * FROM l1_records WHERE record_id=? AND team_id=? AND user_id=? AND agent_id=? AND task_id=? LIMIT 1").all("MEM-02", scope.teamId, scope.userId, scope.agentId, scope.taskId);
  assert.match(JSON.stringify(plan), /INDEX.*record_id/i);
});

test("CAS rejects a stale version, wrong scope, or changed identity without touching another candidate", (t) => {
  const { port } = fixture(t);
  port.createIfAbsent(scope, record("MEM-01", "MySQL"));
  port.createIfAbsent(scope, record("MEM-02", "Redis"));
  assert.equal(port.updateIfVersion(scope, "MEM-02", 1, record("MEM-02", "PostgreSQL", 2)).status, "applied");
  assert.equal(port.updateIfVersion(scope, "MEM-02", 1, record("MEM-02", "stale", 2)).status, "conflict");
  assert.equal(port.updateIfVersion(other, "MEM-02", 2, record("MEM-02", "foreign", 3, other)).status, "conflict");
  assert.throws(() => port.updateIfVersion(scope, "MEM-02", 2, record("MEM-01", "wrong", 3)), /atomic_port_invalid_version/);
  assert.equal(port.getExact(scope, "MEM-01")?.content, "MySQL");
  assert.equal(port.getExact(scope, "MEM-02")?.content, "PostgreSQL");
  assert.equal(port.deleteIfVersion(scope, "MEM-02", 1).status, "conflict");
  assert.equal(port.deleteIfVersion(other, "MEM-02", 2).status, "conflict");
  assert.equal(port.deleteIfVersion(scope, "MEM-02", 2).status, "applied");
  assert.equal(port.getExact(scope, "MEM-02"), null);
});

test("metadata and real FTS update together: old token disappears and new token is searchable", (t) => {
  const { port, store } = fixture(t);
  port.createIfAbsent(scope, record("MEM-01", "mysqllegacy"));
  assert.equal(store.searchL1Fts(buildFtsQuery("mysqllegacy")!, 5, scope).length, 1);
  port.updateIfVersion(scope, "MEM-01", 1, record("MEM-01", "postgrescurrent", 2));
  assert.equal(store.searchL1Fts(buildFtsQuery("mysqllegacy")!, 5, scope).length, 0);
  assert.equal(store.searchL1Fts(buildFtsQuery("postgrescurrent")!, 5, scope)[0]?.version, 2);
  port.deleteIfVersion(scope, "MEM-01", 2);
  assert.equal(store.searchL1Fts(buildFtsQuery("postgrescurrent")!, 5, scope).length, 0);
});

test("a ledger failure rolls metadata and FTS back on the same real connection", (t) => {
  const { port, store } = fixture(t);
  const db = store.getRawDb();
  assert.equal(port.getRawDb(), db, "ledger and memory CAS share the identical connection");
  db.exec("CREATE TABLE pilot_events (event_id TEXT PRIMARY KEY)");
  port.createIfAbsent(scope, record("MEM-01", "oldtoken"));
  assert.throws(() => port.atomic(() => {
    port.updateIfVersion(scope, "MEM-01", 1, record("MEM-01", "newtoken", 2));
    db.prepare("INSERT INTO pilot_events VALUES (?)").run("EVENT-01");
    db.prepare("INSERT INTO pilot_events VALUES (?)").run("EVENT-01");
  }), /^AtomicMemoryPortError: atomic_port_operation_failed$/);
  assert.equal(port.getExact(scope, "MEM-01")?.version, 1);
  assert.equal(store.searchL1Fts(buildFtsQuery("oldtoken")!, 5, scope).length, 1);
  assert.equal(store.searchL1Fts(buildFtsQuery("newtoken")!, 5, scope).length, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM pilot_events").get()?.n, 0);
});

test("FTS write failure rolls metadata back instead of reporting success", (t) => {
  const { port, store } = fixture(t);
  port.createIfAbsent(scope, record("MEM-01", "oldtoken"));
  // Drop FTS inside the outer transaction so the nested write fails after its
  // metadata UPDATE. SQLite must roll back both the UPDATE and this DDL.
  assert.throws(() => port.atomic(() => {
    store.getRawDb().exec("DROP TABLE l1_fts");
    port.updateIfVersion(scope, "MEM-01", 1, record("MEM-01", "newtoken", 2));
  }), /atomic_port_operation_failed/);
  assert.equal(port.getExact(scope, "MEM-01")?.content, "oldtoken");
  assert.equal(store.searchL1Fts(buildFtsQuery("oldtoken")!, 5, scope).length, 1);
  assert.equal(store.searchL1Fts(buildFtsQuery("newtoken")!, 5, scope).length, 0);
});

test("caught nested errors poison the outer transaction; async callbacks are forbidden", (t) => {
  const { port } = fixture(t);
  assert.throws(() => port.atomic(() => {
    port.createIfAbsent(scope, record());
    try { port.atomic(() => { throw new Error("sensitive details never propagate"); }); } catch { /* intentional */ }
  }), /atomic_port_transaction_poisoned/);
  assert.equal(port.getExact(scope, "MEM-01"), null);
  assert.throws(() => port.atomic(async () => 1), /atomic_port_async_forbidden/);
  assert.throws(() => port.atomic(() => Promise.resolve(1)), /atomic_port_async_forbidden/);
  assert.throws(() => port.atomic(() => {
    port.createIfAbsent(scope, record());
    try { port.atomic(async () => 1); } catch { /* outer transaction must remain poisoned */ }
  }), /atomic_port_transaction_poisoned/);
  assert.equal(port.getExact(scope, "MEM-01"), null);
});

test("invalid or oversize payloads and unknown schema fail closed", (t) => {
  const { port, store } = fixture(t);
  assert.throws(() => port.getExact({ ...scope, teamId: "default" }, "MEM-01"), /atomic_port_invalid_scope/);
  assert.throws(() => port.getExact({ ...scope, taskId: undefined } as unknown as AtomicMemoryScope, "MEM-01"), /atomic_port_invalid_input/);
  assert.throws(() => port.createIfAbsent(scope, record("MEM-01", "x".repeat(8193))), /atomic_port_invalid_input/);
  assert.throws(() => port.createIfAbsent(scope, { ...record(), metadata: { large: "x".repeat(9000) } } as unknown as MemoryRecord), /atomic_port_invalid_input/);
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  assert.throws(() => port.createIfAbsent(scope, { ...record(), metadata: cycle } as unknown as MemoryRecord), /atomic_port_invalid_input/);
  store.getRawDb().exec("DROP TABLE l1_fts");
  assert.throws(() => port.createIfAbsent(scope, record()), /atomic_port_schema_unsupported/);
  assert.equal(port.getExact(scope, "MEM-01"), null);
});

test("two real SQLite connections cannot both win the same expected version", (t) => {
  const { port, path } = fixture(t);
  port.createIfAbsent(scope, record());
  const second = new SqliteMemoryStore(path, 0, logger); second.init();
  try {
    const peer = new SqliteAtomicMemoryPort(second);
    assert.equal(peer.getExact(scope, "MEM-01")?.version, 1);
    assert.equal(port.updateIfVersion(scope, "MEM-01", 1, record("MEM-01", "winner", 2)).status, "applied");
    assert.equal(peer.updateIfVersion(scope, "MEM-01", 1, record("MEM-01", "loser", 2)).status, "conflict");
    assert.equal(peer.getExact(scope, "MEM-01")?.content, "winner");
  } finally { second.close(); }
});

test("updating without a new embedding invalidates the real old vec0 row", (t) => {
  const { port, store } = fixture(t, 3);
  assert.equal(store.upsertL1(record("MEM-01", "mysqllegacy"), new Float32Array([1, 0, 0])), true);
  assert.equal(store.getRawDb().prepare("SELECT count(*) AS n FROM l1_vec WHERE record_id=?").get("MEM-01")?.n, 1);
  assert.equal(port.updateIfVersion(scope, "MEM-01", 1, record("MEM-01", "postgrescurrent", 2)).vectorInvalidated, true);
  assert.equal(store.getRawDb().prepare("SELECT count(*) AS n FROM l1_vec WHERE record_id=?").get("MEM-01")?.n, 0);
  assert.equal(store.searchL1Fts(buildFtsQuery("postgrescurrent")!, 5, scope).length, 1);
  assert.equal(port.createIfAbsent(scope, record("MEM-02")).vectorInvalidated, false);
  assert.equal(store.getRawDb().prepare("SELECT count(*) AS n FROM l1_vec").get()?.n, 0);
});

test("real L1 and FTS stores above their hard row caps reject before another write", (t) => {
  for (const [table, cap] of [["l1_records", 10000], ["l1_fts", 20000]] as const) {
    const { port, store } = fixture(t);
    port.createIfAbsent(scope, record());
    const db = store.getRawDb();
    const columns = (db.prepare('PRAGMA table_info(' + table + ')').all() as Array<{ name: string }>).map(x => x.name);
    const select = columns.map(key => key === 'record_id' ? "'CAP-' || n" : 'base.' + key).join(',');
    db.exec('WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM nums WHERE n<' + cap + ') INSERT INTO ' + table +
      '(' + columns.join(',') + ') SELECT ' + select + ' FROM ' + table + " AS base CROSS JOIN nums WHERE base.record_id='MEM-01'");
    assert.equal(db.prepare('SELECT count(*) AS n FROM ' + table).get()?.n, cap + 1);
    assert.throws(() => port.updateIfVersion(scope, 'MEM-01', 1, record('MEM-01', 'must-not-write', 2)), /atomic_port_capacity_exceeded/);
    assert.equal(port.getExact(scope, 'MEM-01')?.version, 1);
  }
});

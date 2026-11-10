// FTS5 删除路径回归：record_id 是 UNINDEXED 列，按它删除每次都全表扫描（同步阻塞事件循环，
// 随历史线性变慢）。现经 l0_fts_rowmap / l1_fts_rowmap（record_id → FTS rowid）按 rowid 删除。
// 覆盖：upsert 覆盖写只留一行、各删除路径同步清 FTS、旧库首次启动回填（含重复 FTS 行去重）、
// 删除语句的查询计划不再是全表扫描、回填中断 / 失败后重启能恢复。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { VectorStore } from "./memory-store.js";
import type { L0Record } from "../types.js";
import type { MemoryRecord } from "../../record/l1-writer.js";

const here = dirname(fileURLToPath(import.meta.url));
/** MemoryCore 包根（子进程从这里解析 tsx）。 */
const pkgRoot = resolve(here, "../../../..");
/** L0 映射表回填语句里独有的片段，用来在这一步注入故障。 */
const BACKFILL_SQL_MARK = "SELECT record_id, rowid FROM l0_fts";

let dir: string;
let dbPath: string;
let store: VectorStore;

const l0 = (id: string, text: string, extra: Partial<L0Record> = {}): L0Record => ({
  id,
  sessionKey: "sess-A",
  sessionId: "sess-A",
  teamId: "team-1",
  userId: "user-1",
  agentId: "agent-1",
  role: "user",
  messageText: text,
  recordedAt: new Date(1_000).toISOString(),
  timestamp: 1_000,
  ...extra,
});

const l1 = (id: string, content: string): MemoryRecord => ({
  id,
  content,
  type: "work_fact",
  priority: 50,
  scene_name: "",
  source_message_ids: [],
  metadata: {},
  timestamps: [new Date(1_000).toISOString()],
  createdAt: new Date(1_000).toISOString(),
  updatedAt: new Date(1_000).toISOString(),
  sessionKey: "sess-A",
  sessionId: "sess-A",
  teamId: "team-1",
  userId: "user-1",
  agentId: "agent-1",
}) as MemoryRecord;

/** Side connection for inspecting / tampering with the same file (WAL allows it). */
function raw(): DatabaseSync {
  return new DatabaseSync(dbPath);
}

function count(db: DatabaseSync, sql: string, ...args: (string | number)[]): number {
  return Number((db.prepare(sql).get(...args) as { n: number }).n);
}

function openStore(): VectorStore {
  // dimensions=0 → no vec0 tables, same as a deployment without embedding.
  const s = new VectorStore(dbPath, 0);
  s.init();
  return s;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

/** 映射表与 FTS 一一对应：行数相同，且每条映射都指向同 record_id 的 FTS 行。 */
function expectRowmapConsistent(layer: "l0" | "l1", rows: number): void {
  const db = raw();
  try {
    expect(tableExists(db, `${layer}_fts_rowmap`)).toBe(true);
    expect(count(db, `SELECT count(*) AS n FROM ${layer}_fts`)).toBe(rows);
    expect(count(db, `SELECT count(*) AS n FROM ${layer}_fts_rowmap`)).toBe(rows);
    expect(count(db, `
      SELECT count(*) AS n FROM ${layer}_fts_rowmap m
      JOIN ${layer}_fts f ON f.rowid = m.fts_rowid AND f.record_id = m.record_id
    `)).toBe(rows);
  } finally {
    db.close();
  }
}

/**
 * 造一个升级前的库并关闭 store：L0 有 o1 / o2（o1 因历史问题多一行重复 FTS），
 * L1 有 x1，两层都没有映射表。
 */
function makeLegacyDb(): void {
  store.upsertL0(l0("o1", "platypus alpha"), undefined);
  store.upsertL0(l0("o2", "platypus beta"), undefined);
  store.upsertL1(l1("x1", "platypus gamma"), undefined);
  store.close();

  const db = raw();
  try {
    db.exec("DROP TABLE l0_fts_rowmap");
    db.exec("DROP TABLE l1_fts_rowmap");
    db.exec(`
      INSERT INTO l0_fts (message_text, message_text_original, record_id, session_key, session_id,
        team_id, task_id, user_id, agent_id, role, recorded_at, timestamp)
      SELECT message_text, message_text_original, record_id, session_key, session_id,
        team_id, task_id, user_id, agent_id, role, recorded_at, timestamp
      FROM l0_fts WHERE record_id = 'o1'
    `);
    expect(count(db, "SELECT count(*) AS n FROM l0_fts WHERE record_id = 'o1'")).toBe(2);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tdai-fts-rowmap-"));
  dbPath = join(dir, "vectors.db");
  store = openStore();
  expect(store.isFtsAvailable()).toBe(true);
});

afterEach(() => {
  try { store.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe("L0 FTS 按 rowid 维护", () => {
  it("同一 record_id 重复 upsert：FTS 只留一行，检索到的是新内容", () => {
    store.upsertL0(l0("m1", "zebrafox original"), undefined);
    store.upsertL0(l0("m1", "zebrafox updated"), undefined);

    const db = raw();
    try {
      expect(count(db, "SELECT count(*) AS n FROM l0_fts WHERE record_id = ?", "m1")).toBe(1);
      expect(count(db, "SELECT count(*) AS n FROM l0_fts_rowmap WHERE record_id = ?", "m1")).toBe(1);
      const mapped = db.prepare("SELECT fts_rowid FROM l0_fts_rowmap WHERE record_id = ?").get("m1") as { fts_rowid: number };
      const actual = db.prepare("SELECT rowid AS r FROM l0_fts WHERE record_id = ?").get("m1") as { r: number };
      expect(mapped.fts_rowid).toBe(actual.r);
    } finally {
      db.close();
    }
    const hits = store.searchL0Fts("zebrafox", 10);
    expect(hits.map((h) => h.message_text)).toEqual(["zebrafox updated"]);
  });

  it("deleteL0 / deleteL0BySession / clearMemoryContent 都会删掉 FTS 行与映射", () => {
    store.upsertL0(l0("d1", "quokka one"), undefined);
    store.upsertL0(l0("d2", "quokka two", { sessionKey: "sess-B", sessionId: "sess-B" }), undefined);
    store.upsertL0(l0("d3", "quokka three", { sessionKey: "sess-C", sessionId: "sess-C" }), undefined);
    store.upsertL0(l0("keep", "quokka keep", { agentId: "agent-2" }), undefined);

    expect(store.deleteL0("d1")).toBe(true);
    expect(store.deleteL0BySession("sess-B")).toBe(1);
    store.clearMemoryContent({ teamId: "team-1", agentId: "agent-1" });

    expect(store.searchL0Fts("quokka", 10).map((h) => h.record_id)).toEqual(["keep"]);
    const db = raw();
    try {
      expect(count(db, "SELECT count(*) AS n FROM l0_fts")).toBe(1);
      expect(count(db, "SELECT count(*) AS n FROM l0_fts_rowmap")).toBe(1);
    } finally {
      db.close();
    }
  });

  it("删除语句走主键 + rowid，不再全表扫描 FTS", () => {
    const db = raw();
    try {
      const plan = (sql: string) =>
        (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1) as Array<{ detail: string }>).map((r) => r.detail).join(" | ");
      // 旧写法：FTS5 对 UNINDEXED 列没有约束可用 → 全表扫描（idxNum 0，idxStr 空）。
      expect(plan("DELETE FROM l0_fts WHERE record_id = ?")).toMatch(/VIRTUAL TABLE INDEX 0:$/);
      // 新写法：映射表按主键查，FTS 按 rowid 定位。
      expect(plan("SELECT fts_rowid FROM l0_fts_rowmap WHERE record_id = ?")).toMatch(/USING INDEX sqlite_autoindex_l0_fts_rowmap_1/);
      expect(plan("DELETE FROM l0_fts WHERE rowid = ?")).not.toMatch(/VIRTUAL TABLE INDEX 0:$/);
    } finally {
      db.close();
    }
  });
});

describe("L1 FTS 按 rowid 维护", () => {
  it("upsertL1 覆盖写只留一行；deleteL1 / deleteL1Batch 清干净", () => {
    store.upsertL1(l1("r1", "narwhal first"), undefined);
    store.upsertL1(l1("r1", "narwhal second"), undefined);
    store.upsertL1(l1("r2", "narwhal other"), undefined);
    store.upsertL1(l1("r3", "narwhal third"), undefined);

    expect(store.searchL1Fts("narwhal", 10).map((h) => h.record_id).sort()).toEqual(["r1", "r2", "r3"]);
    expect(store.searchL1Fts("first", 10)).toEqual([]);

    expect(store.deleteL1("r1")).toBe(true);
    expect(store.deleteL1Batch(["r2", "r3"])).toBe(true);
    expect(store.searchL1Fts("narwhal", 10)).toEqual([]);

    const db = raw();
    try {
      expect(count(db, "SELECT count(*) AS n FROM l1_fts")).toBe(0);
      expect(count(db, "SELECT count(*) AS n FROM l1_fts_rowmap")).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("旧库升级：首次启动回填映射表", () => {
  it("没有映射表的旧库：回填、去掉重复 FTS 行，之后的覆盖写与删除都生效", () => {
    makeLegacyDb();

    store = openStore();

    const db2 = raw();
    try {
      expect(count(db2, "SELECT count(*) AS n FROM l0_fts WHERE record_id = 'o1'")).toBe(1);
      expect(count(db2, "SELECT count(*) AS n FROM l0_fts_rowmap")).toBe(2);
      expect(count(db2, "SELECT count(*) AS n FROM l1_fts_rowmap")).toBe(1);
      // 映射指向的正是保留下来的那一行
      expect(count(db2, `
        SELECT count(*) AS n FROM l0_fts_rowmap m JOIN l0_fts f ON f.rowid = m.fts_rowid AND f.record_id = m.record_id
      `)).toBe(2);
    } finally {
      db2.close();
    }

    store.upsertL0(l0("o1", "platypus alpha2"), undefined);
    expect(store.deleteL0("o2")).toBe(true);
    expect(store.deleteL1("x1")).toBe(true);
    expect(store.searchL0Fts("platypus", 10).map((h) => h.message_text)).toEqual(["platypus alpha2"]);
    expect(store.searchL1Fts("platypus", 10)).toEqual([]);
  });

  it("回填事务中途进程退出：建表随事务回滚，下次启动重新回填", () => {
    makeLegacyDb();

    // 子进程用本 PR 的代码打开旧库，在回填 INSERT 执行前直接退出（此时 CREATE TABLE
    // 与去重 DELETE 已在同一事务里执行，但未提交）。
    const script = join(dir, "crash-during-backfill.ts");
    writeFileSync(script, `
      import { DatabaseSync } from "node:sqlite";
      import { VectorStore } from ${JSON.stringify(pathToFileURL(join(here, "memory-store.ts")).href)};
      const orig = DatabaseSync.prototype.prepare;
      DatabaseSync.prototype.prepare = function (sql: string) {
        if (sql.includes(${JSON.stringify(BACKFILL_SQL_MARK)})) process.exit(42);
        return orig.call(this, sql);
      };
      new VectorStore(${JSON.stringify(dbPath)}, 0).init();
      process.exit(0);
    `);
    const child = spawnSync(process.execPath, ["--import", "tsx", script], { cwd: pkgRoot, encoding: "utf8" });
    expect(child.status, child.stderr).toBe(42);

    // 未提交的事务被丢弃：映射表不存在，重复 FTS 行也还在。
    const db = raw();
    try {
      expect(tableExists(db, "l0_fts_rowmap")).toBe(false);
      expect(count(db, "SELECT count(*) AS n FROM l0_fts WHERE record_id = 'o1'")).toBe(2);
    } finally {
      db.close();
    }

    store = openStore();
    expectRowmapConsistent("l0", 2);
    expectRowmapConsistent("l1", 1);

    expect(store.deleteL0("o2")).toBe(true);
    expect(store.searchL0Fts("platypus", 10).map((h) => h.record_id)).toEqual(["o1"]);
    store.close();
    store = openStore();
    expect(store.searchL0Fts("platypus", 10).map((h) => h.record_id)).toEqual(["o1"]);
  });

  it("回填失败：回滚并退回按 record_id 删除，修复后重启能补上回填", () => {
    makeLegacyDb();

    const orig = DatabaseSync.prototype.prepare;
    const spy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql.includes(BACKFILL_SQL_MARK)) throw new Error("injected backfill failure");
      return orig.call(this, sql);
    });
    store = openStore();
    spy.mockRestore();
    expect(store.isFtsAvailable()).toBe(true);

    const db = raw();
    try {
      expect(tableExists(db, "l0_fts_rowmap")).toBe(false);
      // l1 不受 l0 的失败影响
      expectRowmapConsistent("l1", 1);
    } finally {
      db.close();
    }

    // 映射不可用期间：删除与覆盖写仍然正确（慢路径）。
    expect(store.deleteL0("o2")).toBe(true);
    store.upsertL0(l0("o1", "platypus alpha2"), undefined);
    expect(store.searchL0Fts("platypus", 10).map((h) => h.message_text)).toEqual(["platypus alpha2"]);

    // 故障消除后重启：映射表建好并与 FTS 一一对应，之后按 rowid 删除生效且重启后不复现。
    store.close();
    store = openStore();
    expectRowmapConsistent("l0", 1);
    expect(store.deleteL0("o1")).toBe(true);
    expect(store.searchL0Fts("platypus", 10)).toEqual([]);
    store.close();
    store = openStore();
    expect(store.searchL0Fts("platypus", 10)).toEqual([]);
  });

  it("回填只做一次：再次打开不重复写", () => {
    store.upsertL0(l0("p1", "wombat"), undefined);
    store.close();
    store = openStore();
    store.close();
    store = openStore();
    const db = raw();
    try {
      expect(count(db, "SELECT count(*) AS n FROM l0_fts_rowmap")).toBe(1);
      expect(count(db, "SELECT count(*) AS n FROM l0_fts")).toBe(1);
    } finally {
      db.close();
    }
  });
});

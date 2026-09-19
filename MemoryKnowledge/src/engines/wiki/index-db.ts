/**
 * Per-wiki `index.db` connection management (设计 006).
 *
 * 每个 wiki 一个独立 SQLite 文件 `index.db`，放在该 wiki 的数据目录下（与正文 `.md`
 * 同目录同生命周期），承载本 wiki 的全部私有索引数据：
 *   - `wiki_fts`   FTS5 预分词倒排（BM25 全文检索）
 *   - `page_meta`  页元数据（title/type/rel_path/snippet；正文不入库，留磁盘）
 *   - `graph_edge` 知识图谱有向边（多跳 BFS 用）
 *   - `source`     源文件一等实体（增量判断 + 生命周期；DDL 本轮建好，读写方法见 003 阶段）
 *
 * 连接策略（设计 §4）：
 *   - 写（ingest/sync：重建 FTS5 + graph_edge + 更新 source）：**独立连接**，事务内完成
 *     → `wal_checkpoint(TRUNCATE)` → `close()`，不进池，避免被读池 LRU 驱逐的竞态。
 *   - 读（search/graph）：走 **LRU 连接池**，热 wiki 常驻、冷 wiki 驱逐。
 *
 * 内存上限 = POOL_MAX × cache_size（约 600MB），与 wiki 总数解耦；SQLite 打开连接
 * 亚毫秒、数据按 page 懒加载，不是"打开即全量入内存"，正是它根治 MiniSearch 20GB OOM 的原因。
 *
 * fd 约束（设计 §4.3）：WAL 每连接占 3 fd（db+wal+shm），`POOL_MAX × 3 + 富余` 需 ≤ ulimit -n。
 * POOL_MAX 与部署 ulimit 联动，默认 300（约 900 fd，建议 ulimit -n ≥ 2048）。
 */

import Database from "better-sqlite3";
import { LRUCache } from "lru-cache";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { existsSync } from "node:fs";

/**
 * 读连接池上限。与部署 ulimit 联动（WAL 每连接 3 fd，需 ulimit -n ≥ POOL_MAX*3 + 富余）。
 * 可用环境变量覆盖（仅用于测试或特殊部署环境），默认 300。
 */
const POOL_MAX = (() => {
  const raw = process.env.KNOWLEDGE_WIKI_POOL_MAX;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(n) && n > 0 ? n : 300;
})();

/** 每连接 page cache 上限（KB）；cache_size 用负数表示 KB。 */
const CACHE_KB = 2000;

/** 驱逐/关闭一个读连接：先 checkpoint 合并 WAL，再关闭。失败静默（连接可能已损坏）。 */
function disposeDb(db: Database.Database): void {
  try {
    if (db.open) {
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.close();
    }
  } catch {
    /* best-effort：连接可能已被关闭或文件已删 */
  }
}

/**
 * 读连接 LRU 池（lru-cache，MIT）：热 wiki 连接常驻、冷 wiki 被驱逐。
 * 驱逐（超出 max）与显式 `delete`（wiki 删除）都会触发 `dispose` → checkpoint + close。
 */
const readPool = new LRUCache<string, Database.Database>({
  max: POOL_MAX,
  dispose: (db) => disposeDb(db),
});

/** 每个连接打开时统一设置的 pragma（设计 §4.2）。 */
function applyPragmas(db: Database.Database): void {
  db.pragma("journal_mode = WAL"); // 多读单写；search 期间 ingest 不阻塞读
  db.pragma("synchronous = NORMAL"); // WAL 下安全且快
  db.pragma(`cache_size = -${CACHE_KB}`); // 每连接 page cache 上限（负数=KB）
  db.pragma("busy_timeout = 5000"); // 写锁最多等 5s，避免偶发 SQLITE_BUSY
}

/** 建 4 张表（幂等）。仅在 initIndexDb（wiki 显式创建）时调用。 */
function initSchema(db: Database.Database): void {
  // ① BM25：FTS5 虚拟表。存预分词后的空格 token 串，中文 bigram 逻辑留在 JS tokenize()，
  //    FTS5 用 unicode61 仅按空格/标点切（与 __tests__/bm25-comparison 验证过的配置一致）。
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(
       page_id UNINDEXED,
       title_tok,
       content_tok,
       tokenize = 'unicode61 remove_diacritics 0'
     );`,
  );

  // ② 页元数据（搜索结果返回用，不含正文；正文在磁盘 .md）。
  db.exec(
    `CREATE TABLE IF NOT EXISTS page_meta (
       page_id   TEXT PRIMARY KEY,
       title     TEXT,
       type      TEXT,
       rel_path  TEXT,
       snippet   TEXT
     );`,
  );

  // ③ 图谱有向边（多跳 BFS 用；查询时读进内存构建小图，图谱数据小）。
  db.exec(
    `CREATE TABLE IF NOT EXISTS graph_edge (
       source_id TEXT NOT NULL,
       target_id TEXT NOT NULL,
       PRIMARY KEY (source_id, target_id)
     );`,
  );

  // ④ Source 管理表（003：源文件一等实体）。DDL 本轮建好保持 schema 稳定，
  //    读写方法（readSources/writeSource/markIngested/deleteSource）在 003 阶段补齐。
  db.exec(
    `CREATE TABLE IF NOT EXISTS source (
       filename          TEXT PRIMARY KEY,
       sha256            TEXT NOT NULL,
       size              INTEGER NOT NULL,
       status            TEXT NOT NULL,
       created_at        TEXT NOT NULL,
       updated_at        TEXT NOT NULL,
       last_modified_by  TEXT,
       ingested_at       TEXT,
       ingest_error      TEXT
     );`,
  );
}

function dbPath(wikiDir: string): string {
  return join(wikiDir, "index.db");
}

/**
 * ★ 显式建库：在 wiki 创建接口里调一次，建好 4 张表。幂等（IF NOT EXISTS）。
 * 此后 getReadDb / withWriteDb 只打开已存在的库、不建表。
 */
export function initIndexDb(wikiDir: string): void {
  const db = new Database(dbPath(wikiDir));
  applyPragmas(db);
  try {
    initSchema(db);
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

/**
 * 读连接（search/graph）：走池、复用。库必须已由 initIndexDb 建好。
 * 库不存在 → 抛错（视为"wiki 未正确创建/数据损坏"，不静默 lazy 建）。
 */
export function getReadDb(wikiId: string, wikiDir: string): Database.Database {
  let db = readPool.get(wikiId);
  if (!db || !db.open) {
    const path = dbPath(wikiDir);
    if (!existsSync(path)) {
      throw new Error(`index.db missing (wiki not created?): ${wikiId}`);
    }
    db = new Database(path, { readonly: false });
    applyPragmas(db);
    readPool.set(wikiId, db);
  }
  return db;
}

/**
 * 写连接（ingest/sync/rawWrite）：独立创建，事务内完成后 checkpoint + close，不进池。
 * `fn` 内的重建（FTS5 + graph_edge + page_meta + source）在同一事务里原子完成。
 */
export function withWriteDb<T>(wikiDir: string, fn: (db: Database.Database) => T): T {
  const path = dbPath(wikiDir);
  if (!existsSync(path)) {
    throw new Error(`index.db missing (wiki not created?): ${wikiDir}`);
  }
  const db = new Database(path);
  applyPragmas(db);
  try {
    const out = db.transaction(fn)(db);
    // Checkpoint is durability-only. The transaction is already committed;
    // SQLITE_BUSY (lingering readers) must not fail ingest after LLM work.
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      /* WAL remains; next open recovers. */
    }
    return out;
  } finally {
    db.close();
  }
}

/** wiki 删除：先关读连接（dispose 内部 checkpoint+close），调用方再 rmSync 目录。 */
export function evictWikiDb(wikiId: string): void {
  readPool.delete(wikiId);
}

/** 当前读池中的连接数（测试/可观测用）。 */
export function readPoolSize(): number {
  return readPool.size;
}

// ═══════════════════════════════════════════════════════════════════
// source 表读写（设计 003：源文件一等实体 + 增量抽取）
// ═══════════════════════════════════════════════════════════════════

/** 单个源文件的生命周期状态（文件粒度，与 wiki 粒度的 status 无关）。 */
export type SourceStatus = "uploaded" | "ingested" | "failed";

/** source 表一行（rawLs 返回、增量判断用）。 */
export interface SourceRow {
  filename: string;
  sha256: string;
  size: number;
  status: SourceStatus;
  created_at: string;
  updated_at: string;
  last_modified_by: string | null;
  ingested_at: string | null;
  ingest_error: string | null;
}

/** 计算内容 SHA-256（增量判断与 source 登记共用同一份 sha）。 */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * rawWrite 登记 source（设计 §3.4，先查再更新，非盲 UPSERT）。必须在 withWriteDb 事务内调用。
 * - 新文件 → INSERT，status=uploaded，last_modified_by=创建人；
 * - sha 变化 → UPDATE，**保留 created_at**，重置 uploaded、记最后变更人、清 ingest_error；
 * - sha 未变 → 幂等，什么都不动（相同内容重复上传，方案 a）。
 */
export function upsertSource(
  db: Database.Database,
  entry: { filename: string; sha256: string; size: number; userId?: string | null },
): "created" | "updated" | "unchanged" {
  const now = new Date().toISOString();
  const old = db.prepare("SELECT sha256 FROM source WHERE filename = ?").get(entry.filename) as
    | { sha256: string }
    | undefined;
  if (!old) {
    db.prepare(
      `INSERT INTO source(filename, sha256, size, status, created_at, updated_at, last_modified_by, ingested_at, ingest_error)
       VALUES (?, ?, ?, 'uploaded', ?, ?, ?, NULL, NULL)`,
    ).run(entry.filename, entry.sha256, entry.size, now, now, entry.userId ?? null);
    return "created";
  }
  if (old.sha256 !== entry.sha256) {
    db.prepare(
      `UPDATE source SET sha256 = ?, size = ?, status = 'uploaded', updated_at = ?, last_modified_by = ?, ingest_error = NULL
       WHERE filename = ?`,
    ).run(entry.sha256, entry.size, now, entry.userId ?? null, entry.filename);
    return "updated";
  }
  return "unchanged";
}

/** 读全部 source 行（rawLs），按 filename 排序。 */
export function listSources(db: Database.Database): SourceRow[] {
  return db
    .prepare(
      `SELECT filename, sha256, size, status, created_at, updated_at, last_modified_by, ingested_at, ingest_error
       FROM source ORDER BY filename`,
    )
    .all() as SourceRow[];
}

/** 读 filename → {sha256, status} 映射（增量判断用）。 */
export function readSourceStates(
  db: Database.Database,
): Map<string, { sha256: string; status: SourceStatus }> {
  const rows = db.prepare("SELECT filename, sha256, status FROM source").all() as Array<{
    filename: string;
    sha256: string;
    status: SourceStatus;
  }>;
  const m = new Map<string, { sha256: string; status: SourceStatus }>();
  for (const r of rows) m.set(r.filename, { sha256: r.sha256, status: r.status });
  return m;
}

/** 删除 source 行（rawRm / ingest 时文件已消失）。在事务内调用。 */
export function deleteSources(db: Database.Database, filenames: string[]): void {
  if (filenames.length === 0) return;
  const stmt = db.prepare("DELETE FROM source WHERE filename = ?");
  for (const fn of filenames) stmt.run(fn);
}

/**
 * ingest 后登记单个源的抽取结果（设计 §3.6 step 6，在索引重建同事务内调用）。
 * - 已有行：只更新 status/ingested_at/ingest_error，**不动** created_at/updated_at/sha256/size
 *   （sha 由 rawWrite 维护、内容未变；updated_at 表示"内容变更"，抽取不算内容变更）；
 * - 无行（源文件未经 rawWrite 直接落盘）：以磁盘现值 INSERT（created_at=updated_at=now）。
 * ok=true → ingested + ingested_at；ok=false → failed + ingest_error。
 */
export function recordSourceIngestResult(
  db: Database.Database,
  entry: { filename: string; sha256: string; size: number; ok: boolean; error?: string | null },
): void {
  const now = new Date().toISOString();
  const status: SourceStatus = entry.ok ? "ingested" : "failed";
  const ingestedAt = entry.ok ? now : null;
  const ingestError = entry.ok ? null : (entry.error ?? "unknown").slice(0, 500);
  const exists = db.prepare("SELECT 1 FROM source WHERE filename = ?").get(entry.filename);
  if (exists) {
    db.prepare(
      "UPDATE source SET status = ?, ingested_at = ?, ingest_error = ? WHERE filename = ?",
    ).run(status, ingestedAt, ingestError, entry.filename);
  } else {
    db.prepare(
      `INSERT INTO source(filename, sha256, size, status, created_at, updated_at, last_modified_by, ingested_at, ingest_error)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(entry.filename, entry.sha256, entry.size, status, now, now, ingestedAt, ingestError);
  }
}

/**
 * 增量分类（设计 §3.6 step 3，纯函数，便于单测）：
 * 对比"磁盘源文件"与"source 表上次状态"，判定各文件的去向。
 * - toIngest：新增 || 未成功抽取（status≠ingested，含 uploaded/failed）|| sha 变化 → 需抽取；
 * - skipped ：status=ingested 且 sha 未变 → 跳过 LLM（省 token）；
 * - deleted ：表中有但磁盘已无 → 待级联删除 + 删 source 行。
 */
export function classifySources(
  disk: Array<{ filename: string; sha256: string }>,
  oldStates: Map<string, { sha256: string; status: SourceStatus }>,
): { toIngest: string[]; skipped: string[]; deleted: string[] } {
  const diskNames = new Set(disk.map((d) => d.filename));
  const deleted = [...oldStates.keys()].filter((fn) => !diskNames.has(fn));
  const toIngest: string[] = [];
  const skipped: string[] = [];
  for (const d of disk) {
    const prev = oldStates.get(d.filename);
    if (!prev || prev.status !== "ingested" || prev.sha256 !== d.sha256) toIngest.push(d.filename);
    else skipped.push(d.filename);
  }
  return { toIngest, skipped, deleted };
}

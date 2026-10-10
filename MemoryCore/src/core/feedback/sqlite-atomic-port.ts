/** SQLite-only, synchronous sidecar port. No extraction, embeddings or Gateway writes.
 * Intended target: MemoryCore/src/core/feedback/sqlite-atomic-port.ts.
 * The caller owns production authorization and the evidence-chain state machine.
 */
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { VectorStore as SqliteMemoryStore, tokenizeForFts } from "../store/sqlite/memory-store.js";
import type { MemoryRecord, L1RecordRow } from "../store/types.js";

export interface AtomicMemoryScope {
  teamId: string;
  userId: string;
  agentId: string;
  taskId: string;
}
export interface AtomicMemoryResult {
  status: "applied" | "conflict";
  record?: L1RecordRow;
  vectorInvalidated?: boolean;
}
export const ATOMIC_PORT_LIMITS = Object.freeze({
  records: 10_000, ftsRows: 20_000, contentChars: 8_192,
  contentBytes: 32_768, metadataBytes: 8_192, timestamps: 64,
});

const ROW_COLUMNS = ["record_id", "content", "type", "priority", "scene_name",
  "session_key", "session_id", "team_id", "task_id", "user_id", "agent_id",
  "version", "timestamp_str", "timestamp_start", "timestamp_end", "created_time",
  "updated_time", "metadata_json"];
const FTS_COLUMNS = ["content", "content_original", "record_id", "type", "priority",
  "scene_name", "session_key", "session_id", "team_id", "task_id", "user_id",
  "agent_id", "version", "timestamp_str", "timestamp_start", "timestamp_end", "metadata_json"];
const WHERE_EXACT = "record_id = ? AND team_id = ? AND user_id = ? AND agent_id = ? AND task_id = ?";
const TYPES = new Set(["persona", "episodic", "instruction", "work_fact", "work_task", "work_method", "work_artifact"]);

export class AtomicMemoryPortError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "AtomicMemoryPortError"; }
}
function fail(code: string): never { throw new AtomicMemoryPortError(code); }
function boundedString(value: unknown, bytes: number, allowEmpty = false): asserts value is string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.includes("\0") || Buffer.byteLength(value, "utf8") > bytes) {
    fail("atomic_port_invalid_input");
  }
}
function validateScope(scope: AtomicMemoryScope): void {
  if (!scope || typeof scope !== "object") fail("atomic_port_invalid_scope");
  for (const key of ["teamId", "userId", "agentId"] as const) {
    boundedString(scope[key], 256);
    if (scope[key].trim() !== scope[key] || scope[key].toLowerCase() === "default") fail("atomic_port_invalid_scope");
  }
  boundedString(scope.taskId, 256, true);
}
function exactArgs(scope: AtomicMemoryScope, id: string): SQLInputValue[] {
  validateScope(scope); boundedString(id, 256);
  return [id, scope.teamId, scope.userId, scope.agentId, scope.taskId];
}
function version(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) fail("atomic_port_invalid_version");
}
function isThenable(value: unknown): boolean {
  return value !== null && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function";
}
function metadataJson(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("atomic_port_invalid_input");
  const seen = new Set<object>();
  const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (queue.length) {
    const next = queue.pop()!;
    if (++visited > 256 || next.depth > 8) fail("atomic_port_invalid_input");
    const item = next.value;
    if (item === null || typeof item === "boolean") continue;
    if (typeof item === "number") { if (!Number.isFinite(item)) fail("atomic_port_invalid_input"); continue; }
    if (typeof item === "string") { boundedString(item, ATOMIC_PORT_LIMITS.metadataBytes, true); continue; }
    if (typeof item !== "object" || seen.has(item)) fail("atomic_port_invalid_input");
    seen.add(item);
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) fail("atomic_port_invalid_input");
    if (Array.isArray(item) && item.length > 64) fail("atomic_port_invalid_input");
    let keys = 0;
    for (const key in item) {
      if (!Object.hasOwn(item, key)) fail("atomic_port_invalid_input");
      if (++keys > 256 || queue.length + visited >= 256) fail("atomic_port_invalid_input");
      boundedString(key, 256, true);
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (descriptor.get || descriptor.set) fail("atomic_port_invalid_input");
      queue.push({ value: descriptor.value, depth: next.depth + 1 });
    }
  }
  const serialized = JSON.stringify(value);
  boundedString(serialized, ATOMIC_PORT_LIMITS.metadataBytes);
  return serialized;
}

export class SqliteAtomicMemoryPort {
  private readonly db: DatabaseSync;
  private depth = 0;
  private rollbackOnly = false;
  private hasVectorTable = false;

  constructor(private readonly store: SqliteMemoryStore) {
    this.db = store.getRawDb();
    this.checkSchema();
  }

  /** Ledger owners must use this exact handle, never a second connection. */
  getRawDb(): DatabaseSync { return this.db; }

  /** All callbacks must be synchronous. A nested failure poisons the outer transaction,
   * even if its caller catches it. Use this same port instance for ledger + memory CAS.
   * Do not call store.upsertL1/deleteL1 here: those begin their own transactions.
   */
  atomic<T>(fn: () => T): T {
    if (typeof fn !== "function" || fn.constructor?.name === "AsyncFunction") {
      if (this.depth) this.rollbackOnly = true;
      fail("atomic_port_async_forbidden");
    }
    if (this.depth) {
      this.depth++;
      try {
        const result = fn();
        if (isThenable(result)) fail("atomic_port_async_forbidden");
        return result;
      } catch (error) {
        this.rollbackOnly = true;
        throw error instanceof AtomicMemoryPortError ? error : new AtomicMemoryPortError("atomic_port_operation_failed");
      } finally { this.depth--; }
    }
    let begun = false;
    try {
      this.checkSchema();
      this.db.exec("BEGIN IMMEDIATE"); begun = true;
      this.depth = 1; this.rollbackOnly = false;
      this.checkCapacity();
      const result = fn();
      if (isThenable(result)) fail("atomic_port_async_forbidden");
      if (this.rollbackOnly) fail("atomic_port_transaction_poisoned");
      this.checkCapacity();
      this.db.exec("COMMIT"); begun = false;
      return result;
    } catch (error) {
      if (begun) { try { this.db.exec("ROLLBACK"); } catch { /* fixed error below */ } }
      throw error instanceof AtomicMemoryPortError ? error : new AtomicMemoryPortError("atomic_port_operation_failed");
    } finally { this.depth = 0; this.rollbackOnly = false; }
  }

  getExact(scope: AtomicMemoryScope, id: string): L1RecordRow | null {
    const args = exactArgs(scope, id);
    try {
      if (this.store.isDegraded()) fail("atomic_port_store_unavailable");
      return (this.db.prepare(`SELECT ${ROW_COLUMNS.join(",")} FROM l1_records WHERE ${WHERE_EXACT} LIMIT 1`).get(...args) as unknown as L1RecordRow | undefined) ?? null;
    } catch (error) { throw error instanceof AtomicMemoryPortError ? error : new AtomicMemoryPortError("atomic_port_read_failed"); }
  }

  createIfAbsent(scope: AtomicMemoryScope, record: MemoryRecord): AtomicMemoryResult {
    return this.atomic(() => {
      const row = this.makeRow(scope, record);
      if (record.version !== 1) fail("atomic_port_invalid_version");
      // PK is global. Do not return another scope's row on an ID collision.
      if (this.db.prepare("SELECT 1 FROM l1_records WHERE record_id = ? LIMIT 1").get(record.id)) return { status: "conflict" };
      const values = ROW_COLUMNS.map((key) => row[key as keyof L1RecordRow]) as SQLInputValue[];
      this.db.prepare(`INSERT INTO l1_records (${ROW_COLUMNS.join(",")}) VALUES (${ROW_COLUMNS.map(() => "?").join(",")})`).run(...values);
      const vectorInvalidated = this.removeVector(record.id);
      this.writeFts(row);
      return { status: "applied", record: this.mustRead(scope, record.id), vectorInvalidated };
    });
  }

  updateIfVersion(scope: AtomicMemoryScope, id: string, expectedVersion: number, record: MemoryRecord): AtomicMemoryResult {
    return this.atomic(() => {
      const args = exactArgs(scope, id); version(expectedVersion);
      const row = this.makeRow(scope, record);
      if (record.id !== id || record.version !== expectedVersion + 1) fail("atomic_port_invalid_version");
      const current = this.getExact(scope, id);
      if (!current || current.version !== expectedVersion) return { status: "conflict" };
      // The versioned evidence event belongs in the sidecar; preserve original provenance.
      if (record.createdAt !== current.created_time || record.sessionId !== current.session_id || record.sessionKey !== current.session_key) fail("atomic_port_immutable_provenance");
      // A content correction does not shorten the original evidence time range.
      row.timestamp_str = current.timestamp_str;
      row.timestamp_start = current.timestamp_start;
      row.timestamp_end = current.timestamp_end;
      const changes = ROW_COLUMNS.filter((key) => !["record_id", "team_id", "user_id", "agent_id", "task_id"].includes(key));
      const result = this.db.prepare(`UPDATE l1_records SET ${changes.map((key) => `${key} = ?`).join(",")} WHERE ${WHERE_EXACT} AND version = ?`).run(
        ...changes.map((key) => row[key as keyof L1RecordRow]) as SQLInputValue[], ...args, expectedVersion,
      );
      if (Number(result.changes) !== 1) return { status: "conflict" };
      const vectorInvalidated = this.removeVector(id);
      this.writeFts(row);
      return { status: "applied", record: this.mustRead(scope, id), vectorInvalidated };
    });
  }

  deleteIfVersion(scope: AtomicMemoryScope, id: string, expectedVersion: number): AtomicMemoryResult {
    return this.atomic(() => {
      const args = exactArgs(scope, id); version(expectedVersion);
      const result = this.db.prepare(`DELETE FROM l1_records WHERE ${WHERE_EXACT} AND version = ?`).run(...args, expectedVersion);
      if (Number(result.changes) !== 1) return { status: "conflict" };
      this.db.prepare("DELETE FROM l1_fts WHERE record_id = ?").run(id);
      const vectorInvalidated = this.removeVector(id);
      return { status: "applied", vectorInvalidated };
    });
  }

  private mustRead(scope: AtomicMemoryScope, id: string): L1RecordRow {
    const row = this.getExact(scope, id);
    if (!row) fail("atomic_port_readback_failed");
    return row;
  }

  private makeRow(scope: AtomicMemoryScope, record: MemoryRecord): L1RecordRow {
    if (!record || typeof record !== "object") fail("atomic_port_invalid_input");
    exactArgs(scope, record.id);
    if (record.teamId !== scope.teamId || record.userId !== scope.userId || record.agentId !== scope.agentId || record.taskId !== scope.taskId) fail("atomic_port_scope_mismatch");
    boundedString(record.content, ATOMIC_PORT_LIMITS.contentBytes);
    if (record.content.length > ATOMIC_PORT_LIMITS.contentChars) fail("atomic_port_invalid_input");
    if (!TYPES.has(record.type) || !Number.isInteger(record.priority) || record.priority < -1 || record.priority > 100) fail("atomic_port_invalid_input");
    boundedString(record.scene_name, 2048, true);
    boundedString(record.sessionId, 256); boundedString(record.sessionKey, 512);
    boundedString(record.createdAt, 64); boundedString(record.updatedAt, 64);
    if (!Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.updatedAt))) fail("atomic_port_invalid_input");
    version(record.version as number);
    if (!Array.isArray(record.timestamps) || record.timestamps.length > ATOMIC_PORT_LIMITS.timestamps || !Array.isArray(record.source_message_ids) || record.source_message_ids.length > 64) fail("atomic_port_invalid_input");
    for (const ts of record.timestamps) boundedString(ts, 64);
    for (const source of record.source_message_ids) boundedString(source, 256);
    const metadata = metadataJson(record.metadata);
    const sorted = [...record.timestamps].sort();
    return {
      record_id: record.id, content: record.content, type: record.type, priority: record.priority,
      scene_name: record.scene_name, session_key: record.sessionKey, session_id: record.sessionId,
      team_id: scope.teamId, user_id: scope.userId, agent_id: scope.agentId, task_id: scope.taskId,
      version: record.version!, timestamp_str: record.timestamps[0] ?? "",
      timestamp_start: sorted[0] ?? "", timestamp_end: sorted.at(-1) ?? "",
      created_time: record.createdAt, updated_time: record.updatedAt, metadata_json: metadata,
    };
  }

  private writeFts(row: L1RecordRow): void {
    this.db.prepare("DELETE FROM l1_fts WHERE record_id = ?").run(row.record_id);
    const fts: Record<string, SQLInputValue> = { ...row, content_original: row.content, content: tokenizeForFts(row.content) };
    this.db.prepare(`INSERT INTO l1_fts (${FTS_COLUMNS.join(",")}) VALUES (${FTS_COLUMNS.map(() => "?").join(",")})`).run(...FTS_COLUMNS.map((key) => fts[key]));
  }

  private removeVector(id: string): boolean {
    if (!this.hasVectorTable) return false;
    return Number(this.db.prepare("DELETE FROM l1_vec WHERE record_id = ?").run(id).changes) > 0;
  }

  private checkSchema(): void {
    try {
      if (this.store.isDegraded() || !this.store.isFtsAvailable()) fail("atomic_port_store_unavailable");
      for (const [table, columns] of [["l1_records", ROW_COLUMNS], ["l1_fts", FTS_COLUMNS]] as const) {
        const info = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>;
        if (info.length > 128 || columns.some((column) => !info.some((field) => field.name === column))) fail("atomic_port_schema_unsupported");
        if (table === "l1_records" && !info.some((field) => field.name === "record_id" && field.pk === 1)) fail("atomic_port_schema_unsupported");
      }
      const ftsSchema = this.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'l1_fts' AND type = 'table' LIMIT 1").get() as { sql?: string } | undefined;
      if (!ftsSchema?.sql || !/USING\s+fts5\s*\(/i.test(ftsSchema.sql)) fail("atomic_port_schema_unsupported");
      const vec = this.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'l1_vec' AND type = 'table' LIMIT 1").get() as { sql?: string } | undefined;
      this.hasVectorTable = !!vec;
      if (vec && (!vec.sql || !/USING\s+vec0\s*\(/i.test(vec.sql))) fail("atomic_port_schema_unsupported");
      if (this.store.getEmbeddingDimensions() > 0 && !vec) fail("atomic_port_schema_unsupported");
    } catch (error) { throw error instanceof AtomicMemoryPortError ? error : new AtomicMemoryPortError("atomic_port_schema_unsupported"); }
  }

  private checkCapacity(): void {
    // FTS record_id is UNINDEXED upstream. Bound the independent pilot store,
    // so DELETE-by-ID cannot become an unlimited full-table scan.
    for (const [table, cap] of [["l1_records", ATOMIC_PORT_LIMITS.records], ["l1_fts", ATOMIC_PORT_LIMITS.ftsRows]] as const) {
      if (this.db.prepare(`SELECT 1 FROM ${table} LIMIT 1 OFFSET ?`).get(cap)) fail("atomic_port_capacity_exceeded");
    }
  }
}

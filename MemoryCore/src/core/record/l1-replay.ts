import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { VectorStore } from "../store/sqlite/memory-store.js";
import type { MemoryRecord } from "./l1-writer.js";

/** Every dimension is explicit; an empty taskId means the empty task, never all tasks. */
export interface ReplayScope {
  instanceId: string;
  teamId: string;
  userId: string;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  taskId: string;
}
export interface ReplaySelection { scope: ReplayScope; from?: string; to?: string; maxRows?: number }
export interface ReplaySource {
  record_id: string;
  message_text: string;
  role: string;
  recorded_at: string;
  timestamp: number;
  session_key: string;
  session_id: string;
  team_id: string;
  user_id: string;
  agent_id: string;
  task_id: string;
}
const candidateSchema = z.object({
  content: z.string().trim().min(1),
  type: z.enum(["persona", "episodic", "instruction", "work_fact", "work_task", "work_method", "work_artifact"]),
  priority: z.number().int().min(-1).max(100),
  scene_name: z.string().trim().min(1),
  source_message_ids: z.array(z.string().min(1)).min(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type ReplayCandidate = z.infer<typeof candidateSchema>;
export interface ReplayReceipt {
  batchId: string;
  indexMode: "fts-only";
  scope: ReplayScope;
  sourceIds: string[];
  sourceDigest: string;
  completedAt: string;
  decisions: { action: "store" | "skip_exact"; recordId: string; sourceIds: string[] }[];
}
interface Batch {
  batch_id: string;
  inputs_json: string;
  output_json: string | null;
  receipt_json: string | null;
}

const columns = ["team_id", "user_id", "agent_id", "session_key", "session_id", "task_id"];
const dimensions = ["teamId", "userId", "agentId", "sessionKey", "sessionId", "taskId"] as const;
const whereScope = columns.map((c) => `${c} = ?`).join(" AND ");
const values = (scope: ReplayScope) => dimensions.map((key) => scope[key]);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
const scopeKey = (scope: ReplayScope) => digest([scope.instanceId, ...values(scope)]);
const hasJournal = (db: DatabaseSync) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'l1_replay_batches'").get();

function validateSelection(selection: ReplaySelection): void {
  for (const key of ["instanceId", ...dimensions] as const) {
    const value = selection.scope?.[key];
    if (typeof value !== "string" || (key !== "taskId" && !value.trim())) throw new Error(`Explicit ${key} is required`);
  }
  for (const value of [selection.from, selection.to]) {
    if (value !== undefined && !z.iso.datetime({ offset: true }).safeParse(value).success) {
      throw new Error("Replay dates must be ISO timestamps with a timezone");
    }
  }
  if (selection.from && selection.to && Date.parse(selection.from) > Date.parse(selection.to)) throw new Error("Invalid date range");
  const limit = selection.maxRows ?? 1000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error("maxRows must be between 1 and 10000");
}

function selectSources(db: DatabaseSync, selection: ReplaySelection): ReplaySource[] {
  validateSelection(selection);
  // julianday compares instants, including older rows that use offsets instead of Z.
  const rows = db.prepare(`SELECT record_id, message_text, role, recorded_at, timestamp,
    session_key, session_id, team_id, user_id, agent_id, task_id FROM l0_conversations
    WHERE ${whereScope} AND (? IS NULL OR julianday(recorded_at) >= julianday(?))
    AND (? IS NULL OR julianday(recorded_at) <= julianday(?))
    ORDER BY julianday(recorded_at), record_id LIMIT ?`).all(
    ...values(selection.scope), selection.from ?? null, selection.from ?? null,
    selection.to ?? null, selection.to ?? null, (selection.maxRows ?? 1000) + 1,
  ) as unknown as ReplaySource[];
  if (rows.length > (selection.maxRows ?? 1000)) throw new Error("Replay range exceeds row limit; narrow the time range or increase maxRows");
  for (const row of rows) {
    if (!Number.isFinite(Date.parse(row.recorded_at))) throw new Error(`Invalid source timestamp: ${row.record_id}`);
  }
  return rows;
}

function membership(db: DatabaseSync, key: string, id: string) {
  return db.prepare(`SELECT s.source_hash, b.* FROM l1_replay_sources s
    JOIN l1_replay_batches b ON b.batch_id = s.batch_id WHERE s.scope_key = ? AND s.record_id = ?`)
    .get(key, id) as unknown as (Batch & { source_hash: string }) | undefined;
}

/** Read-only: safe to call with DatabaseSync({ readOnly: true }), without migrations. */
export function planReplay(db: DatabaseSync, selection: ReplaySelection) {
  const rows = selectSources(db, selection);
  const key = scopeKey(selection.scope);
  const journal = hasJournal(db);
  let alreadyComplete = 0;
  let fresh = 0;
  const pending = new Set<string>();
  const selectedIds = new Set(rows.map((r) => r.record_id));
  for (const row of rows) {
    const saved = journal ? membership(db, key, row.record_id) : undefined;
    if (!saved) { fresh++; continue; }
    if (saved.source_hash !== digest(row)) throw new Error(`Source changed since reservation: ${row.record_id}`);
    if (saved.receipt_json) alreadyComplete++;
    else {
      const inputs = JSON.parse(saved.inputs_json) as ReplaySource[];
      if (inputs.some((r) => !selectedIds.has(r.record_id))) throw new Error("Incomplete batch overlaps this range; retry its original range");
      pending.add(saved.batch_id);
    }
  }
  return { selected: rows.length, alreadyComplete, pending: rows.length - alreadyComplete,
    batches: pending.size + Math.ceil(fresh / 10), sourceIds: rows.map((r) => r.record_id) };
}

function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const result = work(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

function initJournal(db: DatabaseSync): void {
  // A crash must not leave only one of the two journal tables installed.
  transaction(db, () => db.exec(`CREATE TABLE IF NOT EXISTS l1_replay_batches (
    batch_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, inputs_json TEXT NOT NULL,
    output_json TEXT, receipt_json TEXT);
    CREATE TABLE IF NOT EXISTS l1_replay_sources (
      scope_key TEXT NOT NULL, record_id TEXT NOT NULL, source_hash TEXT NOT NULL,
      batch_id TEXT NOT NULL REFERENCES l1_replay_batches(batch_id), PRIMARY KEY(scope_key, record_id));`));
}

export function validateCandidates(output: unknown, sources: ReplaySource[]): ReplayCandidate[] {
  const candidates = z.array(candidateSchema).max(1000).parse(output);
  const allowed = new Set(sources.map((r) => r.record_id));
  for (const candidate of candidates) {
    if (candidate.source_message_ids.some((id) => !allowed.has(id))) throw new Error("Extraction contains an unknown source ID");
  }
  return candidates;
}

/**
 * Maintenance-only SQLite recovery. Reservations freeze batches before calling the model;
 * the first preparation wins. L1, FTS and the completion receipt commit together. The
 * online extraction cursor and original L0 rows are never modified.
 */
export async function replayL1(
  store: VectorStore, selection: ReplaySelection,
  extract: (sources: ReplaySource[]) => Promise<ReplayCandidate[]>,
) {
  const db = store.getRawDb();
  const before = planReplay(db, selection);
  if (store.isDegraded()) throw new Error("Cannot replay into a degraded store");
  initJournal(db);
  const key = scopeKey(selection.scope);
  const batchIds = transaction(db, () => {
    planReplay(db, selection); // Recheck reservations after acquiring the write lock.
    const rows = selectSources(db, selection);
    const ids = new Set<string>();
    const fresh: ReplaySource[] = [];
    for (const row of rows) {
      const saved = membership(db, key, row.record_id);
      if (saved) ids.add(saved.batch_id); else fresh.push(row);
    }
    for (let start = 0; start < fresh.length; start += 10) {
      const inputs = fresh.slice(start, start + 10);
      const batchId = digest([key, inputs]);
      db.prepare("INSERT INTO l1_replay_batches(batch_id, scope_key, inputs_json) VALUES (?, ?, ?)")
        .run(batchId, key, JSON.stringify(inputs));
      for (const input of inputs) db.prepare("INSERT INTO l1_replay_sources VALUES (?, ?, ?, ?)")
        .run(key, input.record_id, digest(input), batchId);
      ids.add(batchId);
    }
    return [...ids];
  });
  const receipts: ReplayReceipt[] = [];
  for (const batchId of batchIds) {
    const readBatch = () => db.prepare("SELECT * FROM l1_replay_batches WHERE batch_id = ?").get(batchId) as unknown as Batch;
    let batch = readBatch();
    const inputs = JSON.parse(batch.inputs_json) as ReplaySource[];
    if (!batch.receipt_json && batch.output_json === null) {
      const output = validateCandidates(await extract(structuredClone(inputs)), inputs);
      // A concurrent caller may have prepared or committed while the model was running.
      db.prepare("UPDATE l1_replay_batches SET output_json = ? WHERE batch_id = ? AND output_json IS NULL AND receipt_json IS NULL")
        .run(JSON.stringify(output), batchId);
    }
    const receipt = transaction(db, () => {
      batch = readBatch();
      if (batch.receipt_json) return JSON.parse(batch.receipt_json) as ReplayReceipt;
      for (const input of inputs) {
        const current = db.prepare(`SELECT record_id, message_text, role, recorded_at, timestamp,
          session_key, session_id, team_id, user_id, agent_id, task_id FROM l0_conversations WHERE record_id = ?`)
          .get(input.record_id);
        if (digest(current) !== digest(input)) throw new Error(`Source changed or deleted: ${input.record_id}`);
      }
      const candidates = validateCandidates(JSON.parse(batch.output_json!), inputs);
      const receipt: ReplayReceipt = { batchId, indexMode: "fts-only", scope: selection.scope,
        sourceIds: inputs.map((r) => r.record_id), sourceDigest: digest(inputs),
        completedAt: new Date().toISOString(), decisions: [] };
      for (const [index, candidate] of candidates.entries()) {
        const existing = db.prepare(`SELECT record_id FROM l1_records WHERE ${whereScope}
          AND content = ? AND type = ? AND scene_name = ? ORDER BY record_id LIMIT 1`)
          .get(...values(selection.scope), candidate.content, candidate.type, candidate.scene_name);
        if (existing) {
          receipt.decisions.push({ action: "skip_exact", recordId: String(existing.record_id), sourceIds: candidate.source_message_ids });
          continue;
        }
        const recordId = `replay_${batchId}_${index}`;
        const timestamps = inputs.filter((r) => candidate.source_message_ids.includes(r.record_id)).map((r) => r.recorded_at);
        const record: MemoryRecord = { ...candidate, ...selection.scope, id: recordId, timestamps,
          createdAt: receipt.completedAt, updatedAt: receipt.completedAt, version: 1,
          metadata: { ...candidate.metadata, source_message_ids: candidate.source_message_ids,
            replay_batch_id: batchId } as MemoryRecord["metadata"] };
        if (!store.upsertL1(record, undefined)) throw new Error(`L1 write failed for replay batch ${batchId}`);
        // The normal ingestion API tolerates FTS failures; recovery must fail closed.
        if (!db.prepare("SELECT 1 FROM l1_fts WHERE record_id = ? AND content_original = ?").get(recordId, candidate.content)) {
          throw new Error(`FTS write failed for replay batch ${batchId}`);
        }
        receipt.decisions.push({ action: "store", recordId, sourceIds: candidate.source_message_ids });
      }
      db.prepare("UPDATE l1_replay_batches SET receipt_json = ? WHERE batch_id = ?").run(JSON.stringify(receipt), batchId);
      return receipt;
    });
    receipts.push(receipt);
  }
  return { ...before, completed: planReplay(db, selection).alreadyComplete, receipts };
}

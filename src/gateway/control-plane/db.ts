/**
 * Control-plane SQLite (tz-09 Ф1).
 *
 * Run/attempt/oplog state lives in its OWN database
 * (`<dataDir>/.metadata/control-plane.db`), never in `vectors.db`: the memory
 * store is what apply mutates, and the record of an apply must survive a
 * store that is being rewritten, restored from backup, or reindexed.
 *
 * Schema is created on open and is additive-only — a column is added, never
 * repurposed, so an older gateway keeps reading the same rows.
 */
import fs from "node:fs";
import path from "node:path";
import { openWritableSqlite, type WritableSqlite } from "../http-utils.js";

export type { WritableSqlite };

const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS runs (
     runId TEXT PRIMARY KEY,
     assignmentId TEXT NOT NULL DEFAULT '',
     roleId TEXT NOT NULL,
     roleVersion TEXT NOT NULL DEFAULT '',
     contractHash TEXT NOT NULL DEFAULT '',
     contractJson TEXT NOT NULL DEFAULT '',
     binding TEXT NOT NULL DEFAULT '',
     hostSessionRef TEXT NOT NULL DEFAULT '',
     inputDigest TEXT NOT NULL DEFAULT '',
     candidateDigest TEXT,
     verdictDigest TEXT,
     state TEXT NOT NULL,
     fence INTEGER NOT NULL DEFAULT 1,
     leaseOwner TEXT,
     leaseExpiresAt INTEGER,
     errorClass TEXT,
     criticReceipt TEXT,
     applyReceipt TEXT,
     sessionPath TEXT NOT NULL DEFAULT '',
     scratchPath TEXT NOT NULL DEFAULT '',
     logPath TEXT NOT NULL DEFAULT '',
     reason TEXT NOT NULL DEFAULT '',
     createdAt TEXT NOT NULL,
     updatedAt TEXT NOT NULL,
     finishedAt TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS runs_created_idx ON runs (createdAt DESC)`,
  `CREATE TABLE IF NOT EXISTS attempts (
     attemptId TEXT PRIMARY KEY,
     runId TEXT NOT NULL,
     kind TEXT NOT NULL,
     outcome TEXT,
     detail TEXT,
     startedAt TEXT NOT NULL,
     finishedAt TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS attempts_run_idx ON attempts (runId)`,
  `CREATE TABLE IF NOT EXISTS oplog (
     operationId TEXT PRIMARY KEY,
     runId TEXT NOT NULL,
     opIndex INTEGER NOT NULL,
     opType TEXT NOT NULL,
     state TEXT NOT NULL,
     targetKey TEXT NOT NULL DEFAULT '',
     payloadDigest TEXT NOT NULL DEFAULT '',
     updatedAt TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS oplog_run_idx ON oplog (runId, opIndex)`,
];

export function controlPlanePath(dataDir: string): string {
  return path.join(dataDir, ".metadata", "control-plane.db");
}

/** Open (creating if needed) and migrate. Callers own `close()`. */
export function openControlPlane(dataDir: string): WritableSqlite {
  const file = controlPlanePath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = openWritableSqlite(file);
  for (const stmt of SCHEMA) db.prepare(stmt).run();
  return db;
}

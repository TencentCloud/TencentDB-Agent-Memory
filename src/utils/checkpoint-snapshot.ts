/**
 * Build a `CheckpointRecalculateSnapshot` from ground-truth storage.
 *
 * Primary use cases (see the checkpoint drift issue):
 *   - Manual JSONL / DB trimming  → run after the trim, cursors clamp back.
 *   - Historical rollback         → snapshot max < cursor → cursor rewinds.
 *   - Ad-hoc "recalculate" CLI    → open the DB read-only, build, recalculate.
 *
 * The builder talks to the SQLite file directly (`node:sqlite`, read-only) —
 * no VectorStore / embedding machinery is needed, so it also works while the
 * plugin is degraded or offline.
 */

import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";

import type { CheckpointRecalculateSnapshot } from "./checkpoint.js";

const require = createRequire(import.meta.url);

/** Same loading strategy as sqlite.ts (node:sqlite is experimental on Node 22). */
function requireNodeSqlite(): typeof import("node:sqlite") {
  return require("node:sqlite") as typeof import("node:sqlite");
}

/** Default DB file name used by the SQLite VectorStore (`<dataDir>/vectors.db`). */
export const SQLITE_DB_FILENAME = "vectors.db";

/**
 * Build a recalculate snapshot from the SQLite memory store.
 *
 * Returns `undefined` when the DB file does not exist or cannot be read —
 * callers should treat that as "no ground truth available" and skip the
 * recalculation (never recalculate against an empty guess).
 *
 * The snapshot is always exhaustive (full-table GROUP BY), so sessions that
 * disappeared from the DB entirely will have their checkpoint cursors reset.
 */
export function buildSnapshotFromSqlite(
  dataDir: string,
  logger?: { warn?(msg: string): void },
): CheckpointRecalculateSnapshot | undefined {
  const dbPath = path.join(dataDir, SQLITE_DB_FILENAME);
  if (!fs.existsSync(dbPath)) {
    logger?.warn?.(`[checkpoint-snapshot] DB not found, snapshot skipped: ${dbPath}`);
    return undefined;
  }

  let db: DatabaseSync | undefined;
  try {
    const { DatabaseSync: DbSync } = requireNodeSqlite();
    db = new DbSync(dbPath, { readOnly: true });

    const l0MessageCount = (
      db.prepare("SELECT COUNT(*) AS cnt FROM l0_conversations").get() as { cnt: number }
    ).cnt;
    const l1RecordCount = (
      db.prepare("SELECT COUNT(*) AS cnt FROM l1_records").get() as { cnt: number }
    ).cnt;

    // Per-session watermarks. recorded_at / updated_time are ISO 8601 UTC
    // strings, so MAX() over them is chronologically correct.
    const sessions: NonNullable<CheckpointRecalculateSnapshot["sessions"]> = {};

    const l0Rows = db
      .prepare("SELECT session_key AS k, MAX(recorded_at) AS maxRecordedAt FROM l0_conversations GROUP BY session_key")
      .all() as Array<{ k: string; maxRecordedAt: string | null }>;
    for (const row of l0Rows) {
      if (!row.k) continue;
      const ms = row.maxRecordedAt ? Date.parse(row.maxRecordedAt) : NaN;
      sessions[row.k] = {
        ...sessions[row.k],
        ...(Number.isFinite(ms) ? { l0MaxRecordedAtMs: ms } : {}),
      };
    }

    const l1Rows = db
      .prepare("SELECT session_key AS k, MAX(updated_time) AS maxUpdatedAt FROM l1_records GROUP BY session_key")
      .all() as Array<{ k: string; maxUpdatedAt: string | null }>;
    for (const row of l1Rows) {
      if (!row.k || !row.maxUpdatedAt) continue;
      sessions[row.k] = { ...sessions[row.k], l1MaxUpdatedAtIso: row.maxUpdatedAt };
    }

    return {
      l0MessageCount,
      l1RecordCount,
      sessions,
      exhaustiveSessions: true,
    };
  } catch (err) {
    logger?.warn?.(
      `[checkpoint-snapshot] Failed to build snapshot (skipped): ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      /* non-fatal */
    }
  }
}

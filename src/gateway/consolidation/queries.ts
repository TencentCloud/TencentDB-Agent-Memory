/**
 * Read L1 records + advance the consolidation checkpoint.
 *
 * queryRecentRecords: fresh-tail sweep (day) or full-store sweep (night).
 *
 * Split from runner.ts to keep that file ≤150 lines; the checkpoint advance
 * itself moved on to checkpoint-advance.ts for the same reason (tz-03a).
 */

import path from "node:path";
import { openReadonlySqlite } from "../http-utils.js";
import { type RecordEntry } from "./diff-builder.js";
import { NIGHT_SWEEP_LIMIT } from "./types.js";
import type { OrchestratorContext } from "./context.js";

/** Fresh L1 records (updated/created >= cursor), oldest-first, capped. */
export function queryRecentRecords(
  ctx: OrchestratorContext,
  cursorIso: string,
  limit: number,
  fullStore = false,
): RecordEntry[] {
  const dbPath = path.join(ctx.dataDir, "vectors.db");
  try {
    const db = openReadonlySqlite(dbPath);
    try {
      // Night (fullStore): sweep the WHOLE store oldest-first (no cursor) —
      // cleanup/dup-scan sees everything. Bound by NIGHT_SWEEP_LIMIT (25_000).
      const sql = fullStore
        ? "SELECT record_id, type, updated_time, created_time, content FROM l1_records " +
          "ORDER BY created_time ASC, record_id ASC LIMIT ?"
        : "SELECT record_id, type, updated_time, created_time, content FROM l1_records " +
          "WHERE (updated_time != '' AND updated_time >= ?) OR (created_time >= ?) " +
          "ORDER BY updated_time ASC LIMIT ?";
      const rows = fullStore
        ? (db.prepare(sql).all(NIGHT_SWEEP_LIMIT) as Array<
            Record<string, unknown>
          >)
        : (db
            .prepare(sql)
            .all(
              cursorIso || "1970-01-01T00:00:00.000Z",
              cursorIso || "1970-01-01T00:00:00.000Z",
              limit,
            ) as Array<Record<string, unknown>>);
      return rows.map((r) => ({
        id: String(r.record_id ?? ""),
        type: String(r.type ?? ""),
        updatedAt: String(r.updated_time ?? ""),
        // Date-anchoring anchor: original creation time (night keeper
        // rewrites relative dates against record metadata, not run-now).
        createdAt: String(r.created_time ?? ""),
        content: String(r.content ?? "").slice(0, 500),
      }));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

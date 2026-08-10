/**
 * Read L1 records + advance the consolidation checkpoint.
 *
 * queryRecentRecords: fresh-tail sweep (day) or full-store sweep (night).
 * advanceCheckpoint: cursor update + per-role stat rollup.
 *
 * Split from runner.ts to keep that file ≤150 lines.
 */

import path from "node:path";
import { openReadonlySqlite } from "../http-utils.js";
import { maxL0RecordedAt, type RecordEntry } from "./diff-builder.js";
import { NIGHT_SWEEP_LIMIT } from "./types.js";
import type { OrchestratorContext } from "./context.js";
import type { RunSummary } from "./types.js";

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

/**
 * Stamp `roles[<role>].lastRunAt` for a run that did NOT advance the cursor
 * (an empty sweep, a refused apply). The dispatcher's per-role `ranToday`
 * asks "did this role run today", not "did it move the cursor" — without the
 * stamp a scheduled role with nothing to do would re-fire every tick.
 */
export async function stampRoleRun(
  ctx: OrchestratorContext,
  summary: RunSummary,
): Promise<void> {
  await ctx.checkpoint.update((d) => {
    const prev = d.roles[summary.role];
    d.roles[summary.role] = {
      recordsProcessed: summary.recordsPresented,
      overLimitBlocks: summary.overLimitBlocks,
      merges: prev?.merges ?? 0,
      rewrites: prev?.rewrites ?? 0,
      errors: summary.status === "ok" ? (prev?.errors ?? 0) : 1,
      lastRunAt: summary.finishedAt,
    };
  });
}

/**
 * Advance the consolidation checkpoint.
 * Day: anchoredCursor omitted → cursor = current maxL0RecordedAt().
 * Night: anchoredCursor = max slice-time of applied chunks BEFORE the
 *   first skip-merge (anchored advance, plan #9).
 */
export async function advanceCheckpoint(
  ctx: OrchestratorContext,
  prevCursor: string,
  newL0: number,
  summary: RunSummary,
  anchoredCursor?: string,
): Promise<void> {
  const cursor = (anchoredCursor ??
    maxL0RecordedAt(path.join(ctx.dataDir, "vectors.db")))!;
  ctx.logger.debug?.(
    `[checkpoint] advance role=${summary.role} prev=${prevCursor} new=${cursor} newL0=${newL0} status=${summary.status}`,
  );
  await ctx.checkpoint.update((d) => {
    d.lastRunAt = summary.finishedAt;
    if (cursor && cursor >= prevCursor) d.l0Cursor = cursor;
    d.l0Count += newL0;
    d.roles[summary.role] = {
      lastRunAt: summary.finishedAt,
      recordsProcessed: summary.recordsPresented,
      overLimitBlocks: summary.overLimitBlocks,
      merges: summary.applied.merges.length,
      rewrites: summary.applied.rewrites.length,
      errors: summary.status === "ok" ? 0 : 1,
    };
  });
}

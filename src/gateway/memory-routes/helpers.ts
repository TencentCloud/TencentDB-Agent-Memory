/**
 * Shared helpers for /memory/* routes (P3).
 *
 * clampInt / clampFloat: URL param sanitization with default fallback.
 * queryL1Rows: schema-adaptive readonly L1 fetch (project_id/scope columns
 *   are I3/I4 additions; absent columns read as '').
 * sameScope: mirror of l1-dedup.sameScope — kept local so the committed
 *   tree typechecks without the uncommitted export.
 *
 * Split from memory-routes.ts to keep that file ≤150 lines.
 */

import path from "node:path";
import { openReadonlySqlite } from "../http-utils.js";
import type { Logger } from "../../core/types.js";
import type { L1SearchResult } from "../../core/store/types.js";

export interface L1RowFilter {
  since?: string;
  project?: string;
  type?: string;
  limit: number;
}

export function queryL1Rows(
  dataDir: string,
  logger: Logger,
  filter: L1RowFilter,
): Array<Record<string, unknown>> | null {
  const dbPath = path.join(dataDir, "vectors.db");
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter.since) {
    where.push(
      "(updated_time != '' AND updated_time >= ?) OR (updated_time = '' AND created_time >= ?)",
    );
    params.push(filter.since, filter.since);
  }
  if (filter.type !== undefined) {
    where.push("type = ?");
    params.push(filter.type);
  }

  try {
    const db = openReadonlySqlite(dbPath);
    try {
      let scopeCols = "";
      try {
        const cols = db.prepare("PRAGMA table_info(l1_records)").all() as Array<{ name: string }>;
        const hasScopeCols =
          cols.some((c) => c.name === "project_id") &&
          cols.some((c) => c.name === "scope");
        if (hasScopeCols) {
          scopeCols = ", project_id, COALESCE(scope, '') AS scope";
          // Project predicate in the shared WHERE so that a project-only
          // request (no since/type) emits a valid `WHERE project_id = ?`.
          if (filter.project !== undefined) {
            where.push("project_id = ?");
            params.push(filter.project);
          }
        }
      } catch {
        // PRAGMA failure — treat as legacy schema.
      }

      const sql =
        "SELECT record_id, content, type, priority, scene_name, session_key, session_id, " +
        "timestamp_str, created_time, updated_time, metadata_json" +
        scopeCols +
        " FROM l1_records" +
        (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
        " ORDER BY MAX(updated_time, created_time) DESC, record_id DESC LIMIT ?";
      params.push(filter.limit);

      return db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    } finally {
      db.close();
    }
  } catch (err) {
    logger.warn(
      `[memory] l1_records query failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Clamp a URL int param into [min, max], falling back to `def`. */
export function clampInt(
  raw: string | null,
  min: number,
  max: number,
  def: number,
): number {
  const n = raw === null ? NaN : parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** Clamp a URL float param into [min, max], falling back to `def`. */
export function clampFloat(
  raw: string | null,
  min: number,
  max: number,
  def: number,
): number {
  const n = raw === null ? NaN : parseFloat(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** Same-scope predicate mirror of l1-dedup.sameScope. */
export function sameScope(
  candidate: { scope?: string; project_id?: string },
  memoryScope: "global" | "project" | undefined,
  projectId: string,
): boolean {
  if (!candidate.scope) return true; // Legacy records (no scope) behave as before.
  const wanted = memoryScope ?? "global";
  if (candidate.scope !== wanted) return false;
  return wanted !== "project" || candidate.project_id === projectId;
}

/** Scope-compatible duplicate candidate (L1SearchResult + optional fields). */
export type DuplicateCandidate = L1SearchResult & {
  scope?: string;
  project_id?: string;
};

/**
 * IO helpers for apply operations.
 *
 * resolveWithinDataDir: dataDir-relative path resolver (rejects traversal).
 * fetchMetaRows: schema-adaptive record fetch via a FRESH readonly
 *   connection (a connection reused across the mutation loop would hold a
 *   stale WAL snapshot and false-abort the stale-delete re-check for later
 *   ops). Throws ApplyRuntimeError on read failure.
 * writeBackup: dataDir/.backup/apply-<ts>-<safeName>.bak before atomic rewrite.
 *
 * split from apply-ops.ts to keep that file ≤150 lines.
 */

import fs from "node:fs";
import path from "node:path";
import { openReadonlySqlite } from "../http-utils.js";
import { ApplyRuntimeError } from "./errors.js";
import type { MetaRow } from "./types.js";

/** Resolve a dataDir-relative path and reject traversal escapes. */
export function resolveWithinDataDir(
  dataDir: string,
  relPath: string,
): string | null {
  const dataRoot = path.resolve(dataDir);
  const resolved = path.resolve(dataRoot, relPath);
  if (resolved !== dataRoot && !resolved.startsWith(dataRoot + path.sep))
    return null;
  return resolved;
}

/**
 * Fetch record metadata rows by id via a FRESH readonly connection.
 * project_id/scope are I3/I4 columns (ALTER TABLE migration); the committed
 * l1_records schema predates them. Probe once so the same query serves both
 * trees — absent columns read as ''.
 */
export async function fetchMetaRows(
  dataDir: string,
  ids: string[],
): Promise<Map<string, MetaRow>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, MetaRow>();
  if (unique.length === 0) return out;

  const dbPath = path.join(dataDir, "vectors.db");
  const placeholders = unique.map(() => "?").join(", ");

  try {
    const db = openReadonlySqlite(dbPath);
    try {
      const columns = new Set(
        (
          db.prepare("PRAGMA table_info(l1_records)").all() as Array<{
            name: string;
          }>
        ).map((c) => c.name),
      );
      const projectIdExpr = columns.has("project_id")
        ? "project_id"
        : "'' AS project_id";
      const scopeExpr = columns.has("scope") ? "COALESCE(scope, '')" : "''";
      const sql =
        "SELECT record_id, updated_time, created_time, content, type, priority, scene_name, session_key, session_id, " +
        `${projectIdExpr}, ${scopeExpr} AS scope, metadata_json ` +
        `FROM l1_records WHERE record_id IN (${placeholders})`;
      const rows = db.prepare(sql).all(...unique) as Array<
        Record<string, unknown>
      >;
      for (const row of rows) {
        const recordId = String(row.record_id ?? "");
        out.set(recordId, {
          record_id: recordId,
          updated_time: String(row.updated_time ?? ""),
          created_time: String(row.created_time ?? ""),
          content: String(row.content ?? ""),
          type: String(row.type ?? ""),
          priority: typeof row.priority === "number" ? row.priority : 50,
          scene_name: String(row.scene_name ?? ""),
          session_key: String(row.session_key ?? ""),
          session_id: String(row.session_id ?? ""),
          project_id: String(row.project_id ?? ""),
          scope: String(row.scope ?? ""),
          metadata_json: String(row.metadata_json ?? "{}"),
        });
      }
      return out;
    } finally {
      db.close();
    }
  } catch (err) {
    throw new ApplyRuntimeError(
      `record read failed for apply: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Backup a file to dataDir/.backup/apply-<ts>-<safeName>.bak. */
export async function writeBackup(
  dataDir: string,
  relPath: string,
  content: string,
): Promise<void> {
  const backupDir = path.join(dataDir, ".backup");
  await fs.promises.mkdir(backupDir, { recursive: true });
  const safeName = relPath.replace(/[^A-Za-z0-9._-]+/g, "_");
  const backupPath = path.join(
    backupDir,
    `apply-${Date.now()}-${safeName}.bak`,
  );
  await fs.promises.writeFile(backupPath, content, "utf-8");
}

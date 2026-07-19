/**
 * L1 Memory Reader: reads persisted L1 memory records.
 *
 * Provides two data paths:
 *
 * 1. **SQLite** (preferred): `queryMemoryRecords()` — uses VectorStore's `queryL1Records()`
 *    with composite indexes on (session_key, updated_time) and (session_id, updated_time)
 *    for efficient session-scoped and time-range queries.
 *
 * 2. **JSONL** (fallback): `readMemoryRecords()` / `readAllMemoryRecords()` — reads from
 *    `records/YYYY-MM-DD.jsonl` files. Used when VectorStore is unavailable or degraded.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryRecord, MemoryType, EpisodicMetadata } from "./l1-writer.js";
import type { IMemoryStore, L1RecordRow, L1QueryFilter } from "../store/types.js";

// Re-export types that readers need
export type { MemoryRecord, MemoryType, EpisodicMetadata } from "./l1-writer.js";
export type { L1QueryFilter } from "../store/types.js";
import type { Logger } from "../types.js";

const TAG = "[memory-tdai] [l1-reader]";

// ============================
// SQLite-based queries (preferred)
// ============================

/**
 * Query L1 memory records from SQLite via VectorStore.
 *
 * This is the **preferred** read path — it uses the composite index
 * `idx_l1_session_updated(session_id, updated_time)` for efficient
 * session-scoped and time-range queries.
 *
 * All timestamps are UTC ISO 8601 (as stored by l1-writer's dual-write).
 *
 * Falls back to empty array if VectorStore is null or degraded.
 */
export async function queryMemoryRecords(
  vectorStore: IMemoryStore | null | undefined,
  filter?: L1QueryFilter,
  logger?: Logger,
): Promise<MemoryRecord[]> {
  if (!vectorStore) {
    logger?.warn(`${TAG} queryMemoryRecords: no VectorStore available, returning empty`);
    return [];
  }

  const rows = await vectorStore.queryL1Records(filter);
  return rows.map(rowToMemoryRecord);
}

/**
 * Convert a raw SQLite L1RecordRow to a MemoryRecord (same shape as JSONL records).
 */
function rowToMemoryRecord(row: L1RecordRow): MemoryRecord {
  let metadata: EpisodicMetadata | Record<string, never> = {};
  try {
    metadata = JSON.parse(row.metadata_json) as EpisodicMetadata | Record<string, never>;
  } catch {
    // malformed JSON — use empty object
  }

  // Reconstruct timestamps array from timestamp_start / timestamp_end
  const timestamps: string[] = [];
  if (row.timestamp_str) timestamps.push(row.timestamp_str);
  if (row.timestamp_start && row.timestamp_start !== row.timestamp_str) timestamps.push(row.timestamp_start);
  if (row.timestamp_end && row.timestamp_end !== row.timestamp_str && row.timestamp_end !== row.timestamp_start) {
    timestamps.push(row.timestamp_end);
  }

  return {
    id: row.record_id,
    content: row.content,
    type: row.type as MemoryType,
    priority: row.priority,
    scene_name: row.scene_name,
    source_message_ids: [], // not stored in SQLite (vector search doesn't need them)
    metadata,
    timestamps,
    createdAt: row.created_time,
    updatedAt: row.updated_time,
    sessionKey: row.session_key,
    sessionId: row.session_id,
  };
}

// ============================
// JSONL-based reads (fallback)
// ============================

/**
 * Read all memory records for a session from JSONL files.
 *
 * Current naming mode:
 * - Daily merged file: records/YYYY-MM-DD.jsonl (all sessions in one file)
 */
export async function readMemoryRecords(
  sessionKey: string,
  baseDir: string,
  logger?: Logger,
): Promise<MemoryRecord[]> {
  const recordsDir = path.join(baseDir, "records");
  const dateFilePattern = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(recordsDir, { withFileTypes: true });
  } catch {
    // Directory doesn't exist yet
    return [];
  }

  const targetFiles = entries
    .filter((entry) => entry.isFile() && dateFilePattern.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  if (targetFiles.length === 0) {
    return [];
  }

  const records: MemoryRecord[] = [];

  for (const fileName of targetFiles) {
    const filePath = path.join(recordsDir, fileName);

    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch {
      logger?.warn?.(`${TAG} Failed to read L1 file: ${filePath}`);
      continue;
    }

    const lines = raw.split("\n").filter((line) => line.trim());
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      try {
        const parsed = JSON.parse(line) as Partial<MemoryRecord>;
        if (parsed.sessionKey !== sessionKey) {
          continue;
        }
        records.push(parsed as MemoryRecord);
      } catch {
        logger?.warn?.(`${TAG} Skipping malformed JSONL line in ${filePath}:${i + 1}`);
      }
    }
  }

  records.sort((a, b) => {
    const ta = a.updatedAt || a.createdAt || "";
    const tb = b.updatedAt || b.createdAt || "";
    return ta.localeCompare(tb);
  });

  return records;
}

/**
 * Read ALL memory records across all session JSONL files.
 */
export async function readAllMemoryRecords(
  baseDir: string,
  logger?: Logger,
): Promise<MemoryRecord[]> {
  const recordsDir = path.join(baseDir, "records");
  try {
    const files = await fs.readdir(recordsDir);
    const allRecords: MemoryRecord[] = [];

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = path.join(recordsDir, file);
      try {
        const raw = await fs.readFile(filePath, "utf-8");
        const lines = raw.split("\n").filter((line: string) => line.trim());
        for (const line of lines) {
          try {
            allRecords.push(JSON.parse(line) as MemoryRecord);
          } catch {
            logger?.warn?.(`${TAG} Skipping malformed JSONL line in ${file}`);
          }
        }
      } catch {
        logger?.warn?.(`${TAG} Failed to read ${file}`);
      }
    }

    allRecords.sort((a, b) => {
      const ta = a.updatedAt || a.createdAt || "";
      const tb = b.updatedAt || b.createdAt || "";
      return ta.localeCompare(tb);
    });

    return allRecords;

  } catch {
    // records/ directory doesn't exist yet
    return [];
  }
}

// ============================
// JSONL line counters (for checkpoint recalibration)
// ============================

// Same shard pattern as readMemoryRecords — only YYYY-MM-DD.jsonl, no .json/.bak/.tmp.
const l1DateFilePattern = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

/**
 * Count the total number of record lines across all daily-shard JSONL files
 * in `<baseDir>/records/`. Mirrors readMemoryRecords' file selection and
 * line-parsing style: only `YYYY-MM-DD.jsonl` files are matched, empty lines
 * are skipped, and malformed (unparseable) lines are skipped (not counted).
 *
 * Returns 0 when the records directory does not exist (does not throw),
 * matching readMemoryRecords' try/catch fallback.
 */
export async function countL1JsonlLines(baseDir: string): Promise<number> {
  const recordsDir = path.join(baseDir, "records");

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(recordsDir, { withFileTypes: true });
  } catch {
    // Directory doesn't exist yet
    return 0;
  }

  const targetFiles = entries
    .filter((entry) => entry.isFile() && l1DateFilePattern.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  let count = 0;
  for (const fileName of targetFiles) {
    const filePath = path.join(recordsDir, fileName);

    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch {
      continue;
    }

    const lines = raw.split("\n").filter((line) => line.trim());
    for (const line of lines) {
      try {
        JSON.parse(line);
        count++;
      } catch {
        // malformed JSON line — skip (not counted)
      }
    }
  }

  return count;
}

/**
 * Count record lines whose `updatedAt` field is strictly greater than
 * `sinceIso` across all daily-shard JSONL files in `<baseDir>/records/`.
 *
 * Semantics:
 * - Only `YYYY-MM-DD.jsonl` shard files are matched (same pattern as
 *   readMemoryRecords).
 * - Each non-empty line is JSON.parsed; the `updatedAt` field is compared
 *   via string ordering against `sinceIso` (both expected to be canonical
 *   ISO 8601 UTC strings, e.g. `2026-06-01T10:00:00.000Z`).
 * - Lines with malformed JSON, a missing `updatedAt`, or a non-string
 *   `updatedAt` are skipped (not counted).
 * - When `sinceIso === ""`, returns the total line count (equivalent to
 *   countL1JsonlLines).
 *
 * Returns 0 when the records directory does not exist (does not throw).
 */
export async function countL1JsonlLinesSince(
  baseDir: string,
  sinceIso: string,
): Promise<number> {
  if (sinceIso === "") {
    return countL1JsonlLines(baseDir);
  }

  const recordsDir = path.join(baseDir, "records");

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(recordsDir, { withFileTypes: true });
  } catch {
    // Directory doesn't exist yet
    return 0;
  }

  const targetFiles = entries
    .filter((entry) => entry.isFile() && l1DateFilePattern.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  let count = 0;
  for (const fileName of targetFiles) {
    const filePath = path.join(recordsDir, fileName);

    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch {
      continue;
    }

    const lines = raw.split("\n").filter((line) => line.trim());
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // malformed JSON line — skip
        continue;
      }

      const updatedAt = (parsed as Partial<MemoryRecord>)?.updatedAt;
      if (typeof updatedAt !== "string") {
        // missing or non-string updatedAt — skip
        continue;
      }
      if (Number.isNaN(new Date(updatedAt).getTime())) {
        // malformed ISO timestamp (e.g. "zzz", "not-a-time") — skip, do not
        // participate in the string ordering comparison.
        continue;
      }

      if (updatedAt > sinceIso) {
        count++;
      }
    }
  }

  return count;
}

// ============================
// Helpers
// ============================

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
}

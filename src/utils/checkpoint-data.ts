import fs from "node:fs/promises";
import path from "node:path";

export type CheckpointDataKind = "l0" | "l1";

export interface CheckpointDataLogger {
  warn?(message: string): void;
}

export interface CheckpointDataCounts {
  l0Records: number;
  l1Records: number;
  l1RecordsSincePersona: number;
}

export interface CheckpointFileCounts {
  records: number;
  recordsSincePersona: number;
  malformedLines: number;
}

const SHARD_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingPathError(err: unknown): boolean {
  return isObject(err) && err.code === "ENOENT";
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function countL0Record(value: unknown): number | undefined {
  if (!isObject(value)) return undefined;

  // Before the flat format, one JSONL line represented a capture batch.
  if (Array.isArray(value.messages)) {
    return value.messages.filter(isObject).length;
  }

  if (
    typeof value.id !== "string"
    || typeof value.sessionKey !== "string"
    || parseTimestamp(value.recordedAt) === undefined
  ) {
    return undefined;
  }

  return 1;
}

function readL1Timestamp(value: Record<string, unknown>): number | undefined {
  return parseTimestamp(
    value.updatedAt
    ?? value.updated_at
    ?? value.updated_time
    ?? value.createdAt
    ?? value.created_at,
  );
}

/** Count valid persisted records in one L0 or L1 JSONL shard. */
export async function countCheckpointJsonlFile(
  filePath: string,
  kind: CheckpointDataKind,
  lastPersonaTime = "",
): Promise<CheckpointFileCounts> {
  const raw = await fs.readFile(filePath, "utf-8");
  const personaTimestamp = parseTimestamp(lastPersonaTime);
  const result: CheckpointFileCounts = {
    records: 0,
    recordsSincePersona: 0,
    malformedLines: 0,
  };

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      result.malformedLines += 1;
      continue;
    }

    if (kind === "l0") {
      const recordCount = countL0Record(parsed);
      if (recordCount === undefined) {
        result.malformedLines += 1;
        continue;
      }
      result.records += recordCount;
      continue;
    }

    if (!isObject(parsed) || typeof parsed.id !== "string" || typeof parsed.sessionKey !== "string") {
      result.malformedLines += 1;
      continue;
    }

    const updatedTimestamp = readL1Timestamp(parsed);
    if (updatedTimestamp === undefined) {
      result.malformedLines += 1;
      continue;
    }

    result.records += 1;
    if (personaTimestamp === undefined || updatedTimestamp > personaTimestamp) {
      result.recordsSincePersona += 1;
    }
  }

  return result;
}

async function countDirectory(
  baseDir: string,
  subdirectory: string,
  kind: CheckpointDataKind,
  lastPersonaTime: string,
  logger?: CheckpointDataLogger,
): Promise<CheckpointFileCounts> {
  const directory = path.join(baseDir, subdirectory);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (err) {
    if (isMissingPathError(err)) {
      return { records: 0, recordsSincePersona: 0, malformedLines: 0 };
    }
    throw err;
  }

  const total: CheckpointFileCounts = {
    records: 0,
    recordsSincePersona: 0,
    malformedLines: 0,
  };

  for (const entry of entries) {
    if (!entry.isFile() || !SHARD_FILE_PATTERN.test(entry.name)) continue;

    const filePath = path.join(directory, entry.name);
    try {
      const counts = await countCheckpointJsonlFile(filePath, kind, lastPersonaTime);
      total.records += counts.records;
      total.recordsSincePersona += counts.recordsSincePersona;
      total.malformedLines += counts.malformedLines;
    } catch (err) {
      logger?.warn?.(
        `[checkpoint] Failed to count ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  return total;
}

/** Reconstruct checkpoint counter truth from local JSONL shards. */
export async function countCheckpointJsonlData(
  baseDir: string,
  lastPersonaTime: string,
  logger?: CheckpointDataLogger,
): Promise<CheckpointDataCounts> {
  const [l0, l1] = await Promise.all([
    countDirectory(baseDir, "conversations", "l0", lastPersonaTime, logger),
    countDirectory(baseDir, "records", "l1", lastPersonaTime, logger),
  ]);

  const malformedLines = l0.malformedLines + l1.malformedLines;
  if (malformedLines > 0) {
    logger?.warn?.(
      `[checkpoint] Ignored ${malformedLines} malformed or incomplete JSONL record(s) during recalculation`,
    );
  }

  return {
    l0Records: l0.records,
    l1Records: l1.records,
    l1RecordsSincePersona: l1.recordsSincePersona,
  };
}

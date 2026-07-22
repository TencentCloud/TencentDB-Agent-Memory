import fs from "node:fs/promises";
import path from "node:path";

import type { CheckpointLogger } from "./checkpoint.js";

/**
 * Best-effort recovery for canonical date-sharded JSONL data.
 *
 * The project readers are deliberately permissive, session-oriented, and tolerate
 * file-read failures, while the L0/L1 writers expose types but no shared runtime
 * validators. These checks therefore cover the fields required to count current
 * canonical writer output plus limited known legacy shapes; they are not a promise
 * of compatibility with every historical or external JSONL format.
 */

export type CheckpointDataLayer = "l0" | "l1";

export interface JsonlCheckpointCounts {
  l0: number;
  l1: number;
  l1Since: number;
  directories: {
    l0: "present" | "missing";
    l1: "present" | "missing";
  };
}

const DATE_SHARD_PATTERN = /^(\d{4})-(\d{2})-(\d{2})\.(?:jsonl|json)$/;

function isDateShardName(name: string): boolean {
  const match = DATE_SHARD_PATTERN.exec(name);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidTimestamp(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0;
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isValidL0Message(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (value.role === "user" || value.role === "assistant")
    && typeof value.content === "string"
    && value.content.length > 0
    && isValidTimestamp(value.timestamp);
}

function countL0Record(value: unknown): { count: number; invalid: boolean } {
  if (!isRecord(value)) return { count: 0, invalid: true };
  if (Array.isArray(value.messages)) {
    const count = value.messages.reduce(
      (sum, message) => sum + (isValidL0Message(message) ? 1 : 0),
      0,
    );
    return { count, invalid: count !== value.messages.length || count === 0 };
  }
  const valid = typeof value.sessionKey === "string" && value.sessionKey.length > 0 && isValidL0Message(value);
  return { count: valid ? 1 : 0, invalid: !valid };
}

function getL1Timestamp(value: Record<string, unknown>): number | undefined {
  for (const key of ["updatedAt", "updated_time", "createdAt", "created_time"]) {
    const candidate = value[key];
    if (isValidTimestamp(candidate)) {
      const parsed = typeof candidate === "number" ? candidate : Date.parse(candidate as string);
      return parsed;
    }
  }
  return undefined;
}

function getL1RecordTimestamp(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const sessionKey = value.sessionKey ?? value.session_key;
  if (typeof value.id !== "string" || value.id.length === 0) return undefined;
  if (typeof sessionKey !== "string" || sessionKey.length === 0) return undefined;
  return getL1Timestamp(value);
}

function warnInvalid(
  logger: CheckpointLogger | undefined,
  filePath: string,
  lineNumber: number,
  detail: string,
): void {
  logger?.warn?.(
    `[checkpoint-data] Ignoring ${detail} record source=${path.basename(filePath)} line=${lineNumber}`,
  );
}

/** Count best-effort recognizable records in one canonical date shard. */
export async function countCheckpointShard(
  filePath: string,
  layer: CheckpointDataLayer,
  logger?: CheckpointLogger,
  updatedAfter?: string,
): Promise<{ total: number; since: number }> {
  const raw = await fs.readFile(filePath, "utf-8");
  const afterMs = updatedAfter ? Date.parse(updatedAfter) : Number.NaN;
  let total = 0;
  let since = 0;

  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      warnInvalid(logger, filePath, index + 1, "malformed");
      continue;
    }

    if (layer === "l0") {
      const result = countL0Record(parsed);
      if (result.invalid) warnInvalid(logger, filePath, index + 1, "incomplete L0");
      total += result.count;
      continue;
    }

    const timestamp = getL1RecordTimestamp(parsed);
    if (timestamp === undefined) {
      warnInvalid(logger, filePath, index + 1, "incomplete L1");
      continue;
    }
    total += 1;
    if (!updatedAfter || (Number.isFinite(afterMs) && timestamp > afterMs)) since += 1;
  }

  return { total, since };
}

async function countDirectory(
  dirPath: string,
  layer: CheckpointDataLayer,
  logger?: CheckpointLogger,
  updatedAfter?: string,
): Promise<{ total: number; since: number; status: "present" | "missing" }> {
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { total: 0, since: 0, status: "missing" };
    }
    throw err;
  }

  let total = 0;
  let since = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !isDateShardName(entry.name)) continue;
    const counts = await countCheckpointShard(
      path.join(dirPath, entry.name),
      layer,
      logger,
      updatedAfter,
    );
    total += counts.total;
    since += counts.since;
  }
  return { total, since, status: "present" };
}

/**
 * Best-effort recovery for canonical date-sharded JSONL data.
 *
 * Missing canonical directories are reported separately from present-but-empty
 * directories. Directory read failures other than ENOENT are thrown.
 */
export async function countCheckpointJsonlData(
  dataDir: string,
  logger?: CheckpointLogger,
  updatedAfter?: string,
): Promise<JsonlCheckpointCounts> {
  const [l0, l1] = await Promise.all([
    countDirectory(path.join(dataDir, "conversations"), "l0", logger),
    countDirectory(path.join(dataDir, "records"), "l1", logger, updatedAfter),
  ]);
  return {
    l0: l0.total,
    l1: l1.total,
    l1Since: updatedAfter ? l1.since : l1.total,
    directories: { l0: l0.status, l1: l1.status },
  };
}

/**
 * L1 timestamp provenance helpers.
 *
 * Source-message time is distinct from event time (`metadata.activity_*`) and
 * from `createdAt`/`updatedAt`. Conflict detection and merge/update writes
 * must use timestamps that can be traced to L0 messages or already-stored
 * candidate records — never model-invented values.
 */

export interface TimestampedMessage {
  id: string;
  timestamp: number;
}

/**
 * Keep strings that parse as real dates, de-duplicate, and sort lexicographically
 * (ISO-8601 UTC strings compare in chronological order).
 *
 * Invalid / empty values are dropped rather than throwing: a bad timestamp on
 * one memory must not abort the rest of the extraction batch.
 */
export function uniqueSortedTimestamps(values: Iterable<string | undefined>): string[] {
  const seen = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (Number.isNaN(Date.parse(trimmed))) continue;
    seen.add(trimmed);
  }
  return [...seen].sort();
}

/** ECMA-262 time-value range in milliseconds (±100,000,000 days from epoch). */
const MAX_DATE_EPOCH_MS = 8.64e15;

/**
 * Convert epoch milliseconds to ISO-8601. Returns undefined when the instant is
 * non-finite or outside the Date range (`toISOString()` would throw RangeError).
 */
export function epochMsToIso(epochMs: number): string | undefined {
  if (!Number.isFinite(epochMs) || Math.abs(epochMs) > MAX_DATE_EPOCH_MS) {
    return undefined;
  }
  try {
    return new Date(epochMs).toISOString();
  } catch {
    return undefined;
  }
}

/**
 * Resolve ISO timestamps for an extracted memory from its `source_message_ids`.
 *
 * Policy (missing / partial sources):
 * - Only IDs that exist in `messages` with a finite, in-range epoch timestamp contribute.
 * - Unresolved IDs and values that cannot be converted with `toISOString()` are skipped
 *   (no throw, no fallback to every scene message). `Number.isFinite` is not enough:
 *   `1e20` is finite but `new Date(1e20).toISOString()` throws RangeError.
 * - If nothing resolves, return `[]`. Merge/update decisions then fall back to `store`
 *   in `applyDedupProvenance`; store writes may still use processing time.
 */
export function resolveSourceTimestamps(
  sourceMessageIds: string[] | undefined,
  messages: TimestampedMessage[],
): string[] {
  if (!Array.isArray(sourceMessageIds) || sourceMessageIds.length === 0) return [];

  const byId = new Map<string, number>();
  for (const msg of messages) {
    if (!msg?.id) continue;
    if (typeof msg.timestamp !== "number" || !Number.isFinite(msg.timestamp)) continue;
    byId.set(msg.id, msg.timestamp);
  }

  const iso: string[] = [];
  for (const id of sourceMessageIds) {
    const epochMs = byId.get(id);
    if (epochMs === undefined) continue;
    const converted = epochMsToIso(epochMs);
    if (converted) iso.push(converted);
  }
  return uniqueSortedTimestamps(iso);
}

/**
 * Reconstruct the timestamps available on an L1 search/FTS hit.
 *
 * Storage persists a trail as `timestamp_str` / `timestamp_start` /
 * `timestamp_end` (not the full array). Dedup union must use all three so
 * merge/update does not drop the latest evidence time.
 */
export function timestampsFromSearchHit(hit: {
  timestamp_str?: string;
  timestamp_start?: string;
  timestamp_end?: string;
}): string[] {
  return uniqueSortedTimestamps([hit.timestamp_str, hit.timestamp_start, hit.timestamp_end]);
}

/**
 * Timestamps that will be persisted on an L1 record.
 *
 * - merge/update: use the code-computed union (`mergedTimestamps`); if empty,
 *   fall back to the new memory's source timestamps. Never use processing time
 *   — that would stamp an invented instant onto a record that replaces others.
 * - store: prefer source timestamps when present, else `nowIso` when it parses
 *   as a real date. Omit `nowIso` rather than passing an empty sentinel.
 * - skip: unused (writer returns null before writing).
 */
export function timestampsForWrite(params: {
  action: "store" | "update" | "merge" | "skip";
  memoryTimestamps?: string[];
  mergedTimestamps?: string[];
  nowIso?: string;
}): string[] {
  const fromMemory = uniqueSortedTimestamps(params.memoryTimestamps ?? []);
  if (params.action === "merge" || params.action === "update") {
    const union = uniqueSortedTimestamps(params.mergedTimestamps ?? []);
    return union.length > 0 ? union : fromMemory;
  }
  if (params.action === "store") {
    return fromMemory.length > 0 ? fromMemory : uniqueSortedTimestamps([params.nowIso]);
  }
  return [];
}

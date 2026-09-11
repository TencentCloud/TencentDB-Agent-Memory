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

/**
 * Resolve ISO timestamps for an extracted memory from its `source_message_ids`.
 *
 * Policy (missing / partial sources):
 * - Only IDs that exist in `messages` with a finite epoch timestamp contribute.
 * - Unresolved IDs are skipped (no throw, no fallback to every scene message).
 * - If nothing resolves, return `[]` and let the writer fall back to processing time.
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
    iso.push(new Date(epochMs).toISOString());
  }
  return uniqueSortedTimestamps(iso);
}

/**
 * Timestamps that will be persisted on an L1 record.
 *
 * - merge/update: use the code-computed union (`mergedTimestamps`); if empty,
 *   fall back to the new memory's source timestamps, then processing time.
 * - store: prefer source timestamps when present, else processing time.
 * - skip: unused (writer returns null before writing).
 */
export function timestampsForWrite(params: {
  action: "store" | "update" | "merge" | "skip";
  memoryTimestamps?: string[];
  mergedTimestamps?: string[];
  nowIso: string;
}): string[] {
  const fromMemory = uniqueSortedTimestamps(params.memoryTimestamps ?? []);
  if (params.action === "merge" || params.action === "update") {
    const union = uniqueSortedTimestamps(params.mergedTimestamps ?? []);
    if (union.length > 0) return union;
    if (fromMemory.length > 0) return fromMemory;
    return [params.nowIso];
  }
  if (params.action === "store") {
    return fromMemory.length > 0 ? fromMemory : [params.nowIso];
  }
  return [];
}

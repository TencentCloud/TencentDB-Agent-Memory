import type { MemoryEvent } from "./types.js";

/**
 * Shared field-dictionary → MemoryEvent normalization for every store
 * backend. Each backend extracts its own fields (sqlite row / bson doc /
 * tcvdb doc) into a plain dictionary keyed by MemoryEvent field names;
 * "" and missing both decode to undefined for optional fields.
 */
export type MemoryEventFields = Readonly<Record<string, unknown>>;

const str = (v: unknown): string => String(v ?? "");
const opt = (v: unknown): string | undefined => str(v) || undefined;

/** Decode a JSON-encoded `supersedes` column; malformed → none. */
export function parseSupersedesJson(json: string): string[] {
  try {
    return JSON.parse(json) as string[];
  } catch {
    return [];
  }
}

export function decodeMemoryEvent(f: MemoryEventFields, supersedes: string[]): MemoryEvent {
  return {
    event_id: opt(f.event_id),
    event_ts: str(f.event_ts),
    session_key: str(f.session_key),
    session_id: str(f.session_id),
    origin_session_id: opt(f.origin_session_id),
    origin_session_key: opt(f.origin_session_key),
    team_id: opt(f.team_id),
    user_id: opt(f.user_id),
    agent_id: opt(f.agent_id),
    task_id: opt(f.task_id),
    op: f.op as MemoryEvent["op"],
    record_id: str(f.record_id),
    content: str(f.content),
    memory_type: opt(f.memory_type),
    version: Number(f.version ?? 0),
    supersedes: supersedes.length ? supersedes : undefined,
    superseded_by: opt(f.superseded_by),
    snapshot_json: opt(f.snapshot_json),
    reviewer_id: opt(f.reviewer_id),
    layer: (str(f.layer ?? "l1") || "l1") as MemoryEvent["layer"],
    source: opt(f.source) as MemoryEvent["source"],
    request_id: opt(f.request_id),
    reason: opt(f.reason),
    target_event_id: opt(f.target_event_id),
    scope: opt(f.scope) as MemoryEvent["scope"],
    until: opt(f.until),
  };
}

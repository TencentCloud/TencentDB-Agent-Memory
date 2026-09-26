import { randomUUID } from "node:crypto";
import { DEFAULT_ISOLATION_ID } from "./isolation.js";
import type { MemoryEvent, MemoryEventRedactFilter } from "./types.js";

/**
 * Stable per-event identity: `evt-` + 32 hex chars (36 chars total), well
 * under the TCVDB document id limit of 128. Generated once at the logical
 * write point and carried through the JSONL outbox and every store backend,
 * so replaying the same event is idempotent.
 */
export function newMemoryEventId(): string {
  return `evt-${randomUUID().replace(/-/g, "")}`;
}

export function withMemoryEventId<T extends MemoryEvent>(event: T): T & { event_id: string } {
  return event.event_id ? (event as T & { event_id: string }) : { ...event, event_id: newMemoryEventId() };
}

/**
 * Ledger timestamp contract: every timestamp that reaches a string
 * comparison (event_ts bounds, redaction `until`, stored rows) must be the
 * canonical millisecond form `YYYY-MM-DDTHH:mm:ss.sssZ`, where lexical order
 * equals chronological order. Admits every ms-exact ISO 8601 shape —
 * `…ssZ`, `…ss.ssZ`, `…ss+08:00`, `…ss+0800`, even `…HH:mmZ` — and
 * normalizes it; rejects date-only, zone-less, space-separated,
 * sub-millisecond (>3 fractional digits), and unparseable values so nothing
 * lossy or ambiguous reaches a lexical compare. Returns null for anything
 * not losslessly representable at ms precision.
 */
const MS_EXACT_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-](\d{2}):?(\d{2}))$/;
const CANON_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Every field is range-checked before Date.parse, which would otherwise roll
 * `02-30` into March or `24:00` into the next day; the result must also fit
 * the 4-digit-year canonical shape (`toISOString` emits `+010000-…` past
 * year 9999, which sorts before every canonical string).
 */
export function canonIsoTs(v: string): string | null {
  const m = MS_EXACT_ISO_RE.exec(v);
  if (!m) return null;
  const [year, month, day, hour, minute] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  if (m[7] !== undefined && (Number(m[7]) > 23 || Number(m[8]) > 59)) return null;
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) return null;
  const out = new Date(ms).toISOString();
  return CANON_ISO_RE.test(out) ? out : null;
}

/**
 * Pre-contract redaction markers carried any `Date.parse`-able `until` and
 * were compared lexically against event_ts. Maps legacy shapes to a canonical
 * bound preserving the marker's intent at ms granularity: a sub-ms fraction
 * floors to its millisecond (which lexically covers that boundary instant —
 * wider than the raw bound by exactly the floored ms, matching author intent);
 * a date-only `YYYY-MM-DD` covered everything strictly before that day and
 * maps to the previous day's last millisecond; `…ssZ`-style bounds under-cover
 * (raw lexical reach included the whole trailing second/minute) — safe
 * direction, re-running the redaction closes the gap. Anything else stays null.
 */
export function canonLegacyUntil(v: string): string | null {
  const exact = canonIsoTs(v);
  if (exact !== null) return exact;
  const subMs = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})\d+Z$/.exec(v);
  if (subMs) return canonIsoTs(`${subMs[1]}Z`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const dayStart = canonIsoTs(`${v}T00:00:00.000Z`);
    if (dayStart === null) return null;
    const prev = new Date(Date.parse(dayStart) - 1).toISOString();
    return CANON_ISO_RE.test(prev) ? prev : null;
  }
  return null;
}

/**
 * `since`/`until` bound for a store-level event_ts compare. Store queries are
 * reachable without the gateway schema (planRevert, replay, direct callers),
 * so the bound is canonicalized here too; an unrepresentable bound throws
 * rather than silently mis-filtering.
 */
export function canonEventBound(v: string): string {
  const c = canonIsoTs(v);
  if (c === null) throw new Error(`memory_events query rejected: non-canonical time bound "${v}"`);
  return c;
}

/** Event identity contract: `evt-` + 32 lowercase hex. */
export const EVENT_ID_RE = /^evt-[0-9a-f]{32}$/;

/**
 * L0/L1 instant columns (updated_time / created_time / recorded_at) share
 * the canonical-instant contract with event_ts, plus one sentinel: "" means
 * "no timestamp" and TTL guards deliberately skip it (`!= ''` in sqlite,
 * `_ms > 0` for the numeric twins). Canonicalize anything else; null = the
 * write is rejected rather than persisting an uncomparable value.
 */
export function canonRecordTs(v: string | undefined): string | null {
  return v === undefined || v === "" ? "" : canonIsoTs(v);
}

/**
 * Isolation-id contract: "" and "default" denote the same logical "no
 * value" (writes converge on "default"; legacy/foreign rows may still
 * carry ""). A defined filter value heals "" → "default"; undefined stays
 * undefined (unconstrained). Row-side healing is plain `v || "default"`.
 */
export function healIsoId(v: string | undefined): string | undefined {
  return v === undefined ? undefined : v || DEFAULT_ISOLATION_ID;
}

/**
 * Redact-filter whitelist shared by the marker-read path and the live
 * redaction entry. Only {team_id, agent_id, user_id, until} carry meaning —
 * coverage and store wipes ignore every other field, so a filter or marker
 * smuggling an unknown field (e.g. a runtime-cast `task_id`) would erase
 * wider than it claims. Rejected rather than silently narrowed.
 */
export function isValidRedactFilter(f: unknown): f is MemoryEventRedactFilter {
  if (typeof f !== "object" || f === null || Array.isArray(f)) return false;
  const r = f as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (k !== "team_id" && k !== "agent_id" && k !== "user_id" && k !== "until") return false;
  }
  for (const k of ["team_id", "agent_id", "user_id"] as const) {
    if (r[k] !== undefined && typeof r[k] !== "string") return false;
  }
  return typeof r.until === "string" && canonIsoTs(r.until) !== null;
}

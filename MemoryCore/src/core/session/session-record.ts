/**
 * Session turn records — validation, object key layout and persistence for
 * `/v3/session/add`.
 *
 * Layout and record fields follow MemoryCore/docs/cos-format.md:
 *   sessions/<source>/<team>/<user>/<session>/<started-at>-<id>.json
 *   sessions/<source>/<team>/<user>/<session>/subagents/<subagent>/<started-at>-<id>.json
 *
 * Keys are relative to the instance root; the per-instance StorageAdapter
 * (LocalStorageBackend in standalone, CosStorageBackend in service) supplies
 * the `<path-prefix>/<instance-id>/` part.
 *
 * Core does no protocol conversion: only path segments and top-level record
 * fields are checked, `messages` / `output` contents are stored untouched.
 */

import { randomBytes } from "node:crypto";
import type { StorageAdapter } from "../storage/adapter.js";

export const SESSION_SOURCES = ["online", "offline"] as const;
export type SessionSource = (typeof SESSION_SOURCES)[number];

export const UNASSIGNED_TEAM = "_unassigned";

const MAX_SEGMENT_BYTES = 256;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const RECORD_FIELDS = new Set([
  "started_at",
  "ended_at",
  "user_query",
  "model",
  "messages",
  "output",
  "subagent",
]);

/** Validation failure carrying the HTTP / envelope code (400 or 422). */
export class SessionValidationError extends Error {
  readonly status: 400 | 422;
  constructor(status: 400 | 422, message: string) {
    super(message);
    this.name = "SessionValidationError";
    this.status = status;
  }
}

/** Turn record as received, minus `source` (and without `user` / `session`). */
export interface SessionTurnFields {
  started_at: string;
  ended_at: string;
  user_query: string;
  model: string;
  messages: unknown[];
  output: Record<string, unknown>;
  subagent?: string;
  [key: string]: unknown;
}

export interface SessionAddInput {
  source: SessionSource;
  record: SessionTurnFields;
}

export interface SessionIdentity {
  team: string;
  user: string;
  session: string;
}

export interface SessionWriteResult {
  object_key: string;
  bytes: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

/**
 * Check a value that becomes one path segment of the object key.
 * Throws a 400 {@link SessionValidationError}; the value is never trimmed or
 * escaped, so the path segment always equals the field value.
 */
export function validatePathSegment(name: string, value: string): void {
  if (value.length === 0) {
    throw new SessionValidationError(400, `invalid ${name}: must not be empty`);
  }
  if (Buffer.byteLength(value, "utf-8") > MAX_SEGMENT_BYTES) {
    throw new SessionValidationError(400, `invalid ${name}: exceeds ${MAX_SEGMENT_BYTES} bytes`);
  }
  if (value.includes("/") || value.includes("\\") || hasControlChar(value)) {
    throw new SessionValidationError(400, `invalid ${name}: must not contain '/', '\\' or control characters`);
  }
  if (value === "." || value === "..") {
    throw new SessionValidationError(400, `invalid ${name}: must not be '.' or '..'`);
  }
}

function requireTimestamp(body: Record<string, unknown>, field: string): void {
  const v = body[field];
  if (v === undefined) throw new SessionValidationError(422, `missing field: ${field}`);
  if (typeof v !== "string" || !TIMESTAMP_RE.test(v) || Number.isNaN(Date.parse(v)) || new Date(v).toISOString() !== v) {
    throw new SessionValidationError(422, `invalid field: ${field} must be formatted as YYYY-MM-DDTHH:MM:SS.sssZ`);
  }
}

/**
 * Validate a `/v3/session/add` body. Throws {@link SessionValidationError}:
 *   - 400: `source` is not `online` / `offline`, or `subagent` is not a valid path segment
 *   - 422: body not an object, `user` / `session` / unknown field present,
 *          required field missing or of the wrong type / format
 */
export function validateSessionAddBody(body: unknown): SessionAddInput {
  if (!isPlainObject(body)) {
    throw new SessionValidationError(422, "request body must be a JSON object");
  }

  const source = body.source;
  if (typeof source !== "string" || !(SESSION_SOURCES as readonly string[]).includes(source)) {
    throw new SessionValidationError(400, "invalid source: must be 'online' or 'offline'");
  }

  for (const key of Object.keys(body)) {
    if (key === "source") continue;
    if (key === "user" || key === "session") {
      throw new SessionValidationError(422, `field not allowed: ${key} (taken from x-tdai-${key}-id header)`);
    }
    if (!RECORD_FIELDS.has(key)) {
      throw new SessionValidationError(422, `unknown field: ${key}`);
    }
  }

  requireTimestamp(body, "started_at");
  requireTimestamp(body, "ended_at");

  if (body.user_query === undefined) throw new SessionValidationError(422, "missing field: user_query");
  if (typeof body.user_query !== "string") {
    throw new SessionValidationError(422, "invalid field: user_query must be a string");
  }

  if (body.model === undefined) throw new SessionValidationError(422, "missing field: model");
  if (typeof body.model !== "string" || body.model.length === 0) {
    throw new SessionValidationError(422, "invalid field: model must be a non-empty string");
  }

  if (body.messages === undefined) throw new SessionValidationError(422, "missing field: messages");
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new SessionValidationError(422, "invalid field: messages must be a non-empty array");
  }

  if (body.output === undefined) throw new SessionValidationError(422, "missing field: output");
  if (!isPlainObject(body.output)) {
    throw new SessionValidationError(422, "invalid field: output must be an object");
  }

  if ("subagent" in body) {
    if (typeof body.subagent !== "string" || body.subagent.length === 0) {
      throw new SessionValidationError(422, "invalid field: subagent must be a non-empty string when present");
    }
    validatePathSegment("subagent", body.subagent);
  }

  const { source: _source, ...record } = body;
  return { source: source as SessionSource, record: record as SessionTurnFields };
}

/** `2026-06-11T02:18:20.359Z` → `20260611T021820.359Z`. */
export function compactStartedAt(startedAt: string): string {
  return startedAt.replace(/[-:]/g, "");
}

export function buildSessionObjectKey(args: {
  source: SessionSource;
  team: string;
  user: string;
  session: string;
  subagent?: string;
  startedAt: string;
  id?: string;
}): string {
  const id = args.id ?? randomBytes(4).toString("hex");
  const dir = [`sessions/${args.source}/${args.team}/${args.user}/${args.session}`];
  if (args.subagent !== undefined) dir.push(`subagents/${args.subagent}`);
  return `${dir.join("/")}/${compactStartedAt(args.startedAt)}-${id}.json`;
}

/**
 * Persist one turn record. The stored object is the validated body minus
 * `source`, plus `user` / `session` from the request headers.
 */
export async function writeSessionTurn(
  storage: StorageAdapter,
  identity: SessionIdentity,
  input: SessionAddInput,
): Promise<SessionWriteResult> {
  const { record } = input;
  const objectKey = buildSessionObjectKey({
    source: input.source,
    team: identity.team,
    user: identity.user,
    session: identity.session,
    subagent: record.subagent,
    startedAt: record.started_at,
  });
  const content = Buffer.from(
    JSON.stringify({ user: identity.user, session: identity.session, ...record }),
    "utf-8",
  );
  await storage.writeFile(objectKey, content);
  return { object_key: objectKey, bytes: content.length };
}

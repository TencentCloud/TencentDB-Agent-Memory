/**
 * Session records — validation, object key layout and persistence for
 * `/v3/session/add`.
 *
 * Layout and record fields follow MemoryCore/docs/cos-format.md:
 *   sessions/<source>/<team>/<user>/<session>/<started-at>-<id>.json
 *   sessions/<source>/<team>/<user>/<session>/subagents/<subagent>/<started-at>-<id>.json
 *
 * The two sources store different records under the same layout:
 *   - online  : one LLM call — the request body sent upstream and the reply
 *   - offline : one turn — the ending call's messages and output
 * An online body carrying `messages` is a turn record from a MemoryProxy that
 * predates per-call records; it is validated and stored as one, as before.
 *
 * Keys are relative to the instance root; the per-instance StorageAdapter
 * (LocalStorageBackend in standalone, CosStorageBackend in service) supplies
 * the `<path-prefix>/<instance-id>/` part.
 *
 * Core does no protocol conversion: only path segments and top-level record
 * fields are checked, `request` / `response` / `messages` / `output` contents
 * are stored untouched.
 */

import { randomBytes } from "node:crypto";
import type { StorageAdapter } from "../storage/adapter.js";

export const SESSION_SOURCES = ["online", "offline"] as const;
export type SessionSource = (typeof SESSION_SOURCES)[number];

export const UNASSIGNED_TEAM = "_unassigned";

/**
 * Upper bound on one record write, from the start of the write to its result.
 * MemoryProxy's upload timeout (20 s) must stay above this plus body receive and parse time.
 */
export const SESSION_WRITE_TIMEOUT_MS = 15_000;

export const SESSION_PROTOCOLS = ["anthropic", "openai", "responses"] as const;
export type SessionProtocol = (typeof SESSION_PROTOCOLS)[number];

const MAX_SEGMENT_BYTES = 256;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Identity fields Core fills from headers; a body carrying them is rejected. */
const IDENTITY_FIELDS: Record<string, string> = {
  instance: "x-tdai-service-id",
  team: "x-tdai-team-id",
  user: "x-tdai-user-id",
  session: "x-tdai-session-id",
};

const RECORD_FIELDS: Record<SessionSource, ReadonlySet<string>> = {
  online: new Set([
    "agent",
    "started_at",
    "ended_at",
    "protocol",
    "model",
    "status",
    "trace_id",
    "upstream_request_id",
    "request",
    "response",
    "subagent",
    "compression_observations",
  ]),
  offline: new Set([
    "started_at",
    "ended_at",
    "user_query",
    "model",
    "messages",
    "output",
    "subagent",
  ]),
};

/** Validation failure carrying the HTTP / envelope code (400 or 422). */
export class SessionValidationError extends Error {
  readonly status: 400 | 422;
  constructor(status: 400 | 422, message: string) {
    super(message);
    this.name = "SessionValidationError";
    this.status = status;
  }
}

/** Online call record as received, minus `source` and the identity fields. */
export interface SessionCallFields {
  agent: string;
  started_at: string;
  ended_at: string;
  protocol: SessionProtocol;
  model: string;
  status: number;
  trace_id?: string;
  upstream_request_id?: string;
  request: Record<string, unknown>;
  response: Record<string, unknown> | string;
  subagent?: string;
  /** One entry per remote compression call made while preparing `request`. */
  compression_observations?: Record<string, unknown>[];
  [key: string]: unknown;
}

/** Offline turn record as received, minus `source` and the identity fields. */
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

export type SessionAddInput =
  | { source: "online"; kind: "call"; record: SessionCallFields }
  | { source: SessionSource; kind: "turn"; record: SessionTurnFields };

export interface SessionIdentity {
  instance: string;
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

function requireNonEmptyString(body: Record<string, unknown>, field: string): void {
  if (body[field] === undefined) throw new SessionValidationError(422, `missing field: ${field}`);
  if (typeof body[field] !== "string" || (body[field] as string).length === 0) {
    throw new SessionValidationError(422, `invalid field: ${field} must be a non-empty string`);
  }
}

function validateSubagent(body: Record<string, unknown>): void {
  if (!("subagent" in body)) return;
  if (typeof body.subagent !== "string" || body.subagent.length === 0) {
    throw new SessionValidationError(422, "invalid field: subagent must be a non-empty string when present");
  }
  validatePathSegment("subagent", body.subagent);
}

function validateOnlineRecord(body: Record<string, unknown>): void {
  requireNonEmptyString(body, "agent");
  requireTimestamp(body, "started_at");
  requireTimestamp(body, "ended_at");

  if (body.protocol === undefined) throw new SessionValidationError(422, "missing field: protocol");
  if (typeof body.protocol !== "string" || !(SESSION_PROTOCOLS as readonly string[]).includes(body.protocol)) {
    throw new SessionValidationError(422, `invalid field: protocol must be one of ${SESSION_PROTOCOLS.join(", ")}`);
  }

  requireNonEmptyString(body, "model");

  if (body.status === undefined) throw new SessionValidationError(422, "missing field: status");
  if (typeof body.status !== "number" || !Number.isInteger(body.status) || body.status < 0) {
    throw new SessionValidationError(422, "invalid field: status must be a non-negative integer");
  }

  for (const field of ["trace_id", "upstream_request_id"]) {
    if (field in body && (typeof body[field] !== "string" || (body[field] as string).length === 0)) {
      throw new SessionValidationError(422, `invalid field: ${field} must be a non-empty string when present`);
    }
  }

  if (body.request === undefined) throw new SessionValidationError(422, "missing field: request");
  if (!isPlainObject(body.request)) {
    throw new SessionValidationError(422, "invalid field: request must be an object");
  }

  if (body.response === undefined) throw new SessionValidationError(422, "missing field: response");
  if (!isPlainObject(body.response) && typeof body.response !== "string") {
    throw new SessionValidationError(422, "invalid field: response must be an object or a string");
  }

  if ("compression_observations" in body) {
    const obs = body.compression_observations;
    if (!Array.isArray(obs) || !obs.every(isPlainObject)) {
      throw new SessionValidationError(422, "invalid field: compression_observations must be an array of objects when present");
    }
  }
}

function validateOfflineRecord(body: Record<string, unknown>): void {
  requireTimestamp(body, "started_at");
  requireTimestamp(body, "ended_at");

  if (body.user_query === undefined) throw new SessionValidationError(422, "missing field: user_query");
  if (typeof body.user_query !== "string") {
    throw new SessionValidationError(422, "invalid field: user_query must be a string");
  }

  requireNonEmptyString(body, "model");

  if (body.messages === undefined) throw new SessionValidationError(422, "missing field: messages");
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new SessionValidationError(422, "invalid field: messages must be a non-empty array");
  }

  if (body.output === undefined) throw new SessionValidationError(422, "missing field: output");
  if (!isPlainObject(body.output)) {
    throw new SessionValidationError(422, "invalid field: output must be an object");
  }
}

/**
 * Validate a `/v3/session/add` body. Throws {@link SessionValidationError}:
 *   - 400: `source` is not `online` / `offline`, or `subagent` is not a valid path segment
 *   - 422: body not an object, an identity field / unknown field present,
 *          required field missing or of the wrong type / format
 *
 * An online body with `messages` follows the turn rules (legacy MemoryProxy).
 */
export function validateSessionAddBody(body: unknown): SessionAddInput {
  if (!isPlainObject(body)) {
    throw new SessionValidationError(422, "request body must be a JSON object");
  }

  const source = body.source;
  if (typeof source !== "string" || !(SESSION_SOURCES as readonly string[]).includes(source)) {
    throw new SessionValidationError(400, "invalid source: must be 'online' or 'offline'");
  }
  const kind = source === "online" && !("messages" in body) ? "call" : "turn";
  const allowed = kind === "call" ? RECORD_FIELDS.online : RECORD_FIELDS.offline;

  for (const key of Object.keys(body)) {
    if (key === "source") continue;
    const header = IDENTITY_FIELDS[key];
    if (header) {
      throw new SessionValidationError(422, `field not allowed: ${key} (taken from ${header} header)`);
    }
    if (!allowed.has(key)) {
      throw new SessionValidationError(422, `unknown field: ${key}`);
    }
  }

  if (kind === "call") validateOnlineRecord(body);
  else validateOfflineRecord(body);
  validateSubagent(body);

  const { source: _source, ...record } = body;
  return kind === "call"
    ? { source: "online", kind, record: record as SessionCallFields }
    : { source: source as SessionSource, kind, record: record as SessionTurnFields };
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
 * Persist one record. The stored object is the validated body minus `source`,
 * plus the identity from the request headers: `instance` / `team` / `user` /
 * `session` for call records, `user` / `session` for turn records.
 */
export async function writeSessionRecord(
  storage: StorageAdapter,
  identity: SessionIdentity,
  input: SessionAddInput,
  opts: { signal?: AbortSignal } = {},
): Promise<SessionWriteResult> {
  const { signal } = opts;
  signal?.throwIfAborted();
  const { record } = input;
  const objectKey = buildSessionObjectKey({
    source: input.source,
    team: identity.team,
    user: identity.user,
    session: identity.session,
    subagent: record.subagent,
    startedAt: record.started_at,
  });
  const header = input.kind === "call"
    ? { instance: identity.instance, team: identity.team, user: identity.user, session: identity.session }
    : { user: identity.user, session: identity.session };
  const content = Buffer.from(JSON.stringify({ ...header, ...record }), "utf-8");
  await storage.writeFile(objectKey, content, { signal });
  return { object_key: objectKey, bytes: content.length };
}

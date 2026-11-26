/**
 * POST one call record to MemoryCore `/v3/session/add`
 * (MemoryCore/docs/session-api.md).
 *
 * Every call writes a new object, so only failures that cannot have written
 * anything are retried: 500, 503 and network errors. 413 / 422 mean the record
 * itself is bad and 400 / 401 will not change on retry; those records are
 * dropped with a log line.
 */

import { log } from "../report/log.js";
import type { SessionCallBody } from "./record.js";

export const SESSION_ADD_PATH = "/v3/session/add";
export const SESSION_ADD_MAX_BODY_BYTES = 32 * 1024 * 1024;

const RETRYABLE_STATUSES = new Set([500, 503]);
const MAX_ID_BYTES = 256;

export interface SessionIdentity {
  serviceId: string;
  userId: string;
  sessionId: string;
  teamId?: string;
}

export interface SessionUploadTarget {
  endpoint: string;
  apiKey: string;
}

export interface SessionUploadOptions {
  attempts?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export type SessionUploadOutcome = "ok" | "dropped" | "failed";

export interface SessionUploadResult {
  outcome: SessionUploadOutcome;
  /** Core's `object_key`, relative to the instance root; only on `ok`, and only when Core returned one. */
  objectKey?: string;
}

/**
 * Mirrors Core's path-segment rule, and additionally requires printable ASCII
 * because the value travels as an HTTP header.
 */
export function isValidIdSegment(value: string): boolean {
  if (!value || value === "." || value === "..") return false;
  if (Buffer.byteLength(value, "utf-8") > MAX_ID_BYTES) return false;
  return /^[\x20-\x7e]+$/.test(value) && !value.includes("/") && !value.includes("\\");
}

function invalidIdField(identity: SessionIdentity, body: SessionCallBody): string | null {
  if (!isValidIdSegment(identity.serviceId)) return "x-tdai-service-id";
  if (!isValidIdSegment(identity.userId)) return "x-tdai-user-id";
  if (!isValidIdSegment(identity.sessionId)) return "x-tdai-session-id";
  if (identity.teamId !== undefined && !isValidIdSegment(identity.teamId)) return "x-tdai-team-id";
  if (body.subagent !== undefined && !isValidIdSegment(body.subagent)) return "subagent";
  return null;
}

function buildHeaders(target: SessionUploadTarget, identity: SessionIdentity): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${target.apiKey || "local-proxy"}`,
    "x-tdai-service-id": identity.serviceId,
    "x-tdai-user-id": identity.userId,
    "x-tdai-session-id": identity.sessionId,
  };
  if (identity.teamId) headers["x-tdai-team-id"] = identity.teamId;
  return headers;
}

/** A validated, serialized record; holds no reference to the source body. */
export interface PreparedSessionUpload {
  url: string;
  headers: Record<string, string>;
  /** UTF-8 JSON, kept off the V8 heap and sized exactly as counted against byte budgets. */
  payload: Buffer<ArrayBuffer>;
  bytes: number;
  logData: Record<string, unknown>;
}

/** Returns null when the record is dropped locally (logged here). */
export function prepareSessionUpload(
  target: SessionUploadTarget,
  identity: SessionIdentity,
  body: SessionCallBody,
): PreparedSessionUpload | null {
  const logData = {
    service: identity.serviceId,
    team: identity.teamId,
    user: identity.userId,
    session: identity.sessionId,
    subagent: body.subagent,
    agent: body.agent,
    protocol: body.protocol,
    model: body.model,
    status: body.status,
  };

  const badField = invalidIdField(identity, body);
  if (badField) {
    log.warn("【P1】session-trace:drop_invalid_id", { ...logData, field: badField });
    return null;
  }

  let payload: Buffer<ArrayBuffer>;
  try {
    payload = Buffer.from(JSON.stringify(body), "utf-8");
  } catch (err) {
    log.warn("【P1】session-trace:drop_unserializable", { ...logData, error: String(err) });
    return null;
  }
  const bytes = payload.length;
  if (bytes > SESSION_ADD_MAX_BODY_BYTES) {
    log.warn("【P1】session-trace:drop_too_large", { ...logData, bytes });
    return null;
  }

  return {
    url: `${target.endpoint.replace(/\/$/, "")}${SESSION_ADD_PATH}`,
    headers: buildHeaders(target, identity),
    payload,
    bytes,
    logData,
  };
}

export async function sendSessionUpload(
  prepared: PreparedSessionUpload,
  opts: SessionUploadOptions = {},
): Promise<SessionUploadResult> {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  // Above Core's 15 s write deadline plus body transfer and parse, so Core answers before the abort.
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { url, headers, payload, bytes, logData } = prepared;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let retryReason: string;
    try {
      const res = await fetchImpl(url, { method: "POST", headers, body: payload, signal: controller.signal });
      const text = await res.text().catch(() => "");
      if (res.ok) {
        let objectKey: unknown;
        try {
          objectKey = (JSON.parse(text) as { data?: { object_key?: unknown } }).data?.object_key;
        } catch {
          objectKey = undefined;
        }
        const key = typeof objectKey === "string" && objectKey ? objectKey : undefined;
        log.info("session-trace:uploaded", { ...logData, bytes, attempt, object_key: key });
        return key ? { outcome: "ok", objectKey: key } : { outcome: "ok" };
      }
      if (!RETRYABLE_STATUSES.has(res.status)) {
        log.warn("【P1】session-trace:drop_rejected", { ...logData, bytes, status: res.status, response: text.slice(0, 500) });
        return { outcome: "dropped" };
      }
      retryReason = `HTTP ${res.status}`;
    } catch (err) {
      retryReason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    } finally {
      clearTimeout(timer);
    }

    if (attempt === attempts) {
      log.error("【P1】session-trace:upload_failed", { ...logData, bytes, attempts, reason: retryReason });
      return { outcome: "failed" };
    }
    log.warn("【P1】session-trace:retry", { ...logData, attempt, reason: retryReason });
    await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
  }
  return { outcome: "failed" };
}

export async function uploadSessionCall(
  target: SessionUploadTarget,
  identity: SessionIdentity,
  body: SessionCallBody,
  opts: SessionUploadOptions = {},
): Promise<SessionUploadResult> {
  const prepared = prepareSessionUpload(target, identity, body);
  return prepared ? sendSessionUpload(prepared, opts) : { outcome: "dropped" };
}

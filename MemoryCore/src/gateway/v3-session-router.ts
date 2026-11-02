/**
 * v3 session route (`POST /v3/session/add`).
 *
 * Contract: docs/session-api.md. Writes one turn record per call through
 * the per-instance StorageAdapter (standalone → local FS, service → COS).
 *
 * Deliberately not part of handleV2Route: identity comes from headers only
 * (no agent, body must not carry user/session), a missing header is 400
 * rather than 401, and the body limit is the session-specific one supplied
 * by the caller through `parseBody`.
 */

import type * as http from "node:http";
import { successEnvelope, errorEnvelope, resolveRequestId } from "./v2-router.js";
import { classifyError, sanitize } from "./error-handler.js";
import type { Logger } from "../core/types.js";
import type { StorageAdapter } from "../core/storage/adapter.js";
import {
  SessionValidationError,
  UNASSIGNED_TEAM,
  validatePathSegment,
  validateSessionAddBody,
  writeSessionTurn,
  type SessionAddInput,
  type SessionIdentity,
} from "../core/session/session-record.js";

export const V3_SESSION_ADD_PATH = "/v3/session/add";
const TAG = "[tdai-gateway][v3-session]";

export interface V3SessionRouterDeps {
  /** Per-instance storage; throwing means storage is unavailable (503). */
  resolveStorage: (instanceId: string) => Promise<StorageAdapter>;
  logger: Logger;
}

function headerValue(headers: http.IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

function requireHeader(headers: http.IncomingHttpHeaders, name: string): string {
  const value = headerValue(headers, name);
  if (value === undefined) throw new SessionValidationError(400, `missing header: ${name}`);
  validatePathSegment(name, value);
  return value;
}

function parseIdentity(headers: http.IncomingHttpHeaders): { instanceId: string; identity: SessionIdentity } {
  const instanceId = requireHeader(headers, "x-tdai-service-id");
  const user = requireHeader(headers, "x-tdai-user-id");
  const session = requireHeader(headers, "x-tdai-session-id");
  const rawTeam = headerValue(headers, "x-tdai-team-id");
  const team = rawTeam === undefined || rawTeam === "" ? UNASSIGNED_TEAM : rawTeam;
  if (team !== UNASSIGNED_TEAM) validatePathSegment("x-tdai-team-id", team);
  return { instanceId, identity: { team, user, session } };
}

export async function handleV3SessionRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  parseBody: (req: http.IncomingMessage) => Promise<unknown>,
  sendJson: (res: http.ServerResponse, status: number, body: unknown) => void,
  deps: V3SessionRouterDeps,
): Promise<boolean> {
  if (method !== "POST" || pathname !== V3_SESSION_ADD_PATH) return false;

  const requestId = resolveRequestId(req.headers as Record<string, string | string[] | undefined>);
  const fail = (code: number, message: string) => sendJson(res, code, errorEnvelope(code, message, requestId));

  let instanceId: string;
  let identity: SessionIdentity;
  let input: SessionAddInput;
  try {
    ({ instanceId, identity } = parseIdentity(req.headers));
    let body: unknown;
    try {
      body = await parseBody(req);
    } catch (err) {
      const classified = classifyError(err);
      deps.logger.warn(`${TAG} body rejected: ${classified.logLine}`);
      fail(classified.status, classified.client.message);
      return true;
    }
    input = validateSessionAddBody(body);
  } catch (err) {
    if (err instanceof SessionValidationError) {
      fail(err.status, err.message);
      return true;
    }
    deps.logger.error(`${TAG} unexpected error: ${sanitize(err instanceof Error ? err.message : String(err))}`);
    fail(500, "Internal server error");
    return true;
  }

  try {
    const storage = await deps.resolveStorage(instanceId);
    const result = await writeSessionTurn(storage, identity, input);
    sendJson(res, 200, successEnvelope(result, requestId));
  } catch (err) {
    deps.logger.error(
      `${TAG} write failed (instance=${instanceId}): ${sanitize(err instanceof Error ? err.message : String(err))}`,
    );
    fail(503, "Session storage unavailable");
  }
  return true;
}

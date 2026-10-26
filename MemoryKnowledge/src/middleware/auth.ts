/**
 * Service-to-service auth middleware.
 *
 * Security Model:
 *   - KNOWLEDGE_SERVICE_KEY empty: Auth disabled; listener policy is enforced separately;
 *   - KNOWLEDGE_SERVICE_KEY set: ALL service API endpoints under apiPrefix require
 *     `Authorization: Bearer <serviceKey>`. Missing or invalid tokens return 401 (fail-closed).
 *
 * All service API routes (read, write, tools, internal, auto-sync, analytics) require
 * authentication when serviceKey is configured. Memory data is sensitive and must not
 * allow unauthenticated reads.
 *
 * Caller-supplied `x-tdai-service-id` or `team_id` headers represent multi-tenancy scoping
 * boundaries and are NEVER treated as caller authentication.
 *
 * Public endpoints:
 *   /health, /docs, /openapi.json are mounted outside apiPrefix (in server.ts)
 *   and remain public for liveness probes and documentation.
 *
 * Credentials and rejected request content are never logged.
 */

import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { wrapError } from "../api-helpers.js";
import { createLogger } from "../logger.js";

const log = createLogger("auth");

export interface KnowledgeAuthConfig {
  serviceKey: string;
}

/**
 * Timing-safe string comparison. When lengths differ, still performs
 * a comparison against self; this does not hide input lengths.
 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/** Pure function: validates that Authorization header is `Bearer <serviceKey>`. */
export function verifyBearer(authHeader: string | undefined, serviceKey: string): boolean {
  if (!authHeader || !serviceKey) return false;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authHeader);
  if (!m) return false;
  return safeEqual(m[1], serviceKey);
}

/**
 * Hono auth middleware factory.
 * Applied to service API endpoints. Validates Bearer token before request body
 * is read or telemetry/handlers are executed.
 */
export function createServiceAuthMiddleware(
  cfg: KnowledgeAuthConfig,
  _apiPrefix: string,
): MiddlewareHandler {
  return async (c, next) => {
    // Unconfigured key = auth disabled; listener posture is a separate concern.
    if (!cfg.serviceKey) return next();

    if (verifyBearer(c.req.header("authorization"), cfg.serviceKey)) return next();

    // Paths may contain private identifiers; do not log caller-controlled fields.
    log.warn("rejected unauthenticated request");
    return c.json(wrapError(401, "unauthorized: valid service key required"), 401);
  };
}

/**
 * Auth service client — verifies user_key and resolves user_id via auth/verify API.
 *
 * Features:
 * - Every call goes directly to the auth service (no caching)
 * - Returns structured result to allow caller to reject invalid keys
 * - x-tdai-service-id is derived from the request path's spaceId (not config)
 * - Configurable via YAML `auth` section
 */

import { log } from "./report/log.js";
import type { AuthConfig } from "./types.js";

export type { AuthConfig };

/** Result of verifyUserKey call. */
export interface VerifyUserResult {
  /** User ID if verified successfully; empty string otherwise. */
  userId: string;
  /** True when auth is enabled and verification did NOT return valid=true. */
  rejected: boolean;
  /** Error detail for logging/response when rejected. */
  rejectReason?: string;
}

// ── Module state ──────────────────────────────────────────────────────────────

let config: AuthConfig | null = null;

/**
 * Initialize the auth client.
 * Must be called once at startup. Idempotent.
 */
export function initAuth(cfg: AuthConfig): void {
  if (!cfg.enabled) {
    config = null;
    return;
  }
  if (!cfg.url) {
    log.warn("auth.init.skipped", { reason: "empty url" });
    config = null;
    return;
  }
  config = cfg;
  log.info("auth.init", { url: cfg.url });
}

/** Check if auth verification is enabled. */
export function isAuthEnabled(): boolean {
  return config != null;
}

/**
 * Verify a user_key (API key from the client request) and resolve to a user_id.
 *
 * When auth is enabled, the principle is:
 * **Any result that is NOT valid=true with a user_id → reject the request.**
 *
 * The request carries `Authorization: Bearer <gatewayApiKey>` when
 * `auth.gatewayApiKey` is configured — the gateway's shared secret
 * (TDAI_GATEWAY_API_KEY / server.apiKey). Without it, a gateway with its
 * Bearer gate enabled rejects these calls with 401 and session-init breaks;
 * sending it lets operators enable the gateway key while proxy auth stays on.
 *
 * @param userKey - The client's API key (user_key)
 * @param serviceId - The service/instance ID from request path spaceId (used as x-tdai-service-id)
 *
 * Returns a structured result:
 * - `{ userId: "usr-xxx", rejected: false }` — verified successfully
 * - `{ userId: "", rejected: true, rejectReason }` — auth enabled but verification failed
 * - `{ userId: "", rejected: false }` — auth not enabled (passthrough)
 *
 * This function never throws.
 * Each call directly queries the auth service (no caching).
 */
export async function verifyUserKey(userKey: string, serviceId: string): Promise<VerifyUserResult> {
  if (!config) return { userId: "", rejected: false };
  if (!serviceId) return { userId: "", rejected: true, rejectReason: "missing service_id (spaceId not in request path)" };
  if (!userKey) return { userId: "", rejected: true, rejectReason: "missing user_key" };

  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-tdai-service-id": serviceId,
    };
    if (config.gatewayApiKey) {
      headers["authorization"] = `Bearer ${config.gatewayApiKey}`;
    }
    const fetchOpts: RequestInit = {
      method: "POST",
      headers,
      body: JSON.stringify({ user_key: userKey }),
    };
    if (config.timeoutMs > 0) {
      fetchOpts.signal = AbortSignal.timeout(config.timeoutMs);
    }

    const url = config.url.replace(/\/+$/, "") + "/v3/meta/auth/verify";
    const resp = await fetch(url, fetchOpts);

    if (!resp.ok) {
      const reason = `auth service returned HTTP ${resp.status}`;
      log.warn("auth.verify.httpError", { status: resp.status, serviceId });
      return { userId: "", rejected: true, rejectReason: reason };
    }

    const body = await resp.json() as {
      code?: number;
      data?: { valid?: boolean; user?: { user_id?: string } };
    };

    // Only accept: code=0 AND valid=true AND user_id present
    if (body.code === 0 && body.data?.valid === true && body.data.user?.user_id) {
      return { userId: body.data.user.user_id, rejected: false };
    }

    // Everything else is a rejection
    const reason = body.data?.valid === false
      ? "invalid user_key"
      : `unexpected verify response (code=${body.code})`;
    return { userId: "", rejected: true, rejectReason: reason };
  } catch (err: unknown) {
    const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
    const reason = isTimeout
      ? `auth service timeout (${config.timeoutMs}ms)`
      : `auth service error: ${err instanceof Error ? err.message : String(err)}`;
    log.warn("auth.verify.error", { error: reason, serviceId });
    return { userId: "", rejected: true, rejectReason: reason };
  }
}

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
  failureStatus?: 401 | 502 | 503 | 504;
}

// ── Module state ──────────────────────────────────────────────────────────────

let config: AuthConfig | null = null;

/**
 * auth.invalid_user_key 日志节流：按 serviceId 维度 30s 窗口（cos-storage 同款）。
 * 同一把错 key 会每请求都触发 401，不去重会随请求量刷屏；不同实例的错 key
 * 是独立事件，故按 serviceId 分维度而非全局单时间戳。容量上限防维度膨胀。
 */
const invalidUserKeyLoggedAt = new Map<string, number>();
const INVALID_USER_KEY_LOG_CAP = 1_000;

function logInvalidUserKey(serviceId: string): void {
  const now = Date.now();
  const last = invalidUserKeyLoggedAt.get(serviceId);
  if (last !== undefined && now - last < 30_000) return;
  if (invalidUserKeyLoggedAt.size >= INVALID_USER_KEY_LOG_CAP) invalidUserKeyLoggedAt.clear();
  invalidUserKeyLoggedAt.set(serviceId, now);
  log.warn("【P0】auth.invalid_user_key", { serviceId });
}

/**
 * Initialize the auth client.
 * Must be called once at startup. Idempotent.
 */
export function initAuth(cfg: AuthConfig): void {
  if (!cfg.enabled) {
    config = null;
    return;
  }
  if (!cfg.url.trim()) {
    throw new Error("auth.url is required when auth is enabled");
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
  if (!serviceId) return { userId: "", rejected: true, failureStatus: 401, rejectReason: "missing service_id (spaceId not in request path)" };
  if (!userKey) return { userId: "", rejected: true, failureStatus: 401, rejectReason: "missing user_key" };

  let readingResponse = false;
  const signal = config.timeoutMs > 0 ? AbortSignal.timeout(config.timeoutMs) : undefined;
  try {
    const fetchOpts: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tdai-service-id": serviceId,
      },
      body: JSON.stringify({ user_key: userKey }),
    };
    fetchOpts.signal = signal;

    const url = config.url.replace(/\/+$/, "") + "/v3/meta/auth/verify";
    const resp = await fetch(url, fetchOpts);

    if (!resp.ok) {
      const reason = `auth service returned HTTP ${resp.status}`;
      log.warn("【P0】auth.verify.httpError", { status: resp.status, serviceId });
      return { userId: "", rejected: true, failureStatus: resp.status === 504 ? 504 : resp.status === 503 ? 503 : 502, rejectReason: reason };
    }

    readingResponse = true;
    const body = await resp.json() as {
      code?: number;
      data?: { valid?: boolean; user?: { user_id?: unknown } };
    } | null;
    if (body?.code === 0 && body.data?.valid === true && typeof body.data.user?.user_id === "string" && body.data.user.user_id.trim()) {
      return { userId: body.data.user.user_id, rejected: false };
    }
    if (body?.code === 0 && body.data?.valid === false) {
      logInvalidUserKey(serviceId);
      return { userId: "", rejected: true, failureStatus: 401, rejectReason: "invalid user_key" };
    }
    return { userId: "", rejected: true, failureStatus: 502, rejectReason: "unexpected verify response" };
  } catch (err: unknown) {
    const isTimeout = signal?.aborted || (err instanceof Error && err.name === "TimeoutError");
    const failureStatus = isTimeout ? 504 : readingResponse ? 502 : 503;
    const reason = isTimeout ? "auth service timeout" : readingResponse ? "invalid auth service response" : "auth service unavailable";
    log.warn("【P0】auth.verify.error", { status: failureStatus, serviceId });
    return { userId: "", rejected: true, failureStatus, rejectReason: reason };
  }
}

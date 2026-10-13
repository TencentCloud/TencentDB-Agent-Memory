/**
 * Model-pool service name (`tdai-code-o5`) on the chat / messages entrances.
 *
 * Clients name the pool, never a member. While the extension's pool is live the
 * request is pointed at the pool primary and left for the router to re-target;
 * the main-model pin, the pricing gate and alias resolution do not apply because
 * the pool name is not a pricing entry and the router picks the real model.
 * While the pool is off the name falls back to `POOL_FALLBACK_MODEL` and the
 * request takes the ordinary path. Either way responses keep reporting the
 * pool name (see response-model-mask.ts).
 *
 * The Responses-API entrances (codex / workbuddy) and /direct never route, so
 * they reject the pool name instead (`poolServiceRejection`).
 */

import { poolServiceFor } from "./guard-adapter.js";
import type { ProxyConfig } from "./types.js";

export const POOL_FALLBACK_MODEL = "claude-opus-5";

export interface PoolServiceGate {
  /** Model name to report back to the client; null when the request did not name the pool. */
  clientFacingModel: string | null;
  /** body.model now holds the pool primary and the router owns the choice. */
  routed: boolean;
}

/** Rewrite `body.model` when it names the pool service. */
export function applyPoolService(config: ProxyConfig, body: Record<string, unknown>): PoolServiceGate {
  const info = poolServiceFor(config);
  if (body.model !== info.serviceName) return { clientFacingModel: null, routed: false };
  if (info.active && info.primaryModel) {
    body.model = info.primaryModel;
    return { clientFacingModel: info.serviceName, routed: true };
  }
  body.model = POOL_FALLBACK_MODEL;
  return { clientFacingModel: info.serviceName, routed: false };
}

/** 400 body for entrances that never route, or null when the request may proceed. */
export function poolServiceRejection(config: ProxyConfig, model: unknown): Record<string, unknown> | null {
  const { serviceName } = poolServiceFor(config);
  if (model !== serviceName) return null;
  return {
    type: "error",
    error: {
      type: "invalid_request_error",
      message: `Model '${serviceName}' is only served on the chat/completions and messages endpoints`,
    },
  };
}

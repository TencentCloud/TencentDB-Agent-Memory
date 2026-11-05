import type { ProxyConfig } from "../types.js";
import { getRedisClient } from "../db/redis-client.js";
import { log } from "../report/log.js";
import { RedisRateLimitStore, type RateLimitDecision } from "./redis-store.js";
import { getActualInputTokens, type UsageProtocol } from "./usage.js";

export type RateLimitProtocol = "openai" | "anthropic";

export class RateLimitExceededError extends Error {
  constructor(public readonly response: Response) {
    super("Rate limit exceeded");
    this.name = "RateLimitExceededError";
  }
}

let store: RedisRateLimitStore | null = null;
let lastDegradedWarningAt = 0;

export function getRateLimitStore(config: ProxyConfig): RedisRateLimitStore {
  if (!store) {
    store = new RedisRateLimitStore(
      getRedisClient(config.redis),
      config.rateLimit,
    );
  }
  return store;
}

export async function enforceRateLimit(params: {
  config: ProxyConfig;
  instanceId?: string;
  modelId: string;
  protocol: RateLimitProtocol;
}): Promise<void> {
  const { config, instanceId, modelId, protocol } = params;
  if (!config.rateLimit || (config.rateLimit.tpm <= 0 && config.rateLimit.qpm <= 0) || !instanceId) return;

  const decision = await getRateLimitStore(config).checkRequest(instanceId, modelId);

  if (decision.degraded) {
    const now = Date.now();
    if (now - lastDegradedWarningAt >= 30_000) {
      lastDegradedWarningAt = now;
      log.warn("rate_limit.fail_open", {
        instanceId,
        modelId,
        reason: decision.degradedReason ?? "redis_unavailable",
      });
    }
    return;
  }

  log.info("rate_limit.decision", {
    instanceId,
    modelId,
    tpm: decision.tpm,
    qpm: decision.qpm,
    usedTokens: decision.usedTokens,
    usedRequests: decision.usedRequests,
    remainingTokens: decision.remainingTokens,
    remainingRequests: decision.remainingRequests,
    allowed: decision.allowed,
    reason: decision.reason,
  });

  if (!decision.allowed) {
    throw new RateLimitExceededError(buildRateLimitResponse(protocol, decision));
  }
}

/** Record actual input tokens after an upstream response exposes usage. */
export async function recordInputTokenUsage(params: {
  config: ProxyConfig;
  instanceId?: string;
  modelId: string;
  usage: Record<string, unknown> | null | undefined;
  protocol: UsageProtocol;
}): Promise<void> {
  const { config, instanceId, modelId, usage, protocol } = params;
  if (!config.rateLimit || config.rateLimit.tpm <= 0 || !instanceId) return;
  const inputTokens = getActualInputTokens(usage, protocol);
  if (inputTokens <= 0) return;
  const recorded = await getRateLimitStore(config).recordInputTokens(instanceId, modelId, inputTokens);
  if (recorded) {
    log.info("rate_limit.usage_recorded", { instanceId, modelId, inputTokens });
  }
  // A false return means either Redis is intentionally absent (limiter off) or the
  // eval failed — the latter is logged with error detail by the store as
  // rate_limit.record_failed, so we don't double-log a generic warning here.
}

export function buildRateLimitResponse(
  protocol: RateLimitProtocol,
  decision: RateLimitDecision,
): Response {
  const message = decision.reason === "qpm"
    ? "该模型请求频率已达上限，请稍后重试"
    : "该模型输入 Token 用量已达上限，请稍后重试";
  const code = decision.reason === "qpm" ? "qpm_exceeded" : "input_tpm_exceeded";
  const body = protocol === "anthropic"
    ? { type: "error", error: { type: "rate_limit_error", message } }
    : {
        error: {
          message,
          type: "rate_limit_error",
          code,
          param: null,
        },
      };

  return new Response(JSON.stringify(body), {
    status: 429,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "retry-after": String(Math.max(1, decision.retryAfterSeconds)),
      "x-ratelimit-limit-input-tokens": String(decision.tpm),
      "x-ratelimit-remaining-input-tokens": String(decision.remainingTokens),
      "x-ratelimit-limit-requests": String(decision.qpm),
      "x-ratelimit-remaining-requests": String(decision.remainingRequests),
      "x-ratelimit-reset-seconds": String(Math.max(1, decision.retryAfterSeconds)),
    },
  });
}

export function isRateLimitExceededError(error: unknown): error is RateLimitExceededError {
  return error instanceof RateLimitExceededError;
}

/** Test-only reset. */
export function __resetRateLimitStoreForTests(): void {
  store = null;
  lastDegradedWarningAt = 0;
}

/** Test-only injection hook. */
export function __setRateLimitStoreForTests(testStore: RedisRateLimitStore): void {
  store = testStore;
}

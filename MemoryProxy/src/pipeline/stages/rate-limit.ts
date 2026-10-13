/**
 * stages/rate-limit.ts — 限流 stage (Phase 4)。
 *
 * 提取自 handler.ts:1606-1623 / anthropicHandler.ts:1499-1520 的 enforceRateLimit
 * 调用。codex/wb 原本缺失 (handler-audit bug B1 P0), Phase 5.7 opt-in 时通过
 * stageGates.rateLimit=true 生效。
 *
 * 与 stages/credit.ts 类似, 本 stage 是薄包装, 委托给 rate-limit/guard.ts。
 */

import type { ProxyConfig } from "../../types.js";
import {
  enforceRateLimit,
  isRateLimitExceededError,
  recordInputTokenUsage,
} from "../../rate-limit/guard.js";
import type { RateLimitProtocol } from "../../rate-limit/guard.js";
import type { UsageProtocol } from "../../rate-limit/usage.js";

export interface RateLimitEnforceInput {
  config: ProxyConfig;
  instanceId?: string;
  modelId: string;
  protocol: RateLimitProtocol;
  isCustomUpstream: boolean;
}

export interface RateLimitRecordInput {
  config: ProxyConfig;
  instanceId?: string;
  modelId: string;
  usage: Record<string, unknown> | null | undefined;
  protocol: UsageProtocol;
  isCustomUpstream: boolean;
}

/**
 * 前置限流 stage。命中限流抛 RateLimitExceededError, caller 转 429。
 * custom upstream 短路 (isCustomUpstream=true 时不入限流账本)。
 */
export async function stageEnforceRateLimit(input: RateLimitEnforceInput): Promise<void> {
  if (input.isCustomUpstream) return;
  await enforceRateLimit({
    config: input.config,
    instanceId: input.instanceId,
    modelId: input.modelId,
    protocol: input.protocol,
  });
}

/** stream/non-stream 完成后 → 把实际用量塞回限流桶 */
export async function stageRecordInputTokenUsage(input: RateLimitRecordInput): Promise<void> {
  if (input.isCustomUpstream) return;
  await recordInputTokenUsage({
    config: input.config,
    instanceId: input.instanceId,
    modelId: input.modelId,
    usage: input.usage,
    protocol: input.protocol,
  });
}

export { isRateLimitExceededError };

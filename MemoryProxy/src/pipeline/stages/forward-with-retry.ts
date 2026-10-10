/**
 * stages/forward-with-retry.ts — 完整 fetch + retry 编排 stage。
 *
 * 提取自 openai-chat + anthropic runner 各 ~150 行 forwardWithRetry 函数。
 * 差异通过参数化保留:
 *   - protocol: 'openai' | 'anthropic' — rate-limit tag
 *   - retryBodyBuilder: openai 覆写 model, anthropic 不改
 *   - timeoutBehavior: openai 走 gate > 0, anthropic 恒开
 *   - debugOutboundMd5: openai/anthropic 各有独立打印格式, 由 caller 传函数
 *
 * ⚠️ debug dump body 部分保留在 caller (openai 有, anthropic 没有), 因为它
 * 需要访问 upstream body/headers 各自复本, 且各自 dump 文件路径都是 debug env
 * gate 的; 不 stage 化。
 */

import type { ProxyConfig } from "../../types.js";
import type { ForwardTarget } from "../../guard-adapter.js";
import type { createPipeline } from "../../logger.js";
import { enforceRateLimit, isRateLimitExceededError } from "../../rate-limit/guard.js";

export interface ForwardWithRetryInput {
  target: ForwardTarget;
  upstreamHeaders: Record<string, string>;
  upstreamBody: Record<string, unknown>;
  originalBody: Record<string, unknown>;
  originalHeaders: Record<string, string>;
  pipe: ReturnType<typeof createPipeline>;
  forwardTimeoutMs: number;
  sessionKeyForDebug?: string;
  rateLimitContext?: { config: ProxyConfig; instanceId?: string };
  protocol: "openai" | "anthropic";
  /**
   * timeout gating semantics:
   *   - "gated": openai style, 只有 forwardTimeoutMs > 0 才设 AbortSignal
   *   - "always": anthropic style, 总是设 AbortSignal.timeout
   */
  timeoutBehavior: "gated" | "always";
  /**
   * retry body 构建函数. openai 版本: `{...originalBody, model: retryTarget.model}`;
   * anthropic 版本: originalBody 原样返回。
   */
  buildRetryBody: (originalBody: Record<string, unknown>, retryModel: string) => Record<string, unknown>;
}

export interface ForwardWithRetryResult {
  resp: Response;
  retried: boolean;
}

/**
 * 完整 forward+retry 编排。抛 RateLimitExceededError 时上层需 catch (转 429)。
 * 抛 Error("Upstream request failed") 时 caller 需转 502。
 */
export async function stageForwardWithRetry(
  input: ForwardWithRetryInput,
): Promise<ForwardWithRetryResult> {
  let upstreamResp: Response | undefined;
  let forwardFailed = false;

  const setTimeoutSignal = (init: RequestInit) => {
    if (input.timeoutBehavior === "always") {
      init.signal = AbortSignal.timeout(input.forwardTimeoutMs);
    } else if (input.forwardTimeoutMs > 0) {
      init.signal = AbortSignal.timeout(input.forwardTimeoutMs);
    }
  };

  if (input.rateLimitContext) {
    await enforceRateLimit({
      config: input.rateLimitContext.config,
      instanceId: input.rateLimitContext.instanceId,
      modelId: input.target.model,
      protocol: input.protocol,
    });
  }

  const primaryFetchOpts: RequestInit = {
    method: "POST",
    headers: input.upstreamHeaders,
    body: JSON.stringify(input.upstreamBody),
  };
  setTimeoutSignal(primaryFetchOpts);

  try {
    upstreamResp = await fetch(input.target.url, primaryFetchOpts);
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      input.pipe.error("FORWARD", `Timeout after ${input.forwardTimeoutMs / 1000}s`);
    } else {
      input.pipe.error("FORWARD", err);
    }
    forwardFailed = true;
  }

  if (upstreamResp) {
    input.pipe.forwardDone(upstreamResp.status, upstreamResp.headers.get("x-request-id") ?? undefined);
  }

  const shouldRetry = input.target.retryTarget &&
    (forwardFailed || (upstreamResp && upstreamResp.status >= 400 && upstreamResp.status < 500));

  if (shouldRetry && input.target.retryTarget) {
    const retryTarget = input.target.retryTarget;
    const reason = forwardFailed ? "timeout/error" : `${upstreamResp!.status}`;
    input.pipe.info("RETRY", `Routed model failed (${reason}), ${
      input.protocol === "anthropic"
        ? `retrying with ${retryTarget.model}`
        : `retryUrl=${retryTarget.url} model=${retryTarget.model}`
    }`);

    const retryBody = input.buildRetryBody(input.originalBody, retryTarget.model);
    const retryHeaders: Record<string, string> = { ...input.originalHeaders };
    retryHeaders["content-type"] = "application/json";
    if (input.sessionKeyForDebug) {
      retryHeaders["x-vertex-ai-session-id"] = input.sessionKeyForDebug;
    }

    try {
      if (input.rateLimitContext) {
        await enforceRateLimit({
          config: input.rateLimitContext.config,
          instanceId: input.rateLimitContext.instanceId,
          modelId: retryTarget.model,
          protocol: input.protocol,
        });
      }
      const retryFetchOpts: RequestInit = {
        method: "POST",
        headers: retryHeaders,
        body: JSON.stringify(retryBody),
      };
      setTimeoutSignal(retryFetchOpts);
      upstreamResp = await fetch(retryTarget.url, retryFetchOpts);
      if (upstreamResp.ok) {
        input.pipe.info("RETRY_SUCCESS", `Retry returned ${upstreamResp.status}`);
      } else {
        input.pipe.error("RETRY_FAILED", `Retry returned ${upstreamResp.status}`);
      }
      return { resp: upstreamResp, retried: true };
    } catch (retryErr: unknown) {
      if (isRateLimitExceededError(retryErr)) throw retryErr;
      if (retryErr instanceof DOMException && retryErr.name === "TimeoutError") {
        input.pipe.error("RETRY_FORWARD", `Timeout after ${input.forwardTimeoutMs / 1000}s`);
      } else {
        input.pipe.error("RETRY_FORWARD", retryErr);
      }
      throw new Error("Upstream request failed");
    }
  }

  if (forwardFailed && !shouldRetry) {
    throw new Error("Upstream request failed");
  }

  if (!upstreamResp) {
    throw new Error("No upstream response available");
  }

  return { resp: upstreamResp, retried: false };
}

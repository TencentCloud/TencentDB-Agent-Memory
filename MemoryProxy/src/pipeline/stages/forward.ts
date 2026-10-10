/**
 * stages/forward.ts — 转发 + retry stage (Phase 4)。
 *
 * 提取自 handler.ts + anthropic 的 forwardWithRetry (含 retryTarget 分支) /
 * codex + wb 的单次 fetch (无 retry)。
 *
 * blueprint §3.1 中风险: anthropic retry 时需 sanitizeForRetry(body); openai retry
 * 直接 `{...originalBody, model: retryTarget.model}`。本 stage 通过
 * protocol.sanitizeForRetry?.() 可选钩子支持两种姿势。
 *
 * codex/wb 的 stageGates.forwardRetry=false + forwardTimeout=false → 走单次
 * fetch 无超时 (与老 codex/wb 100% 等价; Phase 5 opt-in 修 bug B9)。
 */

import type { ForwardTarget } from "../../guard-adapter.js";
import type { ProtocolStrategy } from "../strategies/protocol/types.js";

export interface ForwardStageInput {
  target: ForwardTarget;
  protocol: ProtocolStrategy;
  upstreamUrl: string;
  upstreamHeaders: Record<string, string>;
  upstreamBody: unknown;
  originalBody: Record<string, unknown>;
  /** 0 = 无超时; 走 forwardTimeout gate 时由 caller 传 config.server.forwardTimeoutMs, 关时传 0 */
  forwardTimeoutMs: number;
  /** stageGates.forwardRetry=false 时传 false, 老 codex/wb 行为 */
  retryEnabled: boolean;
}

export interface ForwardStageResult {
  response: Response;
  retried: boolean;
}

export async function stageForward(input: ForwardStageInput): Promise<ForwardStageResult> {
  const primaryResp = await fetchWithOptionalTimeout(
    input.upstreamUrl,
    input.upstreamHeaders,
    input.upstreamBody,
    input.forwardTimeoutMs,
  );

  // retry gate — 只在 retryTarget 存在 + 4xx + retryEnabled 时触发
  if (
    input.retryEnabled
    && input.target.retryTarget
    && primaryResp.status >= 400
    && primaryResp.status < 500
  ) {
    const retryTarget = input.target.retryTarget;
    // retry body: openai = {...orig, model:retryTarget.model}; anthropic 额外走 sanitizeForRetry
    let retryBody: Record<string, unknown> = { ...input.originalBody, model: retryTarget.model };
    if (input.protocol.sanitizeForRetry) {
      retryBody = input.protocol.sanitizeForRetry(retryBody);
    }
    try {
      const retryResp = await fetchWithOptionalTimeout(
        retryTarget.url,
        // retry headers 走 target.authHeaders (含协议特化), 复用主 headers 里的 content-type 等
        { ...input.upstreamHeaders, ...(retryTarget.authHeaders ?? {}) },
        retryBody,
        input.forwardTimeoutMs,
      );
      return { response: retryResp, retried: true };
    } catch (err) {
      console.warn(`[stage-forward] retry failed: ${(err as Error).message}`);
      return { response: primaryResp, retried: false };
    }
  }

  return { response: primaryResp, retried: false };
}

async function fetchWithOptionalTimeout(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<Response> {
  const init: RequestInit = {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
  if (timeoutMs > 0) {
    init.signal = AbortSignal.timeout(timeoutMs);
  }
  return fetch(url, init);
}

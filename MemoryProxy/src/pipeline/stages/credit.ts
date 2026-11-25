/**
 * stages/credit.ts — 计费上报 stage (Phase 1)。
 *
 * 提取自 handler.ts:1972-2006 / anthropicHandler.ts:1896-1930 的完整"上报 +
 * 失败头 + 失败 raw"逻辑, 二者语义 100% 一致。
 *
 * codex/wb 原本缺失 (handler-audit bug B2 P0), Phase 5.6 opt-in 后走本 stage
 * 自动补上; 此前 codex/wb 走 pipeline 时 stageGates.creditReport=false 保持零回归。
 *
 * ⚠️ 与 stream/non-stream 都相关: stream 完成后调用一次, non-stream 收到响应后
 * 调用一次, 各自单独覆盖 (原 handler 就是这样两处 call site 分开)。
 * 本 stage 不 hardcode "stream" vs "non-stream", 由 caller 通过 event 参数区分。
 */

import type { ProxyConfig } from "../../types.js";
import { tryReportCreditFromPath } from "../../credit-reporter.js";
import { writeFailedReportRaw } from "../../clickhouse.js";
import type { Pipeline } from "../../logger.js";

export interface CreditStageInput {
  /** true 时完全跳过 (custom upstream 场景); undefined 视为 false */
  skipCreditReport: boolean | undefined;
  config: Pick<ProxyConfig, "creditReport" | "creditPricing">;
  path: string;
  usage: Record<string, unknown> | null | undefined;
  effectiveModel: string;
  upstreamUrl: string;
  event: "usage";
  startTime: Date;
  /** PipelineIds 兼容: 老 handler 传 pipe.ids() 直接进来, stage 内部只做 spread */
  reqIds: object;
  /** 上游 x-request-id, 空串/缺省时下游走空值 */
  upstreamRequestId?: string;
  sessionKey: string;
  stream: boolean;
  keyId: string;
  routedFrom: string;
}

export interface CreditStageResult {
  /** 是否触发了上报 (skipCreditReport=true 时为 false) */
  attempted: boolean;
  /** 上报是否成功 (attempted=false 时无意义) */
  ok: boolean;
  /** 需要塞进响应头的 x-credit-report-error 值 (仅 attempted && !ok 时) */
  responseErrorHeader?: string;
}

/**
 * 计费上报 + 失败头 + 失败 raw 兜底记账。
 *
 * 原 handler 里的三步:
 *   1. skipCreditReport ? no-op : tryReportCreditFromPath
 *   2. attempted && !ok → pipe.error + set 响应头 x-credit-report-error
 *   3. attempted && !ok → writeFailedReportRaw (CH 兜底)
 *
 * 保持完全等价, 唯一改动是把响应头 set 交给 caller (返回 header 值即可)。
 */
export async function stageCredit(input: CreditStageInput, pipe: Pipeline): Promise<CreditStageResult> {
  if (input.skipCreditReport) {
    return { attempted: false, ok: false };
  }
  const outcome = await tryReportCreditFromPath(
    input.config.creditReport,
    input.path,
    input.usage,
    input.config.creditPricing,
    input.effectiveModel,
    input.upstreamUrl,
    input.event,
    input.startTime,
    { ...input.reqIds, upstreamRequestId: input.upstreamRequestId, sessionKey: input.sessionKey },
  );
  if (!outcome.attempted) {
    return { attempted: false, ok: false };
  }
  if (outcome.ok) {
    return { attempted: true, ok: true };
  }

  pipe.error("CREDIT_REPORT", outcome.errorMessage ?? "unknown");
  writeFailedReportRaw(
    {
      timestamp: new Date().toISOString(),
      event: input.event,
      modelId: input.effectiveModel,
      keyId: input.keyId,
      sessionKey: input.sessionKey,
      upstreamUrl: input.upstreamUrl,
      stream: input.stream,
      usage: input.usage === null ? undefined : input.usage,
      routedFrom: input.routedFrom,
      upstreamRequestId: input.upstreamRequestId,
      pricingConfig: input.config.creditPricing,
    },
    outcome.errorMessage ?? "unknown",
  );
  return {
    attempted: true,
    ok: false,
    responseErrorHeader: outcome.errorHeader,
  };
}

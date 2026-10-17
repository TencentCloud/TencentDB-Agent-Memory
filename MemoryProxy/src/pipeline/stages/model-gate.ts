/**
 * stages/model-gate.ts — model 名字校验 + alias 回写 (Phase 1)。
 *
 * 提取自 handler.ts:660-677 / anthropicHandler.ts:664-682 的 gate + alias 语义:
 *   - isCustomUpstream=false: 用 config.creditPricing 校验 model_name 是否登记;
 *     未登记 → 返回 400 结果对象 (调用方转 protocol.buildErrorResponse)
 *   - isCustomUpstream=false: resolveModelId → 得到 model_id, 若 != requestedModel
 *     则 alias 回写 body.model
 *   - isCustomUpstream=true: 全跳过 (custom 上游可能不认 pricing 里的名字)
 *
 * codex/wb 原本没有 gate (handler-audit bug B8), Phase 4.2/4.3 切换后通过
 * StageGates.modelGate=false 保持零回归, Phase 5.1 flip 到 true 生效。
 *
 * ⚠️ 不含 instance upstream config fetch — 该 stage 属于 resolve-target,
 * 由 stages/resolve-target.ts 处理。这里假设 isCustomUpstream 由 caller 传入。
 */

import type { ProxyConfig } from "../../types.js";
import { isModelInPricing, resolveModelId } from "../../pricing.js";

export type ModelGateOk = {
  ok: true;
  /** alias 回写后的 model_id (custom upstream 时 = requestedModel) */
  modelId: string;
  /** true = body.model 需要被 caller 覆写为 modelId */
  aliasApplied: boolean;
};

export type ModelGateErr = {
  ok: false;
  reason: "unregistered_model";
  requestedModel: string;
};

export type ModelGateResult = ModelGateOk | ModelGateErr;

/**
 * 决定 modelId + 是否需要 alias 回写。
 * 调用方拿到 aliasApplied=true 后必须自己 body.model = result.modelId。
 * (stage 保持纯函数, 不改传入的 body。)
 */
export function stageModelGate(
  requestedModel: string,
  config: Pick<ProxyConfig, "creditPricing">,
  isCustomUpstream: boolean,
): ModelGateResult {
  // Custom upstream 完全跳过 pricing gate + alias — 让 body.model 原样透传上游
  if (isCustomUpstream) {
    return { ok: true, modelId: requestedModel, aliasApplied: false };
  }
  if (!isModelInPricing(config.creditPricing, requestedModel)) {
    return { ok: false, reason: "unregistered_model", requestedModel };
  }
  const modelId = resolveModelId(config.creditPricing, requestedModel);
  return {
    ok: true,
    modelId,
    aliasApplied: modelId !== requestedModel,
  };
}

/**
 * OpenAI-style unregistered-model error body (与 handler.ts:662 原文完全一致)。
 * 便于 protocol 层复用同一份 JSON 结构。
 */
export function buildUnregisteredModelErrorBody(requestedModel: string): Record<string, unknown> {
  return {
    error: {
      message: `Model '${requestedModel}' is not a registered display name in the credit pricing table`,
      type: "invalid_request_error",
      code: "model_not_found",
    },
  };
}



import type { Resolution } from "../../instance-upstream-cache.js";
import { joinUrl } from '../../upstream-target.js';

export interface InstanceUpstreamOverrideInput {
  earlyConvResolution: Resolution;
  target: { url: string; routedFrom: string };
  forwardEndpoint: string;
  apiKey: string;
  body: Record<string, unknown>;
  modelId: string;
  /**
   * 请求原始 path (c.req.path)。传入后 override URL 走 joinUrl(base, path) 智能拼接,
   * 让 anthropic base 不带 /v1 也能通 (b11bf612 GLM /v1 修复); 也顺带修 base
   * 已含完整 endpoint 时旧手拼的 double-append。
   *
   * 未传时退回老手拼行为 (base + forwardEndpoint), 保持向后兼容。
   */
  requestPath?: string;
}

export interface InstanceUpstreamOverrideResult {
  /** 是否触发 override — 若 false 所有其他字段无效 */
  applied: boolean;
  /** 新 target.url (仅 applied=true) */
  newTargetUrl: string;
  /** 新 effectiveApiKey (仅 applied=true; custom_passthrough → 原 apiKey) */
  newEffectiveApiKey: string;
  /** 新 modelId (仅 applied=true 且 row 有 model_id 时不为空; 否则 = 原 modelId) */
  newModelId: string;
  /** 是否修改了 body.model (仅 applied 且 row.model_id) */
  bodyModelUpdated: boolean;
  /** custom upstream 用户自付, credit 跳过 */
  skipCreditReport: boolean;
}

export function stageInstanceUpstreamOverride(
  input: InstanceUpstreamOverrideInput,
): InstanceUpstreamOverrideResult {
  const { earlyConvResolution, target, forwardEndpoint, apiKey, modelId } = input;
  const routedToCheapModel = target.routedFrom !== "";

  if (routedToCheapModel || earlyConvResolution.kind !== "override") {
    return {
      applied: false,
      newTargetUrl: target.url,
      newEffectiveApiKey: apiKey,
      newModelId: modelId,
      bodyModelUpdated: false,
      skipCreditReport: false,
    };
  }

  const row = earlyConvResolution.row;
  // 优先走 joinUrl(base, requestPath) 智能拼 (b11bf612): anthropic base 不带 /v1 自动补,
  // base 已含完整 endpoint 早退不 double-append。未传 requestPath 时退回老手拼保兼容。
  const newTargetUrl = input.requestPath
    ? joinUrl(row.base_url, input.requestPath)
    : `${row.base_url.replace(/\/+$/, "")}${forwardEndpoint}`;
  const newEffectiveApiKey = row.mode === "custom_unified"
    ? row.api_key
    : apiKey; // custom_passthrough
  const bodyModelUpdated = !!row.model_id;
  const newModelId = row.model_id || modelId;

  return {
    applied: true,
    newTargetUrl,
    newEffectiveApiKey,
    newModelId,
    bodyModelUpdated,
    skipCreditReport: true,
  };
}

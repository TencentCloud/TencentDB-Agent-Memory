/**
 * stages/instance-upstream-override.ts — instance upstream override 应用 stage。
 *
 * 提取自 openai-chat + anthropic runner ~18 行 相同的 override 应用块:
 *   1. routedToCheapModel gate (cost-guard 已路由到 cheap → 不应用 override)
 *   2. kind=override → 替换 target.url / effectiveApiKey / body.model / modelId
 *   3. skipCreditReport=true (custom upstream 用户自付, 不算平台账)
 *
 * 这是 stateful mutation (body/target 变), stage 返回新值让 caller 应用。
 */

import type { Resolution } from "../../instance-upstream-cache.js";
import { joinUrl } from "../../guard-adapter.js";

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
  /** custom upstream 用户自付, credit 跳过。
   *  ⚠️ 不纳入平台计费（CreditDelta 不上报 MemoryPlus），但**纳入用量统计**：
   *     见 src/upstream-usage.ts 口径说明，贡献在面板「系统状态 → 用量统计」体现。 */
  skipCreditReport: boolean;
  /** 命中的 custom 组 id（用量统计维度；未命中时为空串） */
  groupId: string;
  /** 命中的 custom 组名（用量统计维度；未命中时为空串） */
  groupName: string;
  /** 命中组的 team 归属（P4 用量统计维度；未命中/全局组时空串） */
  teamId: string;
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
      groupId: "",
      groupName: "",
      teamId: "",
    };
  }

  const row = earlyConvResolution.row;
  // 优先走 joinUrl(base, requestPath) 智能拼 (b11bf612): anthropic base 不带 /v1 自动补,
  // base 已含完整 endpoint 早退不 double-append。未传 requestPath 时退回老手拼保兼容。
  const newTargetUrl = input.requestPath
    ? joinUrl(row.base_url, input.requestPath)
    : `${row.base_url.replace(/\/+$/, "")}${forwardEndpoint}`;
  // P2: default 组显式配置了 api_key → 用组内 Key;custom_unified 用组内 Key;
  // custom_passthrough / default 未填 Key → 沿用原 apiKey(config.yaml)。
  const useRowKey =
    row.mode === "custom_unified" || (row.group_type === "default" && !!row.api_key);
  const newEffectiveApiKey = useRowKey && row.api_key ? row.api_key : apiKey;
  // P1 多模型清单口径：清单非空时,请求模型在清单内 → 放行(不改 body.model);
  // 不在清单内(手工/API 直连构造的请求)→ 回落清单第一个作为默认模型,不报错;
  // 清单为空 → 旧行为(model_id 单值 override 或原样透传)。
  const modelList = row.model_ids && row.model_ids.length > 0
    ? row.model_ids
    : row.model_id ? [row.model_id] : [];
  const bodyModelUpdated = modelList.length > 0 && !modelList.includes(modelId);
  const newModelId = bodyModelUpdated ? (modelList[0] as string) : modelId;

  return {
    applied: true,
    newTargetUrl,
    newEffectiveApiKey,
    newModelId,
    bodyModelUpdated,
    // 不纳入平台计费（用户自付）；仅纳入用量统计 —— upstream-usage.ts
    skipCreditReport: true,
    groupId: row.group_id ?? "",
    groupName: row.name ?? "",
    teamId: row.team_id ?? "",
  };
}

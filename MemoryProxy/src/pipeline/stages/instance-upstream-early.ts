/**
 * stages/instance-upstream-early.ts — 早期 instance upstream config 解析 (Phase 4 stage 化)。
 *
 * 提取自 openai-chat + anthropic runner ~40 行相同的 4-态 Resolution 解析块:
 *   1. resolveForAgent / resolveExtraction 取 conv / extract 两条上游
 *   2. 外部客户命中 blocked/unmanaged → 立即 400 (systemUser 通道跳过)
 *   3. shouldOverride 计算 _isCustomUpstream (决定后续 model gate / credit report)
 *
 * caller 拿到 result: 若 blockedResp !== null → 直接 return 给客户端;
 * 否则 destructure { earlyConvResolution, earlyExtractRow, earlySysMatch,
 * isCustomUpstream } 继续 pipeline。
 */

import type { Context } from "hono";
import type { ProxyConfig } from "../../types.js";
import {
  getInstanceUpstreamConfigs,
  resolveForAgent,
  resolveExtraction,
  shouldOverride,
  type Resolution,
} from "../../instance-upstream-cache.js";
import type { InstanceUpstreamRow } from "../../instance-upstream-cache.js";
import { matchSystemUserByUserId, hasSystemUsers } from "../../systemUser.js";
import type { SystemUserMatch } from "../../systemUser.js";
import { isLegacyProxyPath } from "../../routes/whitelist.js";

export interface InstanceUpstreamEarlyInput {
  c: Context;
  config: ProxyConfig;
  spaceId: string;
  earlyUserId: string;
  /** 错误 envelope 格式:
   *  - openai: {code, error_code, message, detail}
   *  - anthropic: {type:"error", error:{type,message}, detail} */
  errorEnvelope: "openai" | "anthropic";
}

export interface InstanceUpstreamEarlyResult {
  /** 非 null → caller 立即 return 这个响应, 不继续 pipeline */
  blockedResp: Response | null;
  agent: string | undefined;
  legacyProxy: boolean;
  earlyConvResolution: Resolution;
  earlyExtractRow: InstanceUpstreamRow | null;
  earlySysMatch: SystemUserMatch | null;
  isCustomUpstream: boolean;
}

export async function stageInstanceUpstreamEarly(
  input: InstanceUpstreamEarlyInput,
): Promise<InstanceUpstreamEarlyResult> {
  const { c, config, spaceId, earlyUserId } = input;

  const agent = c.req.path.split("/").filter(Boolean)[0] ?? undefined;
  const instanceConfigs = await getInstanceUpstreamConfigs(
    config.coreSkill, spaceId, config.instanceUpstream,
  );
  const legacyProxy = isLegacyProxyPath(c.req.path);
  const earlyConvResolution: Resolution = legacyProxy
    ? { kind: "official", row: null }
    : resolveForAgent(instanceConfigs, agent ?? "");
  const earlyExtractRow = resolveExtraction(instanceConfigs);
  const earlySysMatch = hasSystemUsers() ? matchSystemUserByUserId(earlyUserId) : null;

  // 外部对话请求: blocked / unmanaged → 早 400 (systemUser 走 extraction 永不 block)
  let blockedResp: Response | null = null;
  if (earlySysMatch === null) {
    if (earlyConvResolution.kind === "blocked") {
      // openai 版本带完整 "Ask the administrator..." 后缀; anthropic 版本较短。
      // 完全对齐原始文本, 后缀差异保留。
      const blockedMsg = earlyConvResolution.reason === "default_disabled"
        ? (input.errorEnvelope === "anthropic"
            ? `Default upstream group is disabled; agent "${agent ?? ""}" has no upstream to route to.`
            : `Default upstream group is disabled; agent "${agent ?? ""}" has no upstream to route to. Ask the administrator to enable the default group in Panel, or add a custom group covering this agent.`)
        : (input.errorEnvelope === "anthropic"
            ? `Custom upstream group "${earlyConvResolution.group_id}" (covering agent "${agent ?? ""}") is disabled.`
            : `Custom upstream group "${earlyConvResolution.group_id}" (covering agent "${agent ?? ""}") is disabled. Ask the administrator to enable it in Panel, or delete the group so the agent becomes unmanaged and can be reassigned.`);
      const blockedDetail = {
        agent: agent ?? "",
        group_id: earlyConvResolution.group_id,
        reason: earlyConvResolution.reason,
      };
      blockedResp = input.errorEnvelope === "anthropic"
        ? c.json({
            type: "error",
            error: { type: "upstream_disabled", message: blockedMsg },
            detail: blockedDetail,
          }, 400)
        : c.json({
            code: 400,
            error_code: "UPSTREAM_DISABLED",
            message: blockedMsg,
            detail: blockedDetail,
          }, 400);
    } else if (earlyConvResolution.kind === "unmanaged") {
      const unmMsg = input.errorEnvelope === "anthropic"
        ? `Agent "${earlyConvResolution.agent}" is not assigned to any upstream group in this instance.`
        : `Agent "${earlyConvResolution.agent}" is not assigned to any upstream group in this instance. Ask the administrator to add it to the default group or a custom group in Panel.`;
      const unmDetail = {
        agent: earlyConvResolution.agent,
        hint: "Ask the instance administrator to add this agent to a group in Panel.",
      };
      blockedResp = input.errorEnvelope === "anthropic"
        ? c.json({
            type: "error",
            error: { type: "agent_not_configured", message: unmMsg },
            detail: unmDetail,
          }, 400)
        : c.json({
            code: 400,
            error_code: "AGENT_NOT_CONFIGURED",
            message: unmMsg,
            detail: unmDetail,
          }, 400);
    }
  }

  // caller dispatch: systemUser 看 extraction, 外部客户看 conversation
  const isCustomUpstream = earlySysMatch !== null
    ? shouldOverride(earlyExtractRow)
    : shouldOverride(earlyConvResolution);

  return {
    blockedResp,
    agent,
    legacyProxy,
    earlyConvResolution,
    earlyExtractRow,
    earlySysMatch,
    isCustomUpstream,
  };
}

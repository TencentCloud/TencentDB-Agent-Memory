/**
 * stages/instance-upstream-responses.ts —— codex + workbuddy 专用的 instance
 * upstream 解析 + 400 早退 + override 应用 一次搞定 stage。
 *
 * 与 openai-chat/anthropic 走的 stageInstanceUpstreamEarly + stageInstanceUpstreamOverride
 * 分两步的姿势不同, 原因是 codex/wb 的 forwardToUpstream 在 handler 尾段执行,
 * 早期没跟 modelGate 一起做 instance 决策 (只算了 shouldOverride 供 modelGate 用)。
 * 保持在 forwardToUpstream 里做 override 是合适的 (spaceId + path 都已在手),
 * 但把 blocked/unmanaged 400 + override 应用 抽到一份 stage 消灭 codex/wb 两处 ~48 行
 * 的复制。
 *
 * openai-chat/anthropic 用的两个 stage 与本 stage 保持"逻辑等价, 时机不同":
 *   - blocked → 400 (upstream_disabled 与 openai-chat 的 stageInstanceUpstreamEarly 一致)
 *   - unmanaged → 400 (agent_not_configured 同上)
 *   - override → 写 body.model + skipCreditReport=true + 返回新 url/headers 覆盖
 *   - official → 保持全局 upstream 不动
 *
 * 差异保留原地: workbuddy 的 upstreamPath 前缀剥离 (`replace(/^\/workbuddy\/[^/]+/, "")`)
 * 由 caller 传入 pathForOverride 参数; codex 用 c.req.path。
 */

import type { ProxyConfig } from "../../types.js";
import { getInstanceUpstreamConfigs, resolveForAgent } from "../../instance-upstream-cache.js";
import { joinUrl } from "../../guard-adapter.js";

export interface InstanceUpstreamResponsesInput {
  agent: string;
  spaceId: string;
  config: ProxyConfig;
  /** override 应用时用来 join 到 row.base_url 的 path 部分 (codex: c.req.path, wb: 剥前缀后) */
  pathForOverride: string;
  /** 是否强制走 official (codex 的 isLegacyProxyPath /proxy/<sid>/ 场景 → true) */
  forceOfficial?: boolean;
}

export interface InstanceUpstreamResponsesBlocked {
  kind: "blocked" | "unmanaged";
  /** 直接返回给客户端的 400 Response body (JSON) */
  errorBody: {
    type: "error";
    error: { type: string; message: string };
    detail: Record<string, unknown>;
  };
}

export interface InstanceUpstreamResponsesResult {
  /** override 应用后的新 upstream URL (无 override 时 = undefined) */
  overrideUrl?: string;
  /** override 应用后 headers 变更 (custom_unified: authorization 覆盖 + 删 x-api-key; custom_passthrough: 空) */
  headerUpdates?: { authorization?: string; deleteXApiKey?: boolean };
  /** override 应用后 body.model 需替换的 model_id (为空 = 不改) */
  bodyModelOverride?: string;
  /** custom upstream 用户自付 → credit 跳过 */
  skipCreditReport: boolean;
}

/**
 * 主入口。返回 { kind: "blocked"|"unmanaged", errorBody } 时 caller 应立即 400;
 * 否则 caller 用 result.overrideUrl/headerUpdates/bodyModelOverride/skipCreditReport
 * 直接应用即可 (override 未触发时全为 undefined/false)。
 */
export async function stageInstanceUpstreamResponses(
  input: InstanceUpstreamResponsesInput,
): Promise<InstanceUpstreamResponsesBlocked | InstanceUpstreamResponsesResult> {
  const { agent, spaceId, config, pathForOverride, forceOfficial } = input;

  const instanceConfigs = await getInstanceUpstreamConfigs(
    config.coreSkill,
    spaceId,
    config.instanceUpstream,
  );

  const resolution = forceOfficial
    ? { kind: "official" as const, row: null }
    : resolveForAgent(instanceConfigs, agent);

  if (resolution.kind === "blocked") {
    return {
      kind: "blocked",
      errorBody: {
        type: "error",
        error: {
          type: "upstream_disabled",
          message: resolution.reason === "default_disabled"
            ? `Default upstream group is disabled; agent "${agent}" has no upstream to route to.`
            : `Custom upstream group "${resolution.group_id}" (covering agent "${agent}") is disabled.`,
        },
        detail: { agent, group_id: resolution.group_id, reason: resolution.reason },
      },
    };
  }

  if (resolution.kind === "unmanaged") {
    return {
      kind: "unmanaged",
      errorBody: {
        type: "error",
        error: {
          type: "agent_not_configured",
          message: `Agent "${agent}" is not assigned to any upstream group in this instance.`,
        },
        detail: {
          agent,
          hint: "Ask the instance administrator to add this agent to a group in Panel.",
        },
      },
    };
  }

  if (resolution.kind === "override") {
    const row = resolution.row;
    const overrideUrl = joinUrl(row.base_url, pathForOverride);
    const headerUpdates: NonNullable<InstanceUpstreamResponsesResult["headerUpdates"]> = {};
    if (row.mode === "custom_unified" && row.api_key) {
      headerUpdates.authorization = `Bearer ${row.api_key}`;
      headerUpdates.deleteXApiKey = true;
    }
    return {
      overrideUrl,
      headerUpdates,
      bodyModelOverride: row.model_id || undefined,
      skipCreditReport: true,
    };
  }

  // official / 零行 fallback: 保持全局 upstream
  return { skipCreditReport: false };
}

export function isInstanceUpstreamBlocked(
  r: InstanceUpstreamResponsesBlocked | InstanceUpstreamResponsesResult,
): r is InstanceUpstreamResponsesBlocked {
  return (r as InstanceUpstreamResponsesBlocked).kind === "blocked" ||
    (r as InstanceUpstreamResponsesBlocked).kind === "unmanaged";
}

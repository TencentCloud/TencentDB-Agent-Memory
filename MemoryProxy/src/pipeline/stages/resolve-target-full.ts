/**
 * stages/resolve-target-full.ts — 完整 cost-guard target 解析 stage。
 *
 * 提取自 openai-chat + anthropic runner ~35 行 相同的 target 解析块:
 *   1. per-agent effectiveApiKey (agents map 优先, 缺失走 upstream.apiKey)
 *   2. defaultUpstreamUrl (per-agent → protocol-specific fallback → upstream.url)
 *   3. forwardEndpoint (匹配 whitelist / 兜底)
 *   4. costGuardMode (markerOptIn=false → "full"; true → resolveCostGuardMode)
 *   5. resolveForwardTarget → 拿最终 ForwardTarget
 *
 * 与 stages/resolve-target.ts 区别: 老那个是 raw resolveForwardTarget wrapper
 * (只做一件事); 本 stage 是"完整装配"流水线, 包含所有相关的 upstream URL /
 * apiKey / endpoint 计算 (与 runner 内 inline 完全对齐)。
 */

import type { Context } from "hono";
import type { ProxyConfig } from "../../types.js";
import {
  resolveForwardTarget,
  type ForwardTarget,
} from "../../guard-adapter.js";
import { matchWhitelistEndpoint, hasCostGuardMarker, resolveCostGuardMode } from "../../routes/whitelist.js";

export interface ResolveTargetFullInput {
  c: Context;
  config: ProxyConfig;
  protocol: "openai" | "anthropic";
  agentFromPath?: string;
  keyId: string;
  sessionKey: string;
  messages: unknown[];
  hasTools: boolean;
  body: Record<string, unknown>;
  modelId: string;
  headers: Record<string, string>;
  traceId: string;
  startTime: string;
  spaceId: string;
}

export interface ResolveTargetFullResult {
  target: ForwardTarget;
  effectiveApiKey: string;
  forwardEndpoint: string;
  costGuardMode: string;
  /** agentUpstreamEntry — 保留供 caller 判断 case (a)/(b)/(c) */
  hasAgentEntry: boolean;
}

export async function stageResolveTargetFull(
  input: ResolveTargetFullInput,
): Promise<ResolveTargetFullResult> {
  const { c, config, protocol, agentFromPath } = input;

  const agentUpstreamEntry = agentFromPath ? config.upstream.agents?.[agentFromPath] : undefined;
  const effectiveApiKey = agentUpstreamEntry
    ? (agentUpstreamEntry.apiKey ?? "")
    : config.upstream.apiKey;

  // defaultUpstreamUrl: openai 走 upstream.url; anthropic 有额外 anthropicUpstream fallback
  const defaultUpstreamUrl = protocol === "anthropic"
    ? (agentUpstreamEntry?.url || config.costGuard.anthropicUpstream?.url || config.upstream.url)
    : (agentUpstreamEntry?.url ?? config.upstream.url);

  // Whitelist endpoint: openai=/chat/completions, anthropic=/messages
  const forwardEndpoint = matchWhitelistEndpoint(c.req.path)?.upstreamEndpoint
    ?? (protocol === "anthropic" ? "/messages" : "/chat/completions");

  const costGuardMode = config.costGuard.markerOptIn ? resolveCostGuardMode(c.req.path) : "full";
  const target: ForwardTarget = await resolveForwardTarget(config, {
    keyId: `${input.keyId}:${input.sessionKey}`,
    messages: input.messages,
    protocol,
    hasTools: input.hasTools,
    body: input.body,
    modelId: input.modelId,
    defaultUpstreamUrl,
    requestPath: forwardEndpoint,
    headers: input.headers,
    traceId: input.traceId,
    startTime: input.startTime,
    spaceId: input.spaceId,
    // markerOptIn=false (default/prod): 每个请求都走 router (`/cost-guard` 路径 404)
    // markerOptIn=true (test): 只有带 marker 才启用 router; 裸路径 passthrough
    useGuard: config.costGuard.markerOptIn ? hasCostGuardMarker(c.req.path) : true,
    agentName: agentFromPath,
    costGuardMode,
  });

  return {
    target,
    effectiveApiKey,
    forwardEndpoint,
    costGuardMode,
    hasAgentEntry: !!agentUpstreamEntry,
  };
}

/**
 * 上游凭据解析（四个 handler 共用同一套规则）。
 *
 * 取值顺序（高 → 低）：
 *   1. `upstream.agents[agent].apiKey` —— 服务端为该 agent 单独指定的 key；
 *   2. `upstream.apiKey`               —— 外层兜底；
 *   3. 客户端请求头里的 key            —— 只有当上面两项都没有，或该 agent 显式声明
 *                                         `passthroughClientKey: true` 时才生效。
 *
 * 之所以把第 2 条放回链路里：早期实现用"agent 是否出现在 agents 表里"决定是否走兜底，
 * 于是"给某个 agent 单独配了 url、忘了配 apiKey"会静默把客户端 key 发到上游，
 * 表现是上游 401，而配置本身看不出问题。需要透传客户端 key 的部署应当显式声明。
 */

import type { AgentUpstreamEntry } from "../types.js";

export type UpstreamKeySource = "agent" | "global" | "client";

export interface ResolvedUpstreamKey {
  /**
   * 要注入上游的 key。空串表示"不注入，沿用客户端原始鉴权头"
   * （即 `source === "client"` 且客户端并未提供 key 的情形）。
   */
  apiKey: string;
  source: UpstreamKeySource;
}

export interface ResolveUpstreamKeyInput {
  /** 该 agent 在 `upstream.agents` 里的条目；未配置时传 undefined。 */
  agentEntry?: Pick<AgentUpstreamEntry, "apiKey" | "passthroughClientKey">;
  /** 外层 `upstream.apiKey`。 */
  globalApiKey?: string;
  /** 客户端请求头里带来的 key（形态由各协议决定：Bearer 或 x-api-key）。 */
  clientApiKey?: string;
}

export function resolveUpstreamApiKey(input: ResolveUpstreamKeyInput): ResolvedUpstreamKey {
  const clientApiKey = input.clientApiKey ?? "";
  if (input.agentEntry?.passthroughClientKey === true) {
    return { apiKey: clientApiKey, source: "client" };
  }
  const agentApiKey = input.agentEntry?.apiKey ?? "";
  if (agentApiKey.length > 0) return { apiKey: agentApiKey, source: "agent" };
  const globalApiKey = input.globalApiKey ?? "";
  if (globalApiKey.length > 0) return { apiKey: globalApiKey, source: "global" };
  return { apiKey: clientApiKey, source: "client" };
}

/**
 * 启动期检查：哪些 agent 条目会让客户端 key 被透传到上游。
 *
 * 返回每个命中的 agent 一句说明，供 config.ts 统一打印；不抛错，因为透传本身是
 * 合法用法（多租户代理就是靠它让每个用户带上自己的 key）。
 */
export function auditUpstreamAgentKeys(
  agents: Record<string, Pick<AgentUpstreamEntry, "apiKey" | "passthroughClientKey">> | undefined,
  globalApiKey: string,
): string[] {
  const out: string[] = [];
  for (const [agent, entry] of Object.entries(agents ?? {})) {
    if (entry?.passthroughClientKey === true) {
      out.push(`upstream.agents.${agent} 声明 passthroughClientKey: true，将透传客户端 key`);
      continue;
    }
    if ((entry?.apiKey ?? "").length > 0) continue;
    out.push(
      globalApiKey.length > 0
        ? `upstream.agents.${agent} 未配置 apiKey，将回退到 upstream.apiKey`
        : `upstream.agents.${agent} 与 upstream.apiKey 都没有配置，将透传客户端 key（上游通常会返回 401）`,
    );
  }
  return out;
}

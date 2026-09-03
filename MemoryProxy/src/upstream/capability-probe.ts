/**
 * 上游协议能力自动探测（题目六「上游协议能力识别」落地）。
 *
 * 启动时对每个 agent 的最终上游 URL 探测三种协议端点是否存在
 * （OpenAI Chat / OpenAI Responses / Anthropic Messages），并按
 * 「客户端原生协议优先，否则自动转换」生成 per-agent 转换标志。
 * 显式配置的转换标志始终优先于探测结果（向后兼容）。
 *
 * 探测用最小请求（max_tokens=1），端点存在性判定：
 *   200 / 400 / 401 / 403 / 422 / 429 → 端点存在（支持）
 *   404 / 405                       → 端点不存在（不支持）
 *   网络错误                        → 不支持（降级直连）
 */
import type { AgentUpstreamEntry, ProxyConfig } from "../types.js";
import { log } from "../report/log.js";

export interface UpstreamCapabilities {
  chat: boolean;
  responses: boolean;
  anthropic: boolean;
}

export interface AutoDetectConfig {
  enabled?: boolean;
  timeoutMs?: number;
}

async function probeEndpoint(
  url: string,
  apiKey: string,
  kind: "chat" | "responses" | "anthropic",
  timeoutMs: number,
): Promise<boolean> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };
  let body: string;
  if (kind === "chat") {
    body = JSON.stringify({
      model: "ping",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    });
  } else if (kind === "responses") {
    body = JSON.stringify({ model: "ping", input: "ping", max_output_tokens: 1 });
  } else {
    headers["anthropic-version"] = "2023-06-01";
    body = JSON.stringify({
      model: "ping",
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    });
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok || [400, 401, 403, 422, 429].includes(res.status);
  } catch {
    return false;
  }
}

/** 探测单个 base URL 的三协议能力（并行、失败降级为 false）。 */
export async function probeCapabilities(
  baseUrl: string,
  apiKey: string,
  timeoutMs = 3000,
): Promise<UpstreamCapabilities> {
  const base = baseUrl.replace(/\/+$/, "");
  const [chat, responses, anthropic] = await Promise.all([
    probeEndpoint(`${base}/chat/completions`, apiKey, "chat", timeoutMs),
    probeEndpoint(`${base}/responses`, apiKey, "responses", timeoutMs),
    // Anthropic base 可能是 API 根（.../v1 或 /api/anthropic/v1）也可能是其它形态：
    // 同时试 {base}/v1/messages 与 {base}/messages，任一命中即支持。
    (async () => {
      const withV1 = await probeEndpoint(`${base}/v1/messages`, apiKey, "anthropic", timeoutMs);
      if (withV1) return true;
      return probeEndpoint(`${base}/messages`, apiKey, "anthropic", timeoutMs);
    })(),
  ]);
  return { chat, responses, anthropic };
}

/** 客户端协议 × 上游能力 → 转换标志（客户端原生协议优先，direct 不设任何标志）。 */
export function resolveAgentModes(
  caps: UpstreamCapabilities,
): Record<string, Partial<AgentUpstreamEntry>> {
  const wb: Partial<AgentUpstreamEntry> = {};
  if (!caps.chat && caps.anthropic) wb.chatToAnthropic = true;

  const cc: Partial<AgentUpstreamEntry> = {};
  if (!caps.anthropic && caps.chat) cc.anthropicToChat = true;
  else if (!caps.anthropic && !caps.chat && caps.responses) cc.anthropicToResponses = true;

  const cx: Partial<AgentUpstreamEntry> = {};
  if (!caps.responses && caps.anthropic) cx.responsesToAnthropic = true;
  else if (!caps.responses && !caps.anthropic && caps.chat) cx.chatCompletions = true;

  return { workbuddy: wb, "claude-code": cc, codex: cx };
}

/** 对已知 agent 逐个探测并合并转换标志（显式配置优先）。 */
export async function applyAutoDetect(config: ProxyConfig): Promise<void> {
  const timeoutMs = config.upstream.autoDetect?.timeoutMs ?? 3000;
  const knownAgents = ["workbuddy", "claude-code", "codex"];
  for (const agent of knownAgents) {
    const entry = config.upstream.agents[agent] ?? {};
    const url = entry.url ?? config.upstream.url;
    const apiKey = entry.apiKey ?? config.upstream.apiKey;
    const caps = await probeCapabilities(url, apiKey, timeoutMs);
    const mode = resolveAgentModes(caps)[agent] ?? {};
    const merged: AgentUpstreamEntry = { ...entry };
    for (const [k, v] of Object.entries(mode)) {
      if (v === true && merged[k as keyof AgentUpstreamEntry] === undefined) {
        (merged as unknown as Record<string, unknown>)[k] = true;
      }
    }
    config.upstream.agents[agent] = merged;
    log.info("upstream.probe", {
      agent,
      url,
      chat: caps.chat,
      responses: caps.responses,
      anthropic: caps.anthropic,
      flags: Object.keys(merged).filter((k) => (merged as unknown as Record<string, unknown>)[k]).join(","),
    });
  }
}

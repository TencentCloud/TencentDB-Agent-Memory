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

/** 已知的“完整端点”后缀：配置里可能直接写完整 URL（如 …/chat/completions）。 */
const KNOWN_ENDPOINT_SUFFIXES = [
  "/chat/completions",
  "/v1/messages",
  "/messages",
  "/responses",
] as const;

/** 若 URL 已是完整端点，剥掉端点后缀得到可用于探测兄弟端点的根。 */
function stripKnownEndpoint(url: string): string {
  for (const suffix of KNOWN_ENDPOINT_SUFFIXES) {
    if (url.endsWith(suffix)) return url.slice(0, -suffix.length);
  }
  return url;
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}

/** 对一组候选 URL 并行探测，任一命中即认为该协议存在。 */
async function probeAny(
  urls: string[],
  apiKey: string,
  kind: "chat" | "responses" | "anthropic",
  timeoutMs: number,
): Promise<boolean> {
  const results = await Promise.all(
    urls.map((url) => probeEndpoint(url, apiKey, kind, timeoutMs)),
  );
  return results.some(Boolean);
}

/**
 * 探测单个上游 URL 的三协议能力（并行、失败降级为 false）。
 * 兼容两种配置形态：
 *  - 协议无关根地址：https://host/v1 → 拼 /chat/completions、/responses、/messages；
 *  - 完整端点：https://host/v2/chat/completions → 先剥后缀得到根，再对根探测兄弟
 *    端点（同时保证完整端点自身仍按对应协议探测一次），避免拼出
 *    …/chat/completions/chat/completions 这类无效路径导致探测静默全失败。
 */
export async function probeCapabilities(
  baseUrl: string,
  apiKey: string,
  timeoutMs = 3000,
): Promise<UpstreamCapabilities> {
  const base = (baseUrl.split("?")[0] ?? baseUrl).replace(/\/+$/, "");
  const root = stripKnownEndpoint(base);
  const [chat, responses, anthropic] = await Promise.all([
    probeAny(unique([`${root}/chat/completions`]), apiKey, "chat", timeoutMs),
    probeAny(unique([`${root}/responses`]), apiKey, "responses", timeoutMs),
    probeAny(
      unique([`${root}/v1/messages`, `${root}/messages`]),
      apiKey,
      "anthropic",
      timeoutMs,
    ),
  ]);
  return { chat, responses, anthropic };
}

/** 每个客户端的原生协议（决定探测到上游能力后要补哪些转换开关）。 */
export const NATIVE_PROTOCOLS: Record<
  string,
  ReadonlyArray<"chat" | "responses" | "anthropic">
> = {
  workbuddy: ["chat", "responses"], // 网页走 Chat、桌面走 Responses
  "claude-code": ["anthropic"],
  codex: ["responses"],
  codebuddy: ["chat"],
};

/** 显式配置过的转换开关（true/false 都算）：配置了就不让 autoDetect 覆盖（用户意图优先）。 */
const EXPLICIT_FLAGS = [
  "chatCompletions",
  "chatToAnthropic",
  "anthropicToChat",
  "anthropicToResponses",
  "responsesToAnthropic",
] as const;

/** 单个客户端的协议 × 上游能力 → 转换标志（原生协议优先，direct 不设标志）。 */
export function resolveAgentModesFor(
  agent: string,
  caps: UpstreamCapabilities,
): Partial<AgentUpstreamEntry> {
  const native = NATIVE_PROTOCOLS[agent];
  if (!native) return {};
  const out: Partial<AgentUpstreamEntry> = {};
  if (native.includes("anthropic")) {
    if (!caps.anthropic && caps.chat) out.anthropicToChat = true;
    else if (!caps.anthropic && !caps.chat && caps.responses) out.anthropicToResponses = true;
  }
  if (native.includes("responses")) {
    if (!caps.responses && caps.anthropic) out.responsesToAnthropic = true;
    else if (!caps.responses && !caps.anthropic && caps.chat) out.chatCompletions = true;
  }
  if (native.includes("chat")) {
    if (!caps.chat && caps.anthropic) out.chatToAnthropic = true;
  }
  return out;
}

/** 兼容旧测试/调用方：按三个内置 agent 返回模式表。 */
export function resolveAgentModes(
  caps: UpstreamCapabilities,
): Record<string, Partial<AgentUpstreamEntry>> {
  return {
    workbuddy: resolveAgentModesFor("workbuddy", caps),
    "claude-code": resolveAgentModesFor("claude-code", caps),
    codex: resolveAgentModesFor("codex", caps),
  };
}

/**
 * 待探测集合 = 内置客户端 ∪ 配置里出现过的 agent，去掉已显式配置转换开关的项
 * （显式配置优先，也避免多余探测请求）。
 */
export function agentsToAutoDetect(config: ProxyConfig): string[] {
  const agents = new Set<string>(["workbuddy", "claude-code", "codex"]);
  for (const name of Object.keys(config.upstream.agents ?? {})) agents.add(name);
  return [...agents].filter((agent) => {
    const entry = config.upstream.agents?.[agent];
    if (!entry) return true;
    return !EXPLICIT_FLAGS.some(
      (f) => entry[f as keyof AgentUpstreamEntry] !== undefined,
    );
  });
}

/** 对需要探测的 agent 逐个探测并合并转换标志（显式配置优先）。 */
export async function applyAutoDetect(config: ProxyConfig): Promise<void> {
  const timeoutMs = config.upstream.autoDetect?.timeoutMs ?? 3000;
  const agents = (config.upstream.agents ??= {});
  for (const agent of agentsToAutoDetect(config)) {
    const entry = agents[agent] ?? {};
    const url = entry.url ?? config.upstream.url;
    const apiKey = entry.apiKey ?? config.upstream.apiKey;
    const caps = await probeCapabilities(url, apiKey, timeoutMs);
    const mode = resolveAgentModesFor(agent, caps);
    const merged: AgentUpstreamEntry = { ...entry };
    for (const [k, v] of Object.entries(mode)) {
      if (v === true && merged[k as keyof AgentUpstreamEntry] === undefined) {
        (merged as unknown as Record<string, unknown>)[k] = true;
      }
    }
    agents[agent] = merged;
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

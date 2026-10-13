
import { matchWhitelistEndpoint } from './routes/whitelist.js';
import { log } from './report/log.js';
interface RetryTarget {
  url: string;
  model: string;
  authHeaders: Record<string, string> | null;
}
export interface ForwardTarget {
  url: string;
  model: string;
  authHeaders: Record<string, string> | null;
  bodyOverrides: Record<string, unknown> | null;
  retryTarget: RetryTarget | null;
  logLine: string;
  logLineExtra: string;
  tags: string[];
  logMeta: Record<string, unknown>;

  turnSeq: number;

  routedFrom: string;
}
export function joinUrl(base: string, requestPath: string): string {
  const normalizedBase = base.replace(/\/+$/, "");
  const baseWithoutQuery = normalizedBase.split("?")[0] ?? normalizedBase;

  // agentUpstreams 或完整 endpoint base 已含路径时勿再拼接。
  if (
    baseWithoutQuery.endsWith("/messages") ||
    baseWithoutQuery.endsWith("/chat/completions")
  ) {
    return normalizedBase;
  }

  // ── /v1 智能兼容(2026-09-28,fix InstanceUpstream v2 用户填 base 不带 /v1)──
  // 仅针对 **anthropic 协议**:官方 base_url 约定不含 /v1(如
  // `https://api.anthropic.com`、`https://open.bigmodel.cn/api/anthropic`),
  // 完整路径 `/v1/messages`;而 TokenHub 全局 upstream 约定含 /v1
  // (`https://tokenhub.tencentmaas.com/v1`),whitelist 的 `upstreamEndpoint`
  // 剥掉了 /v1(如 `/messages`),假设 base 已含 /v1。按官方姿势填 base 的
  // 用户 URL 少 /v1 打 GLM/Anthropic 官方端点 → 404。这里在 anthropic 协议
  // 且 base 无 `/vN` 版本号后缀时自动补 `/v1`。
  //
  // 排除范围:
  //   - openai chat/completions/embeddings/responses 一律不动(codex/workbuddy
  //     `/responses` 客户端约定就是不带 /v1,不能强行补;openai chat 端点由用
  //     户自行保证 base 形态)
  //   - base 已含 `/vN`(v1/v2/v3...)时保持原样,兼容 TokenHub 姿势
  const hasVersionSuffix = /\/v\d+$/.test(baseWithoutQuery);

  const entry = matchWhitelistEndpoint(requestPath);
  if (entry) {
    const shouldPatchV1 = entry.protocol === "anthropic" && !hasVersionSuffix;
    const versionPrefix = shouldPatchV1 ? "/v1" : "";
    return `${normalizedBase}${versionPrefix}${entry.upstreamEndpoint}`;
  }

  // Fallback: 按请求路径后缀推断 Anthropic / OpenAI endpoint。
  // `/messages` 结尾兜底为 anthropic,同样享受 /v1 智能补齐;
  // `/chat/completions` 兜底为 openai,保持原样不动。
  const isAnthropicFallback = requestPath.endsWith("/messages");
  const endpoint = isAnthropicFallback ? "/messages" : "/chat/completions";
  const versionPrefixFallback = isAnthropicFallback && !hasVersionSuffix ? "/v1" : "";
  log.warn("joinUrl.fallback", { requestPath, endpoint });
  return `${normalizedBase}${versionPrefixFallback}${endpoint}`;
}

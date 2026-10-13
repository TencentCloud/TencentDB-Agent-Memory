

/** 白名单端点元数据。 */
export interface WhitelistEndpoint {
  /**
   * 用户请求 path 的后缀（剥离 `/proxy/{spaceId}` 前缀后精确匹配）。
   * 例：`/v1/messages/count_tokens`
   */
  pathSuffix: string;
  /**
   * 转发到 upstream 时拼接到 `upstream.url` 之后的 endpoint 部分。
   * 例：`/messages/count_tokens`（拼在 `https://tokenhub.../v1` 之后）
   */
  upstreamEndpoint: string;
  /**
   * 协议类型：决定鉴权头格式（anthropic → `x-api-key`，openai → `Authorization: Bearer`）
   * 与 credit-reporter 的 usage 解析分支一致。
   */
  protocol: "anthropic" | "openai";
  /** 端点是否支持流式响应（SSE）。 */
  supportsStream: boolean;
  /**
   * 是否为主端点：主端点由现有的 `handleAnthropicMessages` / `handleChatCompletions`
   * 处理（含路由决策）；非主端点走轻量的 `handleAuxiliaryEndpoint`
   * （跳过路由，仅做鉴权 + 转发 + credit）。
   */
  isPrimary: boolean;
}

/**
 * 当前支持的白名单端点列表。
 *
 * 顺序不重要——`matchWhitelistEndpoint` 内部会按 `pathSuffix` 长度**从长到短**排序，
 * 以保证 `/v1/messages/count_tokens` 优先于 `/v1/messages` 命中。
 */
export const WHITELIST_ENDPOINTS: readonly WhitelistEndpoint[] = [
  // ── 主端点（由现有 handler 处理，含路由）────────────────────────
  {
    pathSuffix: "/v1/messages",
    upstreamEndpoint: "/messages",
    protocol: "anthropic",
    supportsStream: true,
    isPrimary: true,
  },
  {
    pathSuffix: "/v1/chat/completions",
    upstreamEndpoint: "/chat/completions",
    protocol: "openai",
    supportsStream: true,
    isPrimary: true,
  },
  // ── 辅助端点（由 handleAuxiliaryEndpoint 处理，不走路由）─────────
  {
    pathSuffix: "/v1/messages/count_tokens",
    upstreamEndpoint: "/messages/count_tokens",
    protocol: "anthropic",
    supportsStream: false,
    isPrimary: false,
  },
  {
    pathSuffix: "/v1/embeddings",
    upstreamEndpoint: "/embeddings",
    protocol: "openai",
    supportsStream: false,
    isPrimary: false,
  },
  {
    pathSuffix: "/v1/completions",
    upstreamEndpoint: "/completions",
    protocol: "openai",
    supportsStream: true,
    isPrimary: false,
  },
  {
    pathSuffix: "/v1/moderations",
    upstreamEndpoint: "/moderations",
    protocol: "openai",
    supportsStream: false,
    isPrimary: false,
  },
  // ── Codex Responses API 端点（由 codexHandler 处理）──────────────
  // 主端点：见 codexHandler.ts；上游拼接靠这里防止 joinUrl 走 fallback
  // 兜底到 /chat/completions（错误协议）。
  //
  // 两组条目对应 base_url 带 /v1 与不带 /v1 两种客户端写法，见 server.ts 的
  // codex 路由注释。matchWhitelistEndpoint 按 pathSuffix 长度降序匹配，
  // /v1/responses 会优先于 /responses 命中，保证语义清晰。
  {
    pathSuffix: "/v1/responses",
    upstreamEndpoint: "/responses",
    protocol: "openai",
    supportsStream: true,
    isPrimary: true,
  },
  {
    pathSuffix: "/v1/responses/compact",
    upstreamEndpoint: "/responses/compact",
    protocol: "openai",
    supportsStream: false,
    isPrimary: false,
  },
  {
    pathSuffix: "/v1/memories/trace_summarize",
    upstreamEndpoint: "/memories/trace_summarize",
    protocol: "openai",
    supportsStream: false,
    isPrimary: false,
  },
  {
    pathSuffix: "/v1/realtime/calls",
    upstreamEndpoint: "/realtime/calls",
    protocol: "openai",
    supportsStream: false,
    isPrimary: false,
  },
  {
    pathSuffix: "/responses",
    upstreamEndpoint: "/responses",
    protocol: "openai",
    supportsStream: true,
    isPrimary: true,
  },
  {
    pathSuffix: "/responses/compact",
    upstreamEndpoint: "/responses/compact",
    protocol: "openai",
    supportsStream: false,
    isPrimary: false,
  },
  {
    pathSuffix: "/memories/trace_summarize",
    upstreamEndpoint: "/memories/trace_summarize",
    protocol: "openai",
    supportsStream: false,
    isPrimary: false,
  },
  {
    pathSuffix: "/realtime/calls",
    upstreamEndpoint: "/realtime/calls",
    protocol: "openai",
    supportsStream: false,
    isPrimary: false,
  },
] as const;

/** 按长度降序排列的缓存，避免每次匹配都重新排序。 */
const SORTED_BY_SUFFIX_LEN: readonly WhitelistEndpoint[] = [...WHITELIST_ENDPOINTS].sort(
  (a, b) => b.pathSuffix.length - a.pathSuffix.length,
);

/** `/proxy/{spaceId}` 前缀正则：仅剥离一层，避免误伤路径中的 "proxy" 字面量。 */
const PROXY_PREFIX_RE = /^\/proxy\/[^/]+/;
/**
 * Agent 前缀正则：匹配 `/{agent}[/{spaceId}]/{v1|responses|...}` 形态。
 *   - `/claude-code/v1/messages`              → 剥 `/claude-code`
 *   - `/claude-code/{spaceId}/v1/messages`    → 剥 `/claude-code/{spaceId}`
 *   - `/codex/{spaceId}/responses`            → 剥 `/codex/{spaceId}`（codex 客户端
 *     不像 CC/CB 那样自拼 /v1/，源码 endpoint 常量就是 /responses，因此 base_url
 *     不带 /v1 时前缀后紧接的就是 /responses 或 /memories 等）
 * lookahead 允许 `/v1/`、`/responses`、`/responses/`、`/memories/`、`/realtime/`
 * 后紧邻，其中 `/v1/` 必须带尾斜杠避免误伤未来出现的 `/v1foo` 之类；responses
 * 等 codex 端点允许尾斜杠可选（如 `/responses` 是完整路径）。
 * 白名单入口 `/v1/messages`、`/responses` 自身不会被误剥（因为它们不匹配 agent
 * 段——agent 段限定为已知名字）。
 */
const AGENT_PREFIX_RE = /^\/(claude-code|codebuddy|codex|cursor|anthropic|openai|pi)(?:\/[^/]+)?(?=\/v1\/|\/responses(?:\/|$)|\/memories\/|\/realtime\/)/i;


const ANALYSE_MARKER_RE = /(?<=(?:\/[^/]+){2,})\/analyse(?=\/)/;

/**
 * 请求是否走遗留的 `/proxy/{spaceId}` 前缀。
 *
 * 该前缀不带 agent 信息，`agentSource` 只能兜底成 `claude-code`，据此解析出的
 * 会话身份与消息结构对其它客户端并不成立。因此这条入口只承担路由、压缩与计费，
 * 记忆类功能（session-init / mem 命令 / injection / L0 / skill）一律关闭——
 * 宁可不注入，也不要按错误的 agent 画像往用户上下文里塞东西。
 */
export function isLegacyProxyPath(requestPath: string): boolean {
  if (!requestPath) return false;
  const withoutQuery = requestPath.split("?", 1)[0] ?? "";
  return PROXY_PREFIX_RE.test(withoutQuery);
}


export function hasAnalyseMarker(requestPath: string): boolean {
  if (!requestPath) return false;
  const withoutQuery = requestPath.split("?", 1)[0] ?? "";
  return ANALYSE_MARKER_RE.test(withoutQuery);
}


export function normalizeWhitelistRequestPath(requestPath: string): string {
  if (!requestPath) return "";
  const withoutQuery = requestPath.split("?", 1)[0] ?? "";

  // surrounding `/{prefix}/{spaceId}` context is still intact — the markers'
  // lookbehind requires ≥ 2 leading segments. Then AGENT/PROXY prefixes see
  // the canonical `/v1/...` tail (their lookahead needs it) and remove themselves.
  const withoutAnalyse = withoutQuery.replace(ANALYSE_MARKER_RE, "");
  const withoutProxy = withoutAnalyse.replace(PROXY_PREFIX_RE, "");
  return withoutProxy.replace(AGENT_PREFIX_RE, "");
}

/**
 * 从请求路径匹配白名单条目。
 *
 * 匹配规则：
 * 1. `normalizeWhitelistRequestPath` 规范化路径（剥离 query / proxy 前缀 / agent+spaceId 前缀）
 * 2. 按 `pathSuffix` 长度**从长到短**尝试精确后缀匹配
 *
 * @returns 命中的白名单条目，未命中返回 `null`
 */
export function matchWhitelistEndpoint(
  requestPath: string,
): WhitelistEndpoint | null {
  const normalized = normalizeWhitelistRequestPath(requestPath);
  if (!normalized) return null;

  for (const entry of SORTED_BY_SUFFIX_LEN) {
    if (normalized === entry.pathSuffix) return entry;
  }
  return null;
}

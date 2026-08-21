/**
 * 白名单端点表：集中管理 context-proxy 支持转发的 Anthropic/OpenAI 端点。
 *
 * 该表是路由、URL 拼接、handler 分派三处逻辑的**单一数据源**：
 * - `server.ts` 依据表注册 Hono 路由（精确匹配放在 catch-all 之前）
 * - `guard-adapter.ts:joinUrl` 依据表决定上游 endpoint suffix，而非硬编码二分支
 * - `auxiliaryHandler.ts` 依据表决定是否透传、是否需要走 stream 分支
 *
 * 新增端点时，只需在 `WHITELIST_ENDPOINTS` 增加一条记录即可，无需散点修改。
 */

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
const AGENT_PREFIX_RE = /^\/(claude-code|codebuddy|codex|cursor|anthropic|openai)(?:\/[^/]+)?(?=\/v1\/|\/responses(?:\/|$)|\/memories\/|\/realtime\/)/i;

/**
 * `/cost-guard` marker 正则：位于 `/{agent}/{spaceId}` 之后的独立 segment。
 *
 * 语义（相对早期的 `/direct` marker 已反转）：**默认 passthrough**，
 * 仅在请求路径显式带上 `/cost-guard` 段时才让 primary handler 走 cost-guard 路由。
 *
 * 命中条件（两者同时满足）：
 *   1. lookahead `(?=/)`——marker 是一个独立 segment（后面还有内容），
 *      不限定紧接 `/v1/` 还是裸尾巴。这样 marker 与客户端拼的尾巴解耦：
 *        - `/codebuddy/{spaceId}/cost-guard/chat/completions`（CB 裸尾）
 *        - `/claude-code/{spaceId}/cost-guard/v1/messages`（CC 带 /v1）
 *      两种都识别为 marker。词干 `/cost-guarded/` `/cost-guarding/`
 *      `/pre-cost-guard/` 因 lookahead 要求 `/cost-guard` 后紧邻 `/` 而被隔断。
 *   2. lookbehind `(?<=(?:/[^/]+){2,})`——marker 前必须有 ≥ 2 段非空 segment，
 *      使 marker 只在 `/{agent}/{spaceId}/cost-guard/...` 或
 *      `/proxy/{spaceId}/cost-guard/...` 的结构下命中；spaceId 恰好
 *      叫 "cost-guard"（三段结构 `/agent/cost-guard/...`）不会误触发。
 *
 * 见 `hasCostGuardMarker` 让 primary handler 判定是否**启用** router；
 * `normalizeWhitelistRequestPath` 同步剥离它以保证白名单匹配继续工作。
 */
const COST_GUARD_MARKER_RE = /(?<=(?:\/[^/]+){2,})\/cost-guard(?=\/)/;

/**
 * `/analyse` marker：结构完全对齐 `/cost-guard`——位于 `/{agent}/{spaceId}` 之后
 * 的独立 segment，命中即表示"本次请求要走内部资产反思模式"。
 *
 * 由 `injection.assetReflection.markerOptIn` 门控，
 * 见 `AssetReflectionInjector`。跟 cost-guard 不同，`/analyse` **不注册**
 * 专门的 hono 路由——它是完全透明的标记：正常业务路径继续处理，
 * 只是 injector 检测到 marker 后往 system prompt 末尾多贴一段反思提示。
 *
 * `normalizeWhitelistRequestPath` 剥掉这个 marker，保证白名单后缀匹配继续工作。
 */
const ANALYSE_MARKER_RE = /(?<=(?:\/[^/]+){2,})\/analyse(?=\/)/;

/**
 * 请求路径是否携带 `/cost-guard` marker（位于 `/v1/` 之前的独立 segment）。
 * 携带时 primary handler 走完整的 cost-guard 路由；不带时（默认）直接透传到默认上游。
 */
export function hasCostGuardMarker(requestPath: string): boolean {
  if (!requestPath) return false;
  const withoutQuery = requestPath.split("?", 1)[0] ?? "";
  return COST_GUARD_MARKER_RE.test(withoutQuery);
}

/**
 * 请求路径是否携带 `/analyse` marker（结构同 `/cost-guard`）。
 * 命中时 `AssetReflectionInjector` 会在系统提示词末尾追加 `<asset_reflection>` 块。
 */
export function hasAnalyseMarker(requestPath: string): boolean {
  if (!requestPath) return false;
  const withoutQuery = requestPath.split("?", 1)[0] ?? "";
  return ANALYSE_MARKER_RE.test(withoutQuery);
}

/**
 * 规范化请求路径以便白名单匹配。
 *
 * 1. 剥离 query string
 * 2. 剥离 `/cost-guard` marker（如有，见 `hasCostGuardMarker`）
 * 3. 剥离 `/analyse` marker（如有，见 `hasAnalyseMarker`）
 * 4. 剥离 `/proxy/{spaceId}` 前缀（如有）
 * 5. 剥离 `/{agent}/{spaceId}` 前缀（如 `/claude-code/{spaceId}/v1/messages`）
 */
export function normalizeWhitelistRequestPath(requestPath: string): string {
  if (!requestPath) return "";
  const withoutQuery = requestPath.split("?", 1)[0] ?? "";
  // Order matters: strip `/cost-guard` / `/analyse` markers FIRST while the
  // surrounding `/{prefix}/{spaceId}` context is still intact — the markers'
  // lookbehind requires ≥ 2 leading segments. Then AGENT/PROXY prefixes see
  // the canonical `/v1/...` tail (their lookahead needs it) and remove themselves.
  const withoutCostGuard = withoutQuery.replace(COST_GUARD_MARKER_RE, "");
  const withoutAnalyse = withoutCostGuard.replace(ANALYSE_MARKER_RE, "");
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

/** Shared type definitions for context-proxy. */

/**
 * Optional private forwarding extension config.
 *
 * The host only understands a few generic fields; every other setting is kept
 * opaque in `options` and passed through to the private extension untouched.
 * The host never inspects, defaults, or type-checks the opaque payload.
 */
export interface CostGuardConfig {
  /** Master switch for the private forwarding extension. */
  enabled: boolean;
  /**
   * Whether the `/cost-guard` URL marker is required to activate the router.
   *
   *   - `false` (default, historical behavior): every request that reaches a
   *     primary handler goes through the cost-guard router (subject to
   *     `enabled`). The `/{agent}/{spaceId}/cost-guard/...` routes are NOT
   *     registered and return 404. This is what production runs — clients that
   *     never learned about the marker continue to work unchanged.
   *   - `true` (opt-in, test env): the router is only activated when the
   *     request path contains the `/cost-guard` segment. Paths without the
   *     marker skip the router and passthrough directly to the default
   *     upstream. Used to A/B compare guarded vs. bare traffic side by side.
   *
   * Independent of `enabled`: when `enabled=false` every request is a
   * passthrough regardless of this flag, matching pre-existing semantics.
   */
  markerOptIn?: boolean;
  /**
   * Pin the agent profile by id ("claude-code", "codebuddy").
   * Empty or "auto" (default) = auto-detect from request headers.
   */
  agentProfile?: string;
  /**
   * Anthropic-specific upstream override（用于 anthropic 协议请求的全局兜底上游）。
   * Per-agent override（upstream.agents[agent].url）优先级更高。
   */
  anthropicUpstream?: {
    url: string;
  };
  /**
   * Opaque private options, forwarded to the extension as-is.
   *
   * Known keys the current cost-guard build understands (still untyped here):
   * `taskArchiveEnabled`, `compress*` / `gate*`, `judge` (enabled, baseUrl,
   * timeouts, everyNToolTurns, latch*), `requestPrepare`, `controlPlane`,
   * analyze/cheap model fields, `agents` (per-agent cheap overrides).
   */
  options: Record<string, unknown>;
}

/**
 * ProxyStorage configuration —— injection/skill 数据从 Redis 迁到 COS/SQLite/FS
 * 的统一存储抽象层。见 docs/design/2026-07-10-cos-ttl-nottl-split-plan.md
 *
 * 当 `enabled: true` 时，注入层与 Skill 层会用 ProxyStorage 替换 Redis repo；
 * 否则完全走原 Redis 路径。CostGuard 的 `cg:sess:*` 不受影响。
 *
 * 存储 key 前缀分两档：
 *   - `ttl/` —— 热缓存（Session Init State / Injection Hook 预热），配 COS
 *     lifecycle rule `ttlDays` 天未修改自动删。丢了能重建，业务无感。
 *   - `nottl/` —— 业务态（Binding / Skill 抽取 / Skill 版本锁），**不配** rule，
 *     永久保留。
 */
export interface StorageConfig {
  /** 总开关。false = 完全走原 Redis 路径，本次迁移代码等同于未加载。 */
  enabled: boolean;
  /** 优选后端；init 失败按 cos → sqlite → fs → memory 顺序降级。 */
  backend: "cos" | "sqlite" | "fs" | "memory";
  /**
   * `ttl/` 前缀下对象的生存期（天）。只对 ttl 前缀生效，nottl 完全不受影响。
   * 默认 7 天，与 COS lifecycle rule 的粒度对齐（COS 天级扫描）。
   */
  ttlDays: number;

  cos: {
    /**
     * 业务命名空间前缀（跟 core 的 memory_v2/cos_data 隔离）。
     * bucket/region/endpointDomain 都由 Shark 返回的 CosUrl 解析，不用配。
     */
    rootPrefix: string;
    /**
     * 可选：强制走 VPC 内网 / 自定义域名（例：`cos.example.com`）。
     * 空则用 Shark 返回 CosUrl 里的 host。
     */
    endpointDomain?: string;
    /**
     * Shark 拉临时凭证 —— 每个 spaceId 独立 STS，权限严格绑到
     * `proxy_cache/{ttl|nottl}/{spaceId}/*` 两个前缀。
     * 见 docs/design/2026-07-12-cos-shark-sts-credential-plan.md §3.1。
     */
    shark: {
      /** Shark base URL，例如 `http://gateway.example.com:8000`。 */
      baseUrl: string;
      /** shark HTTP 请求超时。默认 10s。 */
      timeoutMs: number;
      /** 5xx / 429 / 网络错 / 超时的重试次数。默认 2。 */
      retryCount: number;
      /** STS 到期前多少 ms 提前刷新。默认 2min。 */
      refreshBufferMs: number;
      /** per-spaceId backend 池上限（LRU）。默认 100。 */
      maxSpaces: number;
      /** LRU evict 时延迟关闭旧 backend 的 ms。默认 30_000。 */
      graceCloseDelayMs: number;
    };
  };

  sqlite: {
    /** 空 = 用 PROXY_DB_PATH 或 ~/.tdai-memory-proxy/proxy.db。 */
    dbPath: string;
  };

  fs: {
    fsRoot: string;
  };
}

/** Redis connection configuration for session store (CostGuard + Injection). */
export interface RedisConfig {
  enabled: boolean;
  /** Redis connection URL (e.g. redis://:password@host:port/db). Overrides host/port/password/db if set. */
  url: string;
  /** Redis host. Default: "127.0.0.1". */
  host: string;
  /** Redis port. Default: 6379. */
  port: number;
  /** Redis password. Default: "". */
  password: string;
  /** Redis database index. Default: 0. */
  db: number;
  /** Key prefix for CostGuard session keys. Default: "cg:sess:". */
  keyPrefix: string;
  /** Session TTL in seconds. Default: 1800 (30 minutes). */
  ttlSeconds: number;
  /** Injection layer TTL override (seconds). Defaults to ttlSeconds. */
  injectionTtlSeconds?: number;
}

/** Per-Memory-instance input-token rate limiting. */
export interface RateLimitConfig {
  /** Input tokens per rolling minute. 0 disables the limiter. */
  tpm: number;
  /** Requests per rolling minute, using the same instance × model dimension. */
  qpm: number;
}

/**
 * Langfuse LLM observability configuration.
 *
 * 通过 Langfuse 官方 SDK 上报。一个 trace = 一个 turn（一次用户输入），
 * 同一 turn 内的工具循环请求归并到同一个 trace 下的多个 generation。
 */
export interface LangfuseConfig {
  enabled: boolean;
  /** Langfuse 实例 base URL，例如 http://localhost:3000。 */
  host: string;
  /** Langfuse public key（pk-lf-...）。 */
  publicKey: string;
  /** Langfuse secret key（sk-lf-...）。 */
  secretKey: string;
  /**
   * Debug 模式：上报 generation 时保留原始 Anthropic body 结构
   * （含 `cache_control` marker / `thinking` block / tool_use 原生形态），
   * 而不是走 `flattenAnthropicMessagesForOpik` 压平。
   *
   * 用途：排查请求分类（Fork vs SideQuery vs Main）、cache 命中率、
   *      thinking 签名合法性等需要看原生结构才能判断的问题。
   *
   * 代价：上报体积增大 2-5x（cache_control block、thinking block 全带过去），
   *      Langfuse 存储成本增加。**线上默认关闭**，只在排障时打开。
   */
  debug?: boolean;

  // ── 批量上报调优（防高并发丢 span）──

  /**
   * 内存队列最大深度（超出即丢弃）。
   * 映射 OTel BatchSpanProcessor 的 maxQueueSize。默认 8192。
   */
  maxQueueSize: number;
  /**
   * 每批导出的最大 span 数。
   * 映射 LangfuseSpanProcessor 的 flushAt / OTel maxExportBatchSize。默认 256。
   */
  flushAt: number;
  /**
   * 定时 flush 间隔（秒）。
   * 映射 LangfuseSpanProcessor 的 flushInterval / OTel scheduledDelayMillis。默认 2。
   */
  flushInterval: number;
}

/** Session initialization configuration. */
export interface SessionInitConfig {
  enabled: boolean;
  /** Max retries before degrading (bypass session init on next request). */
  maxRetries: number;
  /**
   * Whether to append the `[Agent]` section of the `<session_context>` block
   * (agent id / name / description / prompt) to the system prompt on every
   * request after session init completes.
   *
   * - `true`  (default): inject `[Agent]` — LLM sees agent identity/persona.
   * - `false`          : suppress `[Agent]` — the block loses the agent segment
   *   (and the entire block disappears if `injectTaskContext` is also false).
   *
   * Global toggle; not per-agent. Use to silence all agent descriptions.
   */
  injectAgentContext?: boolean;
  /**
   * Whether to append the `[Task]` section of the `<session_context>` block
   * (task id / name / description / goal) to the system prompt on every
   * request after session init completes.
   *
   * - `true`  (default): inject `[Task]` — LLM sees the task description.
   * - `false`          : suppress `[Task]` — the block loses the task segment
   *   (and the entire block disappears if `injectAgentContext` is also false).
   *
   * Global toggle; not per-task. Use to silence all task descriptions.
   */
  injectTaskContext?: boolean;
  /**
   * DEBUG-ONLY. When set, session init skips the interactive team → agent →
   * task form flow entirely and registers the session with the given identity
   * on the FIRST request that carries a conversation id. Useful for e2e tests
   * and local smoke checks where you want to exercise the injection pipeline
   * without stepping through the fake AskUserQuestion dialog turns.
   *
   * Leave undefined (or omit the block) in production. The identity is not
   * validated against the caller — it is trusted as-is because this is a
   * developer-facing bypass, not a security feature.
   */
  debugForceIdentity?: {
    team_id: string;
    agent_id: string;
    task_id?: string;
  };
  /**
   * DEBUG：把请求识别到的 userId（来自 auth verify / x-user-id 头等）强制
   * 覆盖为指定值。用于本地联调时——客户端传的 tokenhub-uid 与 kernel-uid 不一致
   * （kernel 侧资产挂在另一个真实 user_id 下），无法通过 kernel /team/list 拉到
   * 资产，导致 CB 状态机走 "no active agents, passing through" bypass。
   *
   * 配置此字段后，handler 层会用此 user_id 替换识别结果，让 CB 状态机以真实
   * kernel 用户身份拉资产列表，弹出完整 team→agent→task 表单流程。
   *
   * 仅供本地/e2e 联调，生产环境务必留空。
   */
  debugForceUserId?: string;
  /**
   * DEBUG：开启详细诊断日志（包括请求 tools schema、system prompt 摘要、
   * 用户输入文本等）。仅用于本地联调排查 session-init 表单交互问题。
   * 生产环境务必保持 false 或不配置（默认关闭）。
   */
  debugVerboseLogging?: boolean;
  /**
   * 从请求头自动预选 team/agent/task 身份。
   *
   * 当首轮请求头已带上身份字段时，先去（当前认证用户可见的）team/agent/task
   * 列表里校验其是否存在：命中则跳过对应的交互式选择步骤，缺失/校验失败时按
   * `onMismatch` 处理。与 control-plane token 反查并存 —— header 只是「快捷路径」，
   * 不改变原有的表单/反查流程。
   *
   * 决策规则（见 session/preset.ts）：
   * - 只命中 team（未带 agent）           → 跳到 agent 选择阶段
   * - 命中 team + agent（task 可选）        → 直接登记，跳过所有表单
   * - 任一「已提供」的字段在列表中查不到     → 视为 mismatch，按 onMismatch 处理
   * - 未带 team header                      → 完全走原有流程（零行为变化）
   */
  /**
   * 当用户在 task_select 阶段选择"跳过"时，使用此 task_id 作为默认关联。
   * 该 task_id 不需要在控制面元数据中真实存在——仅作为标签记录，不影响
   * 检索隔离（主维度为 team/user/agent/session）。
   *
   * 默认 "default"（开启）。若想关闭，在 YAML 中配为空字符串 `defaultTaskId: ""`。
   */
  defaultTaskId?: string;
  headerAutoSelect?: {
    /** 是否启用 header 自动预选。默认 true。 */
    enabled: boolean;
    /** 携带 team_id 的请求头名（小写）。默认 "x-team-id"。 */
    teamHeader: string;
    /** 携带 agent_id 的请求头名（小写）。默认 "x-agent-id"。 */
    agentHeader: string;
    /** 携带 task_id 的请求头名（小写）。默认 "x-task-id"。 */
    taskHeader: string;
    /** header 值在用户可见列表中查不到时：'form' 回退交互表单（默认）| 'bypass' 直接跳过 session init。 */
    onMismatch: "form" | "bypass";
  };
}

export interface TdaiConfig {
  enabled: boolean;
  endpoint: string;
  apiKey: string;
  serviceId: string;
  memory: {
    enabled: boolean;
    /** Master switch for all TDAI memory prompt injection. */
    inject: boolean;
    writeL0: boolean;
    recallL1: boolean;
    injectL2L3: boolean;
    l1Limit: number;
    l2Limit: number;
    timeoutMs: number;
  };
}

/**
 * Core skill data-plane configuration.
 *
 * The proxy talks to the openclaw-plugin gateway (the "core") for two purposes:
 *   1. RAG-driven `<cloud_skills>` injection (calls /v3/skill/search).
 *   2. Fire-and-forget skill extraction trigger (calls /v3/skill/extract?mode=async).
 *
 * The same `serviceToken` is also injected by the /skill-bridge reverse proxy
 * when the LLM curls skill operations, so that the token never appears in any
 * prompt the LLM sees.
 */
export interface CoreSkillConfig {
  /** Default `http://127.0.0.1:8420`. */
  endpoint: string;
  /** Bearer token for /v3/skill/* and /skill-bridge auth-injection. */
  serviceToken: string;
  /** `x-tdai-service-id` header value. Default `context-proxy`. */
  serviceId: string;
  /** Per-call timeout (ms). Default 1500 — RAG is on the session_init hot path. */
  timeoutMs: number;
}

/**
 * Knowledge tools injector configuration.
 *
 * Independent from `coreSkill` so knowledge gateway routing can diverge from
 * skill (e.g. skill via kernel direct-IP, knowledge via API Gateway).
 * Mirrors `CoreSkillConfig` fields — `CoreKnowledgeClient` accepts the same
 * Pick<endpoint | serviceToken | serviceId | timeoutMs>.
 */
export interface KnowledgeConfig {
  /** Master switch. `false` (default) → injector not registered, no injection. */
  enabled: boolean;
  endpoint: string;
  serviceToken: string;
  serviceId: string;
  timeoutMs: number;
}

/** Skill runtime-side configuration. */
export interface SkillRuntimeConfig {
  /**
   * 是否允许主模型创建/修改 skill。默认 false。
   * 主模型的质量不可控，默认关闭写入能力以避免低质量 skill 被创建。
   * 显式设为 true 后：
   *   - <skill_tools> 注入全部 10 个工具（含写操作）
   *   - /skill-bridge 放行写操作（create/update/patch/delete/files_write/files_remove）
   * false 时：
   *   - <skill_tools> 只注入只读工具（search/list/view/files_read）
   *   - /skill-bridge 拒绝写操作返回 403
   */
  allowLlmWrite: boolean;

  // 历史字段 (已删除):
  //   extractToolCallThreshold / maxBucketCount:
  //     老链路 SkillExtractTrigger 用来控制 proxy 自动 fire /v3/skill/extract 的阈值。
  //     老链路整体已下线, core 侧接管归档时机 (自己按 tool_call ≥ 10 或 bytes ≥ 40KB 判)。
  //   conversationAddEnabled:
  //     曾经用作新老链路互斥灰度开关。现在永远走新链路 conversation/add, 该开关废弃。
}

/**
 * Per-agent upstream override entry. When an agent (identified by URL path
 * prefix like "claude-code") needs a different upstream than the global
 * default, this struct provides the replacement `url` (and optional `apiKey`).
 *
 * Fallback semantics — three cases, matching the runtime `effectiveApiKey`
 * resolution in `handler.ts` / `anthropicHandler.ts`:
 *
 *   ┌──────────────────────────────┬────────────┬──────────────────────────┐
 *   │ agent config                 │ url used   │ apiKey used              │
 *   ├──────────────────────────────┼────────────┼──────────────────────────┤
 *   │ NOT in agents map            │ upstream.url│ upstream.apiKey (global)│
 *   │ in map, url only, no apiKey  │ agent.url  │ passthrough client key  │
 *   │ in map, url + apiKey         │ agent.url  │ agent.apiKey            │
 *   └──────────────────────────────┴────────────┴──────────────────────────┘
 *
 * The presence of an entry cuts the global `upstream.apiKey` fallback —
 * this is intentional so an operator can run some agents on a server-side
 * key and others on the client's own key from a single proxy config.
 *
 * Priority order (high → low):
 *   1. `costGuard`-provided `target.authHeaders`（cheap-model 兜底路由自带凭据）
 *   2. `upstream.agents[agent].url` + `upstream.agents[agent].apiKey`
 *   3. `costGuard.anthropicUpstream.url`（仅 Anthropic 协议）
 *   4. `upstream.url` + `upstream.apiKey`（未命中 agent 时的默认）
 *
 * The same map serves both Anthropic and OpenAI protocols — the agent name
 * alone determines routing, matching how {@link ProxyConfig#upstream.url}
 * itself is protocol-agnostic.
 */
export interface AgentUpstreamEntry {
  /** Target upstream base URL. Required. */
  url: string;
  /**
   * Per-agent apiKey. When set (non-empty):
   *   - OpenAI: `Authorization: Bearer <apiKey>` is injected
   *   - Anthropic: `x-api-key: <apiKey>` is injected
   * When absent / empty: the client's own auth header is passed through
   * upstream untouched. This does NOT fall back to `upstream.apiKey` —
   * that fallback only applies when this agent has no entry at all.
   */
  apiKey?: string;
}

/** Top-level proxy configuration (merged from config file + CLI args). */
export interface ProxyConfig {
  server: {
    host: string; // default: "0.0.0.0"
    port: number; // default: 8096
    /** Upstream forward timeout in ms. 0 = no timeout. Default: 600_000 (10 min). */
    forwardTimeoutMs?: number;
  };
  upstream: {
    url: string; // OpenAI-compatible upstream URL
    apiKey: string; // 若非空则替换请求中的 API Key
    /**
     * Per-agent overrides keyed by agent name (URL path prefix, e.g. "claude-code").
     * Empty / missing entry → agent falls back to `url` + `apiKey`.
     */
    agents: Record<string, AgentUpstreamEntry>;
  };
  log: {
    file: string;    // JSONL path; empty string disables file logging
    verbose: boolean;
    level: "info" | "debug"; // "debug" enables internal-debug.jsonl and requests-debug.jsonl
    /** Log backend type for structured logging (noop | console). Default: console. */
    backend: "noop" | "console";
    /** File rotation settings for structured log file (proxy.log). */
    rotate: {
      maxSizeBytes: number;
      backupLimit: number;
    };
  };
  opik: {
    enabled: boolean;
    url: string;    // Opik server base URL
    apiKey: string; // Opik server auth key (optional)
    /** When true, forked request_log traces/spans do not store message content. */
    stripRequestLogContent: boolean;
  };
  langfuse: LangfuseConfig;
  clickhouse: {
    enabled: boolean;
    url: string;         // ClickHouse HTTP endpoint
    database: string;    // Database name
    table: string;       // Table name for usage logs
    /** Raw usage traceability table (non-TokenHub / unrecognized format). */
    rawTable: string;
    user: string;        // Auth user
    password: string;    // Auth password
    flushIntervalMs: number; // Flush interval in ms
    flushThreshold: number;  // Buffer flush threshold in rows
    /** Data retention TTL in days. 0 = no TTL. Default: 0. */
    ttlDays: number;
  };
  redis: RedisConfig;
  rateLimit: RateLimitConfig;
  storage: StorageConfig;
  costGuard: CostGuardConfig;
  creditReport: CreditReportConfig;
  creditPricing: CreditPricingConfig;  // NEW: model pricing for credit calculation
  injection: InjectionConfig;
  extraction: ExtractionConfig;
  sessionInit: SessionInitConfig;
  tdai: TdaiConfig;
  coreSkill: CoreSkillConfig;
  knowledge: KnowledgeConfig;
  skillRuntime: SkillRuntimeConfig;
  auth: AuthConfig;
  /**
   * Internal service accounts allowed to passthrough the proxy without any
   * injection / session logic. Match is by `userKey` on inbound Authorization.
   * Empty array (default) disables the feature — every request goes through
   * the standard verifyUserKey pipeline.
   */
  systemUsers: SystemUserEntry[];
  /**
   * 运维口 shared secret，仅供 `/v3/instance/proxy-destroy` 之类的管控接口。
   *
   * 语义与 core gateway 的 `server.apiKey` 一致
   * （`tdai-memory-openclaw-plugin/src/gateway/server.ts:1078`）：
   *   - 空字符串（默认）= 鉴权关闭，路由公开可访问；启动时打 WARN 提醒
   *   - 非空 = 请求必须带 `Authorization: Bearer <apiKey>`，用常量时间比对
   *
   * env 覆盖：`TDAI_PROXY_ADMIN_API_KEY`。
   *
   * 注意：这个 key **不**参与租户 `verifyUserKey` 流程，跟 upstream.apiKey /
   * tdai.apiKey 也没关系。仅门禁 proxy 侧的运维口。
   */
  admin: {
    apiKey: string;
  };
  /**
   * `mem:` 特殊命令配置。
   *
   * 当 enabled=false（默认）时，handler 不会检测 mem: 命令，所有请求走原有链路。
   * 启用后，handler 在 session init 之后检测最后一条 user message 是否为 mem: 命令，
   * 命中则执行对应操作并直接返回伪造 LLM 响应（不注入 / 不转发 / 不计费）。
   *
   * allowedCommands 为命令白名单，空数组表示全部允许。
   */
  memCommand: MemCommandConfig;

  /**
   * CC 请求分流总开关。
   *
   * 启用时：根据 `cache_control` marker 位置 + tools/thinking 兜底将请求分为
   *   main / fork / sidequery 三类，走差异化路径（fork/sidequery 跳过
   *   session-init / mem 拦截 / injection / L0 / skill buffer，credit 仍上报）。
   * 关闭时：所有请求视为 main，走原有一刀切链路，行为 100% 等价现状。
   *
   * 默认关闭。启用前建议先跑一段"分类识别但不改路径"的观察期，见方案 §7。
   * 详见 docs/design/2026-07-30-cc-request-routing-plan.md
   */
  ccRequestRouting: CcRequestRoutingConfig;

  /**
   * WorkBuddy 请求分流总开关（运维 kill switch）。
   *
   * 启用时（默认）：调用 `classifyWorkbuddyRequest` 将请求分为 main / auxiliary
   *   两类，auxiliary 请求直接 passthrough（跳过 session-init / injection / L0 /
   *   skill 归档），credit 仍上报。
   * 关闭时：所有请求视为 main，走完整业务链路 —— 等价于 aux 分流未启用的老链路，
   *   用于 aux 分类规则出问题时快速回滚。
   *
   * 默认启用（与 CC 的 `ccRequestRouting.enabled` 默认 false 不同）：WB 的 aux
   *   分流已在生产跑通并有日志验证，此开关是"保守回滚"保险而非"灰度上线"开关。
   */
  workbuddyRequestRouting: WorkbuddyRequestRoutingConfig;
}

export interface CcRequestRoutingConfig {
  /** 是否启用 CC 请求分流。默认 false —— 关闭时走完全等价原有行为的老链路。 */
  enabled: boolean;
}

export interface WorkbuddyRequestRoutingConfig {
  /** 是否启用 WB 请求分流。默认 true —— 关闭时所有请求视为 main，跳过 aux 分流。 */
  enabled: boolean;
}

export interface MemCommandConfig {
  /** 是否启用 mem: 命令拦截。默认 false。 */
  enabled: boolean;
  /**
   * 命令白名单。空数组 = 全部允许。
   * 例如 ["sync", "help"] 表示只允许 mem:sync 和 mem:help，其他命令不识别。
   */
  allowedCommands: string[];
  /**
   * mem:create-task / mem:update-task 使用的 LLM 草稿生成器配置。可选。
   * 未配置或 enabled=false 时，task 命令族会返回"未配置 task_draft"错误。
   * 结构与 packages/cost-guard 的 LLMInferConfig 保持形状一致。
   */
  taskDraft?: {
    enabled: boolean;
    model: string;
    url: string;
    apiKey: string;
    timeoutMs: number;
  };
}

/** Context injection configuration. */
export interface InjectionConfig {
  enabled: boolean;
  injectors: string[];  // List of injector names to enable (e.g. ["skill", "knowledge", "tdai-memory"])
  /**
   * 对外统一 gateway 地址。LLM 生成的 curl 示例（<skill_tools> /
   * <tdai_memory_tools> 段里嵌的路径）都以这个 URL 为 base。
   *
   * ⚠️ 多节点部署必配：未配时每个 pod 会用自身 `http://<hostIp>:<port>`
   * 兜底，pods 互相覆盖 COS 里同一份 hook cache → md5 震荡 → 上游 Anthropic
   * KV cache 每次 miss（费钱 + 首 token 慢）。
   *
   * 只需填 gateway 对外域名，**不带端口**（gateway 内部路由到 proxy 的端口
   * 是 gateway ops 侧的事，跟这里无关）。示例：
   *   externalGatewayUrl: "https://gateway.example.com"
   *
   * gateway 侧必须把下面两个前缀原样透传到 proxy pod：
   *   `/skill-bridge/**`   → proxy /skill-bridge/**
   *   `/memory-bridge/**`  → proxy /memory-bridge/**
   *
   * 未配置时 fallback 到 `http://<local hostIp>:<config.server.port>`（仅
   * 单节点 / 本地开发场景可用），启动时 warn 一次。
   */
  externalGatewayUrl?: string;
  /**
   * 资产反思模式（内部效果评估用）。**默认开启**——为了让运营方零配置即可
   * 用 URL marker 观测资产注入效果。marker 本身仍是 opt-in：不带 `/analyse/`
   * 段的请求完全无感。
   *
   * 开启后，请求路径带 `/analyse` marker（结构同 `/cost-guard`：夹在
   * `/{agent}/{spaceId}` 之后，如 `/codebuddy/default/analyse/v1/messages`）
   * 时，proxy 会在系统提示词末尾追加一个 `<asset_reflection>` 块，指导
   * agent 在回答里点评「本轮调用过的云端资产工具是否起到作用」。
   *
   * marker 段列表由本节点上实际注册的资产 injector 决定（skill /
   * tdai-memory / knowledge），一个都没注册时 injector 不 emit 任何块。
   *
   * 姿势对齐 `costGuard.markerOptIn`，但 default 相反：
   *   - `true`（默认）：injector register；仅当 URL 带 `/analyse/` 段时才 emit 块
   *   - `false`：injector 不 register 且顶部 gate 把 `/analyse/` 段 404 拒
   */
  assetReflection?: {
    markerOptIn: boolean;
  };
}

/**
 * Extraction (write-side) configuration — dual of {@link InjectionConfig}.
 *
 * Governs whether the proxy is allowed to write back per-turn artifacts to
 * the kernel: skill conversation (fire /v3/skill/conversation/add per round
 * — core-side buffer + archive threshold decide抽取时机) and TDAI L0
 * conversation memory (`addConversation` after each turn).
 *
 * Legacy behavior (yaml missing this section entirely) is preserved by
 * `isExtractionAllowed`: it returns `true` when `config.extraction` is
 * absent. Default values `{enabled: true, extractors: ["skill","tdai-memory"]}`
 * also match the previous "always on" semantics.
 */
export interface ExtractionConfig {
  enabled: boolean;
  /** Asset whitelist. Assets NOT in this array are gated OFF, even if the
   *  underlying dependency (kernel token / tdai config) is present. */
  extractors: string[];
}

/** Auth service configuration — verify user_key and resolve user_id via auth/verify API. */
export interface AuthConfig {
  enabled: boolean;
  /** Auth service base URL (e.g. http://kernel.example.com:8420). */
  url: string;
  /** Request timeout in ms. Default: 5000. */
  timeoutMs: number;
}

/**
 * Internal / system user entry — a user id that identifies an internal
 * service (e.g. TDAI memory backend) rather than an end user.
 *
 * The request's Authorization / x-api-key is first resolved to a user_id
 * by the auth service (verifyUserKey). If that user_id equals this entry's
 * `userId`, the proxy short-circuits: session-init, injection, routing
 * decisions, and body rewriting are all skipped, and the request is forwarded
 * as-is to `config.upstream.url`. Usage / credit reporting still fires,
 * attributed to this entry's `userId` (memory instance / spaceId comes from
 * the request path).
 *
 * Auth must be enabled for the short-circuit to trigger — when it's off,
 * `verifyUserKey` returns an empty user_id and matching cannot happen.
 */
export interface SystemUserEntry {
  /** Short logical name — used for logging (e.g. "memory", "wiki", "skill"). */
  name: string;
  /**
   * User id attributed to this internal user. This is BOTH the match key
   * (against verifyUserKey's resolved user_id) and the attribution key for
   * usage/credit reporting. Required.
   */
  userId: string;
  /** Human-readable display name, for logs / dashboards only. */
  displayName: string;
  /**
   * Historical sk-mem key the internal service sends in Authorization /
   * x-api-key. Kept for log-only / operator-reference purposes; no longer
   * participates in matching (that's `userId`'s job now). Optional.
   */
  userKey?: string;
}

/** Credit usage reporting to external service (e.g. TDAI MemoryPlus). */
export interface CreditReportConfig {
  /** POST endpoint URL. */
  url: string;
  /** Request timeout in ms. */
  timeoutMs: number;
}

/** Credit pricing entry for a single model (Credit / 1K Token). */
export interface CreditPricingEntry {
  /**
   * Model ID for matching (case-insensitive full-word match against usage.model).
   * 语义是「唯一 ID」，如 `ep-pksklwtb` / `deepseek-v4-pro`。
   */
  name: string;
  /**
   * Human-readable display name for UI/reports (e.g. "Claude Sonnet 4").
   * Optional. Falls back to `name` when absent or empty.
   * 写入 usage_logs.model_name / usage_raw.model_name 供前端展示。
   */
  modelName?: string;
  /** Standard input tokens (non-cache). */
  input: number;
  /** Output tokens. */
  output: number;
  /** Cache read (cache hit) tokens. */
  cacheRead: number;
  /** Cache write with 5-minute TTL (ephemeral). */
  cacheWrite5m: number;
  /** Cache write with 1-hour TTL (standard cache creation). */
  cacheWrite1h: number;
}

/** Credit pricing configuration section. */
export interface CreditPricingConfig {
  models: CreditPricingEntry[];
}

/** Raw YAML config file shape (all fields optional). */
export interface RawYamlConfig {
  server?: {
    host?: string;
    port?: number;
    forwardTimeoutMs?: number;
  };
  upstream?: {
    url?: string;
    apiKey?: string;
    /** Per-agent override map. See `AgentUpstreamEntry`. */
    agents?: Record<string, { url?: string; apiKey?: string } | null | undefined>;
  };
  log?: {
    file?: string;
    verbose?: boolean;
    level?: "info" | "debug";
    backend?: "noop" | "console";
    rotate?: {
      maxSizeBytes?: number;
      backupLimit?: number;
    };
  };
  opik?: {
    enabled?: boolean;
    url?: string;
    apiKey?: string;
    stripRequestLogContent?: boolean;
  };
  redis?: {
    enabled?: boolean;
    url?: string;
    host?: string;
    port?: number;
    password?: string;
    db?: number;
    keyPrefix?: string;
    ttlSeconds?: number;
    injectionTtlSeconds?: number;
  };
  rateLimit?: {
    tpm?: number;
    qpm?: number;
  };
  storage?: {
    enabled?: boolean;
    backend?: "cos" | "sqlite" | "fs" | "memory";
    ttlDays?: number;
    cos?: {
      rootPrefix?: string;
      endpointDomain?: string;
      shark?: {
        baseUrl?: string;
        timeoutMs?: number;
        retryCount?: number;
        refreshBufferMs?: number;
        maxSpaces?: number;
        graceCloseDelayMs?: number;
      };
    };
    sqlite?: { dbPath?: string };
    fs?: { fsRoot?: string };
  };
  costGuard?: {
    enabled?: boolean;
    agentProfile?: string;
    anthropicUpstream?: { url?: string };
    /** Opaque private options, kept unparsed and forwarded to the extension. */
    [key: string]: unknown;
  };
  clickhouse?: {
    enabled?: boolean;
    url?: string;
    database?: string;
    table?: string;
    rawTable?: string;
    user?: string;
    password?: string;
    flushIntervalMs?: number;
    flushThreshold?: number;
    ttlDays?: number;
  };
  langfuse?: {
    enabled?: boolean;
    host?: string;
    publicKey?: string;
    secretKey?: string;
    debug?: boolean;
    maxQueueSize?: number;
    flushAt?: number;
    flushInterval?: number;
  };
  creditReport?: { url?: string; timeoutMs?: number };
  creditPricing?: { models?: Partial<CreditPricingEntry>[] };
  /** Opaque private review options, forwarded to the extension untouched. */
  badcaseCollector?: Record<string, unknown>;
  injection?: {
    enabled?: boolean;
    endpoint?: string;
    injectors?: string[];
    externalGatewayUrl?: string;
    assetReflection?: {
      markerOptIn?: boolean;
    };
  };
  extraction?: {
    enabled?: boolean;
    extractors?: string[];
  };
  sessionInit?: {
    enabled?: boolean;
    maxRetries?: number;
    injectAgentContext?: boolean;
    injectTaskContext?: boolean;
    defaultTaskId?: string;
    debugForceIdentity?: {
      team_id?: string;
      agent_id?: string;
      task_id?: string;
    };
    debugForceUserId?: string;
    debugVerboseLogging?: boolean;
    headerAutoSelect?: {
      enabled?: boolean;
      teamHeader?: string;
      agentHeader?: string;
      taskHeader?: string;
      onMismatch?: "form" | "bypass";
    };
  };
  tdai?: {
    enabled?: boolean;
    endpoint?: string;
    apiKey?: string;
    serviceId?: string;
    memory?: Partial<TdaiConfig["memory"]>;
  };
  /**
   * Skill/Kernel bridge config. Historically named `coreSkill`; accepted under
   * either `skill:` or `coreSkill:` in YAML (see `buildConfig`). Internally
   * still stored as `coreSkill` on ProxyConfig — no code churn beyond the
   * YAML alias.
   */
  skill?: Partial<CoreSkillConfig>;
  coreSkill?: Partial<CoreSkillConfig>;
  knowledge?: Partial<KnowledgeConfig>;
  skillRuntime?: {
    allowLlmWrite?: boolean;
  };
  auth?: {
    enabled?: boolean;
    url?: string;
    timeoutMs?: number;
  };
  systemUsers?: Partial<SystemUserEntry>[];
  admin?: {
    apiKey?: string;
  };
  /**
   * mem: 命令族配置（含 create-task / update-task 的 LLM 草稿生成器）。
   * 与 ProxyConfig.memCommand 对应；未配置则命令族按默认禁用行为。
   */
  memCommand?: {
    enabled?: boolean;
    allowedCommands?: unknown[];
    taskDraft?: {
      enabled?: unknown;
      model?: unknown;
      url?: unknown;
      apiKey?: unknown;
      timeoutMs?: unknown;
    };
  };
}

/** request event — written when a request is intercepted (metadata only, no messages). */
export interface RequestLogEntry {
  timestamp: string;
  event: "request";
  modelId: string;
  keyId: string; // SHA-256(apiKey).slice(0, 8)
  sessionKey?: string; // conversationId || keyId — per-conversation isolation key
  upstreamUrl: string;
  stream: boolean;
  temperature?: number;
  maxTokens?: number;
  routedFrom?: string;     // original model if routing was applied
  routingPercent?: number;  // routing rule percent that triggered
  /**
   * Upstream request id — read from the response header `x-request-id`
   * (typically set by tokenhub / OpenAI-compatible gateways). Empty when
   * upstream did not return one. Used for cross-system tracing/audit.
   */
  upstreamRequestId?: string;
}

/** usage event — written after LLM response is received. */
export interface UsageLogEntry {
  timestamp: string;
  event: "usage";
  modelId: string;
  keyId: string;
  sessionKey?: string; // conversationId || keyId — per-conversation isolation key
  /** Turn sequence number within the session (for per-turn aggregation). */
  turnSeq?: number;
  /** Denoised user input of the turn (non-empty only on the turn's first request). */
  userInput?: string;
  upstreamUrl: string;
  stream: boolean;
  usage: Record<string, unknown>; // raw LLM usage object, unmodified
  routedFrom?: string;     // original model if routing was applied
  /**
   * Scalar counters reported by the optional private request-preparation
   * stage, recorded verbatim. The host neither defines nor interprets the key
   * set — it varies with the extension version, and omitting the field means
   * the stage did not run. See `request-prepare-adapter.ts`.
   */
  extensionStats?: Record<string, unknown>;
  /** Space/tenant ID extracted from /proxy/<spaceId>/... path. */
  spaceId?: string;
  /**
   * Upstream request id — read from the response header `x-request-id`
   * (typically set by tokenhub / OpenAI-compatible gateways). Empty when
   * upstream did not return one. Used for cross-system tracing/audit.
   */
  upstreamRequestId?: string;
}

/**
 * Extension-emitted telemetry event.
 *
 * Emitted by the optional private extension (when loaded) via the injected
 * `writeLogEvent` callback. The host only forwards the payload to the log sink
 * — it does not interpret or generate this event on its own.
 *
 * The field set intentionally mirrors {@link UsageLogEntry} so downstream log
 * consumers can process both events with a single schema; `event` distinguishes
 * them at query time.
 */
export interface AnalyzerUsageLogEntry {
  timestamp: string;
  event: "analyzer_usage";
  modelId: string;
  keyId: string;
  sessionKey?: string;
  turnSeq?: number;
  upstreamUrl: string;
  stream: false;
  usage: Record<string, unknown>;
  /** Original model ID captured for correlation with the parent request. */
  routedFrom?: string;
  spaceId?: string;
  upstreamRequestId?: string;
}

export type LogEntry = RequestLogEntry | UsageLogEntry | AnalyzerUsageLogEntry;

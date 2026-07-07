/**
 * Claude Code 适配器配置 — 从环境变量读取 Gateway 连接信息与用户/会话策略。
 *
 * 本模块运行在 MCP server / hooks 进程中（进程外宿主），不进入 OpenClaw bundle，
 * 故直接读 env 而非走 utils/env.ts 的 getEnv 间接层（那是为了规避 OpenClaw 安全扫描）。
 *
 * env 变量（均有默认值）：
 *   TDAI_GATEWAY_HOST       默认 "127.0.0.1"
 *   TDAI_GATEWAY_PORT       默认 8420
 *   TDAI_GATEWAY_BASE_URL   覆盖整条 baseUrl（ behind 反代时有用），默认 http://host:port
 *   TDAI_MCP_API_KEY        Bearer 令牌（首选）；回退 TDAI_GATEWAY_API_KEY（同 Hermes 双名约定）
 *   TDAI_USER_ID            用户标识，默认 "default_user"
 *
 * sessionKey 策略（设计 §5.1）：
 *   Claude Code 钩子载荷含 session_id → 直接用作 sessionKey（L0 分组）。
 *   无 session_id → 回退 `cwd::YYYY-MM-DD`（单会话分组、跨会话召回，语义对齐 OpenClaw）。
 */

// ============================
// 配置类型
// ============================

export interface ClaudeCodeAdapterConfig {
  /** Gateway 主机。env: TDAI_GATEWAY_HOST，默认 "127.0.0.1"。 */
  gatewayHost: string;
  /** Gateway 端口。env: TDAI_GATEWAY_PORT，默认 8420。 */
  gatewayPort: number;
  /** 完整 baseUrl，传给 TdaiHttpClient。env: TDAI_GATEWAY_BASE_URL 覆盖，否则 http://host:port。 */
  gatewayBaseUrl: string;
  /** Bearer 令牌；TDAI_MCP_API_KEY ?? TDAI_GATEWAY_API_KEY，trim 后为空则 undefined。 */
  apiKey?: string;
  /** 用户标识。env: TDAI_USER_ID，默认 "default_user"。 */
  userId: string;
}

// ============================
// env 读取
// ============================

/** 读取并 trim；空串视为未设置（返回 undefined）。 */
function readStr(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key];
  return v && v.trim() ? v.trim() : undefined;
}

function readInt(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const v = readStr(env, key);
  if (v === undefined) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

// ============================
// 配置加载
// ============================

/**
 * 从 env 解析 Claude Code 适配器配置。
 *
 * @param env 可选 env 对象，默认 process.env；测试时注入自定义 env。
 */
export function loadClaudeCodeConfig(env: NodeJS.ProcessEnv = process.env): ClaudeCodeAdapterConfig {
  const gatewayHost = readStr(env, "TDAI_GATEWAY_HOST") ?? "127.0.0.1";
  const gatewayPort = readInt(env, "TDAI_GATEWAY_PORT") ?? 8420;
  const gatewayBaseUrl =
    readStr(env, "TDAI_GATEWAY_BASE_URL") ?? `http://${gatewayHost}:${gatewayPort}`;
  // 双名回退：MCP 专用名优先，回退到 Gateway 通用名（同 Hermes 约定）
  const apiKey = readStr(env, "TDAI_MCP_API_KEY") ?? readStr(env, "TDAI_GATEWAY_API_KEY");
  const userId = readStr(env, "TDAI_USER_ID") ?? "default_user";

  return { gatewayHost, gatewayPort, gatewayBaseUrl, apiKey, userId };
}

// ============================
// sessionKey 解析（纯函数，便于单测）
// ============================

/**
 * 把 Claude Code 的 session_id 解析为 L0 分组用的 sessionKey。
 *
 * 策略（设计 §5.1）：
 *   1. session_id 非空 → 直接返回（trim 后）
 *   2. 否则回退 `cwd::YYYY-MM-DD`（UTC 日期，保证测试可复现）
 *
 * 回退时 cwd 的反斜杠归一为 `/` 并去尾斜杠，使 Windows/Linux 产生一致的 key。
 *
 * @param sessionId 钩子载荷里的 session_id（可选）
 * @param cwd       工作目录（可选，默认 process.cwd()）
 * @param now       当前时间（可选，默认 new Date()；测试注入固定日期）
 */
export function resolveSessionKey(
  sessionId?: string,
  cwd?: string,
  now: Date = new Date(),
): string {
  const sid = sessionId?.trim();
  if (sid) return sid;

  const dir = (cwd?.trim() || process.cwd()).replace(/\\/g, "/").replace(/\/+$/, "");
  const date = now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  return `${dir}::${date}`;
}

import { config as loadDotenv } from 'dotenv';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { LogLevel } from '../infra/logger.js';

loadDotenv();

function env(key: string, fallback: string): string {
  // 空串视为未设置：.env 里常被写成 `PANEL_AUTH_WOA_LOGIN_URL=`（占位/留空），
  // 若按 ?? 语义会把空串当成有效值，导致 URL 变空、WOA 跳转静默失效。
  // 统一按"留空即用默认值"处理，让 .env.example 里的空占位项可安全保留。
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** 可选 ClickHouse API 调用审计配置。enabled=false 或 url 为空时全静默跳过。 */
export interface PanelClickHouseConfig {
  enabled: boolean;
  url: string;
  database: string;
  table: string;
  user: string;
  password: string;
  flushIntervalMs: number;
  flushThreshold: number;
  ttlDays: number;
  requestTimeoutMs: number;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

function envFirst(keys: string[], fallback: string): string {
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && value !== '') return value;
  }
  return fallback;
}

function envBoolFirst(keys: string[], fallback: boolean): boolean {
  const raw = envFirst(keys, '');
  return raw === '' ? fallback : raw === 'true' || raw === '1';
}

/**
 * 解析 Panel Session/加密密钥（**内部生成，不接受外部配置**）：
 * 1. 优先从持久文件读取（与 identity 绑定同目录，生命周期一致）；
 * 2. 文件不存在则自动生成随机强密钥并写入（权限 0600），后续重启复用。
 *
 * 不提供 PANEL_AUTH_SESSION_SECRET 之类的环境变量入口：密钥一旦可被外部指定，
 * 就可能被写进 .env 并提交进仓库。内部生成能保证它只以 0600 文件形式存在。
 * 重启/多次启动保持稳定（换密钥会导致已存 identity 绑定无法解密）。
 */
function resolveSessionSecret(identityStorePath: string): string {
  const secretPath = env('PANEL_AUTH_SESSION_SECRET_FILE', join(dirname(identityStorePath), 'panel-session-secret'));
  try {
    if (existsSync(secretPath)) {
      const existing = readFileSync(secretPath, 'utf8').trim();
      if (existing) return existing;
    }
  } catch (err) {
    throw new Error(`failed to read session secret file at ${secretPath}: ${(err as Error).message}`);
  }

  const generated = randomBytes(32).toString('hex');
  try {
    mkdirSync(dirname(secretPath), { recursive: true });
    writeFileSync(secretPath, `${generated}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    throw new Error(`failed to persist auto-generated session secret at ${secretPath}: ${(err as Error).message}`);
  }
  return generated;
}

export interface PanelConfig {
  server: { host: string; port: number };
  metadataInstancesConfig: string;
  metadataRemoteTimeoutMs: number;
  ui: { distDir: string };
  log: { level: LogLevel; format: 'json' | 'pretty' };
  /** Knowledge Service (KS :8421) 连接配置。serviceId 按请求 instanceId 注入。 */
  knowledge: { baseUrl: string; authToken: string; timeoutMs: number };
  /**
   * 启动时为每个实例确保 knowledge-service LLM 绑定（走 proxy 记账）。
   * sync=false 时完全跳过（不改变现有部署行为）。
   */
  knowledgeLlmBinding: {
    sync: boolean;
    proxyBaseUrl: string;
  };
  /** 默认 Agent 模板文件的本地存储目录根（存 Panel 本地，按 {dir}/{instanceId}/{team_id}/template.json）。 */
  agentTemplateDir: string;
  /**
   * 「可观测」功能开关（env PANEL_FEATURE_ANALYTICS_ENABLED）。
   *
   * 可观测页（线上调用情况）依赖内核侧 ClickHouse 埋点。未配置 CH 的部署打开
   * 该页只会得到"未配置/不可达"提示，故默认关闭隐藏入口；仅当确实接入了
   * analytics ClickHouse 时由部署方显式开启。该值经 GET /meta/instances 的
   * capabilities 下发给前端用于菜单/路由可见性控制。
   */
  featureAnalyticsEnabled: boolean;
  /** 可选 ClickHouse API 调用审计。不配则全静默不上报。 */
  clickhouse: PanelClickHouseConfig;
  auth: PanelAuthConfig;
}

export interface PanelAuthConfig {
  userKeyEnabled: boolean;
  idpEnabled: boolean;
  sessionTtlSeconds: number;
  sessionCookieName: string;
  sessionSecure: boolean;
  sessionSecret: string;
  identityStorePath: string;
  woa: {
    enabled: boolean;
    appToken: string;
    safeMode: boolean;
    requireSignature: boolean;
    appUrl: string;
    loginUrl: string;
    logoutUrl: string;
    paasId: string;
    defaultTeamId: string;
    defaultRole: string;
    /**
     * 写入 core `meta_users.auth_provider` 的外部域标识。
     *
     * 写入（建号/绑定）与读取（find-by-external）都用同一值，保证落在同一个域；
     * 两侧若不一致会出现"写进 A 域、按 B 域查"的静默失效。
     * 默认 'local' 与 Core 的 DEFAULT_AUTH_PROVIDER 对齐（零配置即一致）。
     */
    authProvider: string;
  };
}

function buildAuthConfig(): PanelAuthConfig {
  const modeRaw = env('PANEL_AUTH_MODE', '').trim();
  const legacyUserKey = envBoolFirst(['PANEL_AUTH_USER_KEY_ENABLED'], true);
  const legacyIdp = envBoolFirst(['PANEL_AUTH_IDP_ENABLED'], false);
  const legacyWoa = envBoolFirst(['PANEL_AUTH_IDP_WOA_ENABLED'], false);
  const modes = new Set(
    (modeRaw || (legacyIdp || legacyWoa ? 'user_key,woa' : legacyUserKey ? 'user_key' : ''))
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
  let userKeyEnabled = modes.has('user_key');
  const woaEnabled = modes.has('woa');
  const idpEnabled = woaEnabled || modes.has('idp');
  // 配置健壮性：user_key 是零配置默认登录方式。
  // 若解析后既没有 user_key 也没有任何 IdP（例如 PANEL_AUTH_MODE 填了未识别值、
  // 或未来 legacy 变量被移除后漏配），退化为"启用 user_key"，
  // 而不是让服务启动失败。这样"没开 WOA 时和 WOA 开发前一样能用"成为强不变量。
  if (!userKeyEnabled && !idpEnabled) {
    userKeyEnabled = true;
  }
  const appUrl = envFirst(['PANEL_AUTH_WOA_APP_URL', 'PANEL_AUTH_IDP_WOA_APP_URL'], '');
  const identityStorePath = env('PANEL_AUTH_IDENTITY_STORE_PATH', './data/panel-auth-identities.json');

  return {
    userKeyEnabled,
    idpEnabled,
    sessionTtlSeconds: envInt('PANEL_AUTH_SESSION_TTL_SECONDS', 28_800),
    sessionCookieName: env('PANEL_AUTH_SESSION_COOKIE_NAME', 'tdai_idp_session'),
    sessionSecure: envBoolFirst(['PANEL_AUTH_SESSION_SECURE'], appUrl.startsWith('https://')),
    // 仅在启用 IdP 时才需要密钥；未启用时留空，避免非 WOA 部署也生成密钥文件。
    sessionSecret: idpEnabled ? resolveSessionSecret(identityStorePath) : '',
    identityStorePath,
    woa: {
      enabled: woaEnabled,
      appToken: envFirst(['PANEL_AUTH_WOA_APP_TOKEN', 'PANEL_AUTH_IDP_WOA_APP_TOKEN'], ''),
      safeMode: envBoolFirst(['PANEL_AUTH_WOA_SAFE_MODE', 'PANEL_AUTH_IDP_WOA_SAFE_MODE'], true),
      requireSignature: envBoolFirst(['PANEL_AUTH_WOA_REQUIRE_SIGNATURE', 'PANEL_AUTH_IDP_WOA_REQUIRE_SIGNATURE'], true),
      appUrl,
      // 无内置默认值，必须显式配置：这两个地址属内网基础设施信息，硬编码进源码既是
      // 信息暴露，也会让漏配退化成静默错误（跳到错误地址且无报错）。
      // 缺失时由 WoaProvider.requiredUrl 在使用点显式抛错。
      loginUrl: env('PANEL_AUTH_WOA_LOGIN_URL', ''),
      logoutUrl: env('PANEL_AUTH_WOA_LOGOUT_URL', ''),
      paasId: envFirst(['PANEL_AUTH_WOA_PAAS_ID', 'PANEL_AUTH_IDP_WOA_PAAS_ID'], ''),
      defaultTeamId: envFirst(['PANEL_AUTH_WOA_DEFAULT_TEAM_ID', 'PANEL_AUTH_IDP_WOA_DEFAULT_TEAM_ID'], ''),
      defaultRole: env('PANEL_AUTH_WOA_DEFAULT_ROLE', 'member'),
      // 与 Core 的 METADATA_EXTERNAL_AUTH_PROVIDER 同名同义：部署时两侧配成同一个
      // 值即可（Core 侧未设置时回落 'local'，与本默认值一致，零配置即对齐）。
      authProvider: envFirst(
        ['METADATA_EXTERNAL_AUTH_PROVIDER', 'PANEL_AUTH_WOA_AUTH_PROVIDER'],
        'local',
      ),
    },
  };
}

export function loadPanelConfig(): PanelConfig {
  const level = env('LOG_LEVEL', 'info') as LogLevel;
  const format = env('LOG_FORMAT', 'json') as 'json' | 'pretty';
  return {
    server: {
      host: env('HOST', '0.0.0.0'),
      port: envInt('PORT', 8123),
    },
    metadataInstancesConfig: env('METADATA_INSTANCES_CONFIG', './config/metadata-instances.json'),
    metadataRemoteTimeoutMs: envInt('METADATA_REMOTE_TIMEOUT_MS', 15_000),
    ui: { distDir: env('UI_DIST_DIR', './web/dist') },
    log: {
      level: ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info',
      format: format === 'pretty' ? 'pretty' : 'json',
    },
    knowledge: {
      baseUrl: env('KNOWLEDGE_SERVICE_URL', 'http://127.0.0.1:8421'),
      authToken: env('KNOWLEDGE_AUTH_TOKEN', ''),
      timeoutMs: envInt('KNOWLEDGE_TIMEOUT_MS', 15_000),
    },
    knowledgeLlmBinding: {
      sync: envBool('KNOWLEDGE_LLM_BINDING_SYNC', true),
      proxyBaseUrl: env('KNOWLEDGE_LLM_PROXY_BASE_URL', 'http://127.0.0.1:8096'),
    },
    agentTemplateDir: env('TDAI_AGENT_TEMPLATE_DIR', './data/agent-templates'),
    // 默认关闭（保守）：可观测页依赖内核 ClickHouse 埋点，未接入的部署不展示入口。
    featureAnalyticsEnabled: envBool('PANEL_FEATURE_ANALYTICS_ENABLED', false),
    clickhouse: {
      enabled: envBool('PANEL_CLICKHOUSE_ENABLED', false),
      url: env('PANEL_CLICKHOUSE_URL', ''),
      database: env('PANEL_CLICKHOUSE_DATABASE', 'default'),
      table: env('PANEL_CLICKHOUSE_TABLE', 'panel_api_call_logs'),
      user: env('PANEL_CLICKHOUSE_USER', 'default'),
      password: env('PANEL_CLICKHOUSE_PASSWORD', ''),
      flushIntervalMs: envInt('PANEL_CLICKHOUSE_FLUSH_INTERVAL_MS', 5000),
      flushThreshold: envInt('PANEL_CLICKHOUSE_FLUSH_THRESHOLD', 50),
      ttlDays: envInt('PANEL_CLICKHOUSE_TTL_DAYS', 90),
      requestTimeoutMs: envInt('PANEL_CLICKHOUSE_REQUEST_TIMEOUT_MS', 5000),
    },
    auth: buildAuthConfig(),
  };
}

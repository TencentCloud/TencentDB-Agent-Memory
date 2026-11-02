/**
 * 内核 /v3/analytics/* 查询面 action 列表（Core 16 条）。
 *
 * 对接文档：iwiki 4036925405「团队记忆可观测性 Analytics Query API」。
 * 数据源为 MemoryCore 侧 ClickHouse（database: context_proxy）的四张表：
 * usage_logs / usage_raw / session_init_logs / tool_call_logs。
 *
 * 与 /v3/meta/*、/v3/skill/* 的差异：
 *   - method 不统一：config / spaces 是 GET，其余 14 条是 POST（用错 method → 405）；
 *   - 除 config 外全部要求 system_admin（内核 authenticateV3 校验），普通成员 → 403；
 *   - CH 未配置时除 config 外全部 503（config 返回 configured:false）；
 *   - 过滤维度是 space_id / user_id（不支持 team_id），时间窗为 days 或 from/to。
 *
 * 本期只接入「指标 + trace」查询面，watermark / detail-fetch 保留在列表内
 * （后续 recall 增量链路复用），页面端不直接调用。
 */

/** GET 类 action —— 内核声明为 GET，必须用 GET 转发，否则 405。 */
export const ANALYTICS_GET_ACTIONS = new Set(['config', 'spaces']);

export const ANALYTICS_ACTIONS = [
  // 元信息
  'config',
  'spaces',
  // 会话初始化 / 渗透率
  'session-init/summary',
  'session-init/timeseries',
  'session-init/bypass-reasons',
  // 工具调用行为
  'tool-calls/endpoint-share',
  'tool-calls/top-bodies',
  'tool-calls/timeseries',
  'tool-calls/list',
  'tool-calls/watermark',
  'tool-calls/detail-fetch',
  // Token / Credit 用量
  'usage/summary',
  'usage/timeseries',
  'usage/by-model',
  'usage/list',
  'usage-raw/list',
] as const;

export type AnalyticsAction = (typeof ANALYTICS_ACTIONS)[number];

export const ALLOWED_ANALYTICS_ACTIONS = new Set<string>(ANALYTICS_ACTIONS);

export function isAllowedAnalyticsAction(action: string): action is AnalyticsAction {
  return ALLOWED_ANALYTICS_ACTIONS.has(action);
}

/** 该 action 是否走 GET（否则 POST）。 */
export function isAnalyticsGetAction(action: string): boolean {
  return ANALYTICS_GET_ACTIONS.has(action);
}

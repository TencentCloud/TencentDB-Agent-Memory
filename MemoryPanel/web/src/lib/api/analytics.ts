/**
 * api/analytics.ts — 「可观测」查询面 API 客户端。
 *
 * 走 Panel 的 /api/v1/analytics/* 透明代理 → 内核 /v3/analytics/*（iwiki 4036925405）。
 * 与 meta 一致：注入 X-Tdai-Service-Id + X-Tdai-User-Key，信封解包复用 base 的
 * unwrapEnvelope（保持与 meta 相同的错误语义）。
 *
 * 页面只消费「指标」查询面：config / session-init(summary、timeseries、
 * bypass-reasons) / tool-calls(endpoint-share、top-bodies)。watermark / detail-fetch
 * 属 recall 增量数据接口，不在页面使用范围；spaces（全量 space_id 列表）与
 * 「按登录实例隔离」的数据面语义相悖，已下线。
 *
 * 全部接口都是幂等只读查询，统一经 dedupeInFlight 去重：既消除 React 18 StrictMode
 * 开发态 effect 双调用，也避免 60s 定时刷新与手动刷新叠加时的重复请求堆积。
 */

import { ApiError, dedupeInFlight, request, unwrapEnvelope } from './base';
import { getPanelSession } from '../panelSession';
import type { MetaEnvelope } from './types';

/** 时间窗（内核 schema 仅接受 1/7/30/90）。 */
export type AnalyticsRangeDays = 1 | 7 | 30 | 90;

export interface AnalyticsConfig {
  configured: boolean;
  reachable: boolean;
  database: string;
  tables: Record<string, boolean>;
}

/** 环比对象（渗透率 / bypass 率共用）。 */
export interface PctWithDelta {
  current_pct: number;
  previous_pct: number;
  delta_pp: number;
}

export interface SessionInitSummary {
  tool_call_rate: PctWithDelta;
  avg_calls: { current_avg: number; previous_avg: number; delta: number };
  bypass_rate: PctWithDelta & { bypass_sessions: number; non_bypass_sessions: number };
  distinct_init_sessions: number;
  total_bridge_calls: number;
}

/** session-init/timeseries 行：init / 有调用 / bypass 三线。 */
export interface SessionTrendRow {
  day: string;
  init_sessions: number;
  called_sessions: number;
  bypass_sessions: number;
}

export interface EndpointShareRow {
  executed_endpoint: string;
  calls: number;
  pct: number;
}

export interface TopBodyRow {
  executed_endpoint: string;
  request_body_hash: string;
  sample_body: string;
  occurrences: number;
  pct: number;
}

export interface BypassReasonRow {
  bypass_reason: string;
  sessions: number;
  pct: number;
}

/** tool-calls/list 单条调用明细（trace 视图与成员聚合共用）。 */
export interface ToolCallRow {
  timestamp: string;
  session_key: string;
  turn_seq: number;
  user_id: string;
  agent_source: string;
  kind: string;
  bridge_source: string;
  initiated_tool: string;
  executed_endpoint: string;
  request_body: string;
  request_body_hash: string;
  upstream_status: number;
  elapsed_ms: number;
  reject_reason: string;
}

export interface ToolCallListResult {
  total: number;
  offset: number;
  limit: number;
  items: ToolCallRow[];
}

/** tool-calls/list 过滤条件（内核支持的四个维度）。 */
export interface ToolCallListQuery extends AnalyticsQueryBody {
  kind?: 'bridge_call' | 'model_intent';
  user_id?: string;
  bridge_source?: string;
  /** 模糊匹配（内核用 LIKE %value%）。 */
  executed_endpoint?: string;
  offset?: number;
  limit?: number;
}

/** 面板侧聚合时单次拉取的页大小（内核 schema 上限 200）。 */
export const TOOL_CALL_PAGE_MAX = 200;

// ── usage（成本视角：token / credit / 模型分布）──────────────────────────

/**
 * usage/summary 聚合。
 *
 * ⚠️ `cache_hit_rate` 在内核 SQL 中是 `sum(cache_hit_tokens)*100/nullIf(sum(prompt_tokens),0)`,
 * prompt_tokens 总和为 0 时返回 **null**（无法计算），与「命中率 0%」语义不同，
 * 因此这里保留 null 而不归一为 0。同理：无数据时内核返回 `{}`，各字段为 undefined。
 */
export interface UsageSummary {
  total_requests: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_tokens: number;
  total_cache_hit_tokens: number;
  /** null = 无 prompt token，无法计算 */
  cache_hit_rate: number | null;
  total_credit: number;
  total_credit_saved: number;
  total_compress_tokens_saved: number;
  distinct_sessions: number;
  distinct_users: number;
  distinct_models: number;
}

export interface UsageTrendRow {
  day: string;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  cache_hit_tokens: number;
  credit: number;
  credit_saved: number;
}

export interface UsageModelRow {
  model_id: string;
  model_name: string;
  requests: number;
  total_tokens: number;
  credit: number;
  /** null = 全局请求数为 0，无法计算占比 */
  pct_requests: number | null;
  /** null = 全局 credit 为 0，无法计算占比 */
  pct_credit: number | null;
  /** 由其他模型路由到该模型的请求数（routed_from 非空）。 */
  routed_to_count: number;
}

export interface UsageLogRow {
  timestamp: string;
  session_key: string;
  turn_seq: number;
  model_id: string;
  model_name: string;
  user_id: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_hit_tokens: number;
  credit: number;
  credit_saved: number;
  /** 非空表示该请求由此模型路由而来。 */
  routed_from: string;
  stream: boolean;
}

/** usage_raw 异常上报原因（内核 zod 枚举，传其他值会 400）。 */
export const USAGE_RAW_REASONS = [
  'non_tokenhub',
  'unknown_model',
  'invalid_format',
  'invalid_credit',
  'report_failed',
] as const;

export type UsageRawReason = (typeof USAGE_RAW_REASONS)[number];

export interface UsageRawRow {
  timestamp: string;
  model_id: string;
  key_id: string;
  user_id: string;
  session_key: string;
  /** 原始上报载荷（字符串或 JSON 文本）。 */
  usage: string;
  reason: string;
  space_id: string;
}

export interface UsageListQuery extends AnalyticsQueryBody {
  user_id?: string;
  model_id?: string;
  offset?: number;
  limit?: number;
}

export interface UsageRawListQuery extends AnalyticsQueryBody {
  reason?: UsageRawReason;
  offset?: number;
  limit?: number;
}

export interface PagedResult<T> {
  total: number;
  offset: number;
  limit: number;
  items: T[];
}

/** 面板请求统一时间窗 body。 */
export interface AnalyticsQueryBody {
  days?: AnalyticsRangeDays;
  space_id?: string;
}

const EMPTY_MESSAGE = 'empty analytics response';

function sessionHeaders(): Record<string, string> {
  const session = getPanelSession();
  if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
  return {
    'X-Tdai-Service-Id': session.instanceId,
    'X-Tdai-User-Key': session.userKey,
  };
}

/**
 * 调用 analytics action 并解包信封。
 *
 * body 仅在 POST 时传入（GET action 传 undefined，request 不会附加 body —— 内核
 * config / spaces 声明为 GET，带 body 会被代理层判为 method 不符）。
 * content-type 由 request() 在有 body 时自动设置，此处不重复设置。
 */
async function call<T>(
  method: 'GET' | 'POST',
  action: string,
  body?: unknown,
): Promise<T> {
  const dedupeKey = `analytics:${method}:${action}:${body === undefined ? '' : JSON.stringify(body)}`;
  return dedupeInFlight(dedupeKey, async () => {
    const envelope = await request<MetaEnvelope<T>>(
      method,
      `/api/v1/analytics/${action}`,
      body,
      sessionHeaders(),
    );
    return unwrapEnvelope(envelope, EMPTY_MESSAGE);
  });
}

/** CH 数值列经 HTTP JSON 后可能是字符串（UInt64），统一归一为 number。 */
const toNumber = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const toText = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/**
 * 保留 null 语义的数值归一。
 *
 * 内核 SQL 里用 `nullIf(divisor, 0)` 的比率列（cache_hit_rate / pct_requests /
 * pct_credit）在分母为 0 时返回 null——表示「无法计算」，与「等于 0」不同。
 * 这里必须保留 null，交由 UI 显示占位符，不能悄悄变成 0 造成误读。
 */
const toNullableNumber = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** CH 的布尔列可能是 0/1、'0'/'1' 或 true/false。 */
const toBool = (v: unknown): boolean => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v !== '' && v !== '0' && v.toLowerCase() !== 'false';
  return false;
};

export const analyticsApi = {
  /** 内核 CH 配置状态探测（GET）。 */
  config: (): Promise<AnalyticsConfig> => call('GET', 'config'),

  // 注：不提供 spaces（/analytics/spaces 全量 space_id 列表）——该接口返回共享
  // CH 中全部实例的 space_id，与可观测页「按登录实例隔离」的数据面语义相悖，
  // 页面 Space 固定为 auth.instance_id，不再消费该端点。

  sessionSummary: (body: AnalyticsQueryBody): Promise<SessionInitSummary> =>
    call('POST', 'session-init/summary', body),

  sessionTimeseries: async (body: AnalyticsQueryBody): Promise<SessionTrendRow[]> => {
    const data = await call<{ series: Array<Record<string, unknown>> }>(
      'POST',
      'session-init/timeseries',
      body,
    );
    return (data.series ?? []).map((r) => ({
      day: toText(r.day),
      init_sessions: toNumber(r.init_sessions),
      called_sessions: toNumber(r.called_sessions),
      bypass_sessions: toNumber(r.bypass_sessions),
    }));
  },

  endpointShare: async (body: AnalyticsQueryBody): Promise<EndpointShareRow[]> => {
    const data = await call<{ endpoints: Array<Record<string, unknown>> }>(
      'POST',
      'tool-calls/endpoint-share',
      body,
    );
    return (data.endpoints ?? []).map((r) => ({
      executed_endpoint: toText(r.executed_endpoint),
      calls: toNumber(r.calls),
      pct: toNumber(r.pct),
    }));
  },

  topBodies: async (body: AnalyticsQueryBody & { top_n?: number }): Promise<TopBodyRow[]> => {
    const data = await call<{ items: Array<Record<string, unknown>> }>(
      'POST',
      'tool-calls/top-bodies',
      body,
    );
    return (data.items ?? []).map((r) => ({
      executed_endpoint: toText(r.executed_endpoint),
      request_body_hash: toText(r.request_body_hash),
      sample_body: toText(r.sample_body),
      occurrences: toNumber(r.occurrences),
      pct: toNumber(r.pct),
    }));
  },

  bypassReasons: async (body: AnalyticsQueryBody): Promise<BypassReasonRow[]> => {
    const data = await call<{ reasons: Array<Record<string, unknown>> }>(
      'POST',
      'session-init/bypass-reasons',
      body,
    );
    return (data.reasons ?? []).map((r) => ({
      bypass_reason: toText(r.bypass_reason),
      sessions: toNumber(r.sessions),
      pct: toNumber(r.pct),
    }));
  },

  /** 工具调用明细（trace 视图）。内核 ORDER BY timestamp DESC。 */
  toolCallList: async (query: ToolCallListQuery): Promise<ToolCallListResult> => {
    const data = await call<{
      total: number;
      offset: number;
      limit: number;
      items: Array<Record<string, unknown>>;
    }>('POST', 'tool-calls/list', query);
    return {
      total: toNumber(data.total),
      offset: toNumber(data.offset),
      limit: toNumber(data.limit),
      items: (data.items ?? []).map((r) => ({
        timestamp: toText(r.timestamp),
        session_key: toText(r.session_key),
        turn_seq: toNumber(r.turn_seq),
        user_id: toText(r.user_id),
        agent_source: toText(r.agent_source),
        kind: toText(r.kind),
        bridge_source: toText(r.bridge_source),
        initiated_tool: toText(r.initiated_tool),
        executed_endpoint: toText(r.executed_endpoint),
        request_body: toText(r.request_body),
        request_body_hash: toText(r.request_body_hash),
        upstream_status: toNumber(r.upstream_status),
        elapsed_ms: toNumber(r.elapsed_ms),
        reject_reason: toText(r.reject_reason),
      })),
    };
  },

  /**
   * 连续拉取多页调用明细，供面板侧按成员聚合。
   *
   * 内核未提供「按 user 聚合」的展示接口（watermark 是给 recall 增量链路用的，
   * 结构不适合展示），且本期不改 Core，故只能在面板侧聚合。
   *
   * ⚠️ 这是**抽样**而非全量：单页上限 200，最多取 maxPages 页。调用方必须把
   * 返回的 sampled/total 透出到 UI，不能把抽样结果当全量口径展示。
   */
  toolCallSample: async (
    body: AnalyticsQueryBody,
    maxPages: number,
  ): Promise<{ rows: ToolCallRow[]; total: number; truncated: boolean }> => {
    const rows: ToolCallRow[] = [];
    let total = 0;
    let truncated = false;

    for (let page = 0; page < maxPages; page++) {
      const offset = page * TOOL_CALL_PAGE_MAX;
      const res = await analyticsApi.toolCallList({
        ...body,
        kind: 'bridge_call',
        offset,
        limit: TOOL_CALL_PAGE_MAX,
      });
      total = res.total;
      rows.push(...res.items);

      if (res.items.length < TOOL_CALL_PAGE_MAX || rows.length >= total) break;
      if (page === maxPages - 1 && rows.length < total) truncated = true;
    }

    return { rows, total, truncated };
  },

  // ── usage（成本视角）────────────────────────────────────────────────

  /** token / credit 总量聚合。无数据时内核返回 {}，此处归一为全 0 + 比率 null。 */
  usageSummary: async (body: AnalyticsQueryBody): Promise<UsageSummary> => {
    const d = await call<Record<string, unknown>>('POST', 'usage/summary', body);
    return {
      total_requests: toNumber(d.total_requests),
      total_prompt_tokens: toNumber(d.total_prompt_tokens),
      total_completion_tokens: toNumber(d.total_completion_tokens),
      total_tokens: toNumber(d.total_tokens),
      total_cache_hit_tokens: toNumber(d.total_cache_hit_tokens),
      cache_hit_rate: toNullableNumber(d.cache_hit_rate),
      total_credit: toNumber(d.total_credit),
      total_credit_saved: toNumber(d.total_credit_saved),
      total_compress_tokens_saved: toNumber(d.total_compress_tokens_saved),
      distinct_sessions: toNumber(d.distinct_sessions),
      distinct_users: toNumber(d.distinct_users),
      distinct_models: toNumber(d.distinct_models),
    };
  },

  usageTimeseries: async (body: AnalyticsQueryBody): Promise<UsageTrendRow[]> => {
    const d = await call<{ series: Array<Record<string, unknown>> }>(
      'POST',
      'usage/timeseries',
      body,
    );
    return (d.series ?? []).map((r) => ({
      day: toText(r.day),
      requests: toNumber(r.requests),
      prompt_tokens: toNumber(r.prompt_tokens),
      completion_tokens: toNumber(r.completion_tokens),
      cache_hit_tokens: toNumber(r.cache_hit_tokens),
      credit: toNumber(r.credit),
      credit_saved: toNumber(r.credit_saved),
    }));
  },

  usageByModel: async (body: AnalyticsQueryBody): Promise<UsageModelRow[]> => {
    const d = await call<{ models: Array<Record<string, unknown>> }>(
      'POST',
      'usage/by-model',
      body,
    );
    return (d.models ?? []).map((r) => ({
      model_id: toText(r.model_id),
      model_name: toText(r.model_name),
      requests: toNumber(r.requests),
      total_tokens: toNumber(r.total_tokens),
      credit: toNumber(r.credit),
      pct_requests: toNullableNumber(r.pct_requests),
      pct_credit: toNullableNumber(r.pct_credit),
      routed_to_count: toNumber(r.routed_to_count),
    }));
  },

  /** 单次请求级用量明细（支持 user_id / model_id 过滤）。 */
  usageList: async (query: UsageListQuery): Promise<PagedResult<UsageLogRow>> => {
    const d = await call<{
      total: number;
      offset: number;
      limit: number;
      items: Array<Record<string, unknown>>;
    }>('POST', 'usage/list', query);
    return {
      total: toNumber(d.total),
      offset: toNumber(d.offset),
      limit: toNumber(d.limit),
      items: (d.items ?? []).map((r) => ({
        timestamp: toText(r.timestamp),
        session_key: toText(r.session_key),
        turn_seq: toNumber(r.turn_seq),
        model_id: toText(r.model_id),
        model_name: toText(r.model_name),
        user_id: toText(r.user_id),
        prompt_tokens: toNumber(r.prompt_tokens),
        completion_tokens: toNumber(r.completion_tokens),
        total_tokens: toNumber(r.total_tokens),
        cache_hit_tokens: toNumber(r.cache_hit_tokens),
        credit: toNumber(r.credit),
        credit_saved: toNumber(r.credit_saved),
        routed_from: toText(r.routed_from),
        stream: toBool(r.stream),
      })),
    };
  },

  /**
   * 计费异常上报明细（usage_raw）。
   *
   * reason 必须取自 USAGE_RAW_REASONS —— 内核用 zod enum 校验，传其他值直接 400。
   */
  usageRawList: async (query: UsageRawListQuery): Promise<PagedResult<UsageRawRow>> => {
    const d = await call<{
      total: number;
      offset: number;
      limit: number;
      items: Array<Record<string, unknown>>;
    }>('POST', 'usage-raw/list', query);
    return {
      total: toNumber(d.total),
      offset: toNumber(d.offset),
      limit: toNumber(d.limit),
      items: (d.items ?? []).map((r) => ({
        timestamp: toText(r.timestamp),
        model_id: toText(r.model_id),
        key_id: toText(r.key_id),
        user_id: toText(r.user_id),
        session_key: toText(r.session_key),
        usage: toText(r.usage),
        reason: toText(r.reason),
        space_id: toText(r.space_id),
      })),
    };
  },
};

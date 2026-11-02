/**
 * Parameterized SQL builders for all 16 analytics endpoints.
 *
 * Design principles:
 * - Pure functions: no CH client dependency, fully unit-testable
 * - All user values go through ClickHouse typed parameters ({name:Type})
 * - Column references are string constants, never user input
 * - Returns { query, query_params } for the CH client
 */

import type { TimeWindowParams, PaginationParams } from "./analytics-schemas.js";

export interface SqlResult {
  query: string;
  query_params: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface TimeRange {
  clause: string;
  params: Record<string, unknown>;
}

function resolveTimeRange(p: TimeWindowParams, tableAlias = ""): TimeRange {
  const prefix = tableAlias ? `${tableAlias}.` : "";
  if (p.from) {
    const params: Record<string, unknown> = { time_from: p.from };
    let clause = `${prefix}timestamp >= parseDateTime64BestEffort({time_from:String})`;
    if (p.to) {
      clause += ` AND ${prefix}timestamp <= parseDateTime64BestEffort({time_to:String})`;
      params.time_to = p.to;
    }
    return { clause, params };
  }
  return {
    clause: `${prefix}timestamp >= now() - INTERVAL {days:UInt32} DAY`,
    params: { days: p.days ?? 7 },
  };
}

function spaceFilter(p: { space_id?: string }, tableAlias = ""): { clause: string; params: Record<string, unknown> } {
  if (!p.space_id) return { clause: "", params: {} };
  const prefix = tableAlias ? `${tableAlias}.` : "";
  return {
    clause: `AND ${prefix}space_id = {space_id:String}`,
    params: { space_id: p.space_id },
  };
}

function and(...parts: string[]): string {
  return parts.filter(Boolean).join("\n  ");
}

// ---------------------------------------------------------------------------
// Session-init
// ---------------------------------------------------------------------------

export function buildSessionInitSummary(p: TimeWindowParams): SqlResult {
  const time = resolveTimeRange(p);
  const space = spaceFilter(p);
  const query = `
WITH
  {days:UInt32} AS window_days,
  init_sessions AS (
    SELECT DISTINCT session_key
    FROM session_init_logs
    WHERE ${time.clause}
    ${space.clause}
  ),
  bridge_calls AS (
    SELECT session_key
    FROM tool_call_logs
    WHERE ${time.clause}
    ${space.clause}
      AND kind = 'bridge_call'
      AND session_key IN (SELECT session_key FROM init_sessions)
  ),
  prev_init_sessions AS (
    SELECT DISTINCT session_key
    FROM session_init_logs
    WHERE timestamp >= now() - INTERVAL {days:UInt32} * 2 DAY
      AND timestamp < now() - INTERVAL {days:UInt32} DAY
    ${space.clause}
  ),
  prev_bridge_calls AS (
    SELECT session_key
    FROM tool_call_logs
    WHERE timestamp >= now() - INTERVAL {days:UInt32} * 2 DAY
      AND timestamp < now() - INTERVAL {days:UInt32} DAY
    ${space.clause}
      AND kind = 'bridge_call'
      AND session_key IN (SELECT session_key FROM prev_init_sessions)
  )
SELECT
  -- tool_call_rate
  round((SELECT count() FROM (SELECT DISTINCT session_key FROM bridge_calls)) * 100.0
    / nullIf((SELECT count() FROM init_sessions), 0), 2) AS current_tool_call_rate_pct,
  round((SELECT count() FROM (SELECT DISTINCT session_key FROM prev_bridge_calls)) * 100.0
    / nullIf((SELECT count() FROM prev_init_sessions), 0), 2) AS previous_tool_call_rate_pct,
  -- avg_calls
  round((SELECT count() FROM bridge_calls) * 1.0
    / nullIf((SELECT count() FROM init_sessions), 0), 2) AS current_avg_calls,
  round((SELECT count() FROM prev_bridge_calls) * 1.0
    / nullIf((SELECT count() FROM prev_init_sessions), 0), 2) AS previous_avg_calls,
  -- bypass_rate
  (SELECT round(countIf(bypassed=1) * 100.0 / nullIf(count(), 0), 2)
   FROM session_init_logs WHERE ${time.clause} ${space.clause}) AS current_bypass_pct,
  (SELECT round(countIf(bypassed=1) * 100.0 / nullIf(count(), 0), 2)
   FROM session_init_logs
   WHERE timestamp >= now() - INTERVAL {days:UInt32} * 2 DAY
     AND timestamp < now() - INTERVAL {days:UInt32} DAY ${space.clause}) AS previous_bypass_pct,
  (SELECT countIf(bypassed=1) FROM session_init_logs WHERE ${time.clause} ${space.clause}) AS bypass_sessions,
  (SELECT countIf(bypassed=0) FROM session_init_logs WHERE ${time.clause} ${space.clause}) AS non_bypass_sessions,
  -- distinct_init_sessions
  (SELECT count() FROM init_sessions) AS distinct_init_sessions,
  -- total_bridge_calls
  (SELECT count() FROM bridge_calls) AS total_bridge_calls
`.trim();

  return { query, query_params: { ...time.params, ...space.params } };
}

export function buildSessionInitTimeseries(p: TimeWindowParams): SqlResult {
  const time = resolveTimeRange(p);
  const space = spaceFilter(p);
  // Two sub-queries merged by day (same pattern as dashboard server.py _serve_timeseries)
  const query = `
SELECT
  day,
  max(init_sessions) AS init_sessions,
  max(bypass_sessions) AS bypass_sessions,
  max(called_sessions) AS called_sessions
FROM (
  SELECT
    toDate(timestamp) AS day,
    count(DISTINCT session_key) AS init_sessions,
    countIf(bypassed = 1) AS bypass_sessions,
    0 AS called_sessions
  FROM session_init_logs
  WHERE ${time.clause} ${space.clause}
  GROUP BY day

  UNION ALL

  SELECT
    toDate(timestamp) AS day,
    0 AS init_sessions,
    0 AS bypass_sessions,
    count(DISTINCT session_key) AS called_sessions
  FROM tool_call_logs
  WHERE ${time.clause} ${space.clause}
    AND kind = 'bridge_call'
  GROUP BY day
)
GROUP BY day
ORDER BY day ASC
`.trim();

  return { query, query_params: { ...time.params, ...space.params } };
}

export function buildBypassReasons(p: TimeWindowParams): SqlResult {
  const time = resolveTimeRange(p);
  const space = spaceFilter(p);
  const query = `
SELECT
  bypass_reason,
  count() AS sessions,
  round(count() * 100.0 / sum(count()) OVER (), 2) AS pct
FROM session_init_logs
WHERE ${time.clause} ${space.clause}
  AND bypassed = 1
GROUP BY bypass_reason
ORDER BY sessions DESC
`.trim();

  return { query, query_params: { ...time.params, ...space.params } };
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

export function buildToolCallEndpointShare(p: TimeWindowParams): SqlResult {
  const time = resolveTimeRange(p);
  const space = spaceFilter(p);
  const query = `
SELECT
  executed_endpoint,
  count() AS calls,
  round(count() * 100.0 / sum(count()) OVER (), 2) AS pct
FROM tool_call_logs
WHERE ${time.clause} ${space.clause}
  AND kind = 'bridge_call'
  AND executed_endpoint != ''
GROUP BY executed_endpoint
ORDER BY calls DESC
`.trim();

  return { query, query_params: { ...time.params, ...space.params } };
}

export function buildToolCallTopBodies(p: TimeWindowParams & { top_n?: number }): SqlResult {
  const time = resolveTimeRange(p);
  const space = spaceFilter(p);
  const topN = p.top_n ?? 20;
  const query = `
SELECT
  executed_endpoint,
  request_body_hash,
  substringUTF8(any(request_body), 1, 200) AS sample_body,
  count() AS occurrences,
  round(count() * 100.0 / sum(count()) OVER (), 2) AS pct
FROM tool_call_logs
WHERE ${time.clause} ${space.clause}
  AND kind = 'bridge_call'
  AND executed_endpoint != ''
GROUP BY executed_endpoint, request_body_hash
ORDER BY occurrences DESC
LIMIT {top_n:UInt32}
`.trim();

  return { query, query_params: { ...time.params, ...space.params, top_n: topN } };
}

export function buildToolCallTimeseries(p: TimeWindowParams & { kind?: string }): SqlResult {
  const time = resolveTimeRange(p);
  const space = spaceFilter(p);
  const kindFilter = p.kind ? `AND kind = {kind:String}` : "";
  const kindParams = p.kind ? { kind: p.kind } : {};
  const query = `
SELECT
  toDate(timestamp) AS day,
  count() AS total_calls,
  count(DISTINCT session_key) AS distinct_sessions,
  count(DISTINCT user_id) AS distinct_users
FROM tool_call_logs
WHERE ${time.clause} ${space.clause}
  ${kindFilter}
GROUP BY day
ORDER BY day ASC
`.trim();

  return { query, query_params: { ...time.params, ...space.params, ...kindParams } };
}

function toolCallWhereClauses(
  p: TimeWindowParams & { kind?: string; user_id?: string; bridge_source?: string; executed_endpoint?: string },
): { clauses: string; params: Record<string, unknown> } {
  const time = resolveTimeRange(p);
  const space = spaceFilter(p);
  const parts = [time.clause, space.clause];
  const params: Record<string, unknown> = { ...time.params, ...space.params };

  if (p.kind) {
    parts.push(`AND kind = {kind:String}`);
    params.kind = p.kind;
  }
  if (p.user_id) {
    parts.push(`AND user_id = {user_id:String}`);
    params.user_id = p.user_id;
  }
  if (p.bridge_source) {
    parts.push(`AND bridge_source = {bridge_source:String}`);
    params.bridge_source = p.bridge_source;
  }
  if (p.executed_endpoint) {
    parts.push(`AND executed_endpoint LIKE {endpoint_pattern:String}`);
    params.endpoint_pattern = `%${p.executed_endpoint}%`;
  }
  return { clauses: and(...parts), params };
}

export function buildToolCallList(
  p: TimeWindowParams & PaginationParams & { kind?: string; user_id?: string; bridge_source?: string; executed_endpoint?: string },
): SqlResult {
  const { clauses, params } = toolCallWhereClauses(p);
  const query = `
SELECT
  timestamp, session_key, turn_seq, user_id, agent_source,
  kind, bridge_source, initiated_tool, executed_endpoint,
  request_body, request_body_hash, upstream_status, elapsed_ms, reject_reason
FROM tool_call_logs
WHERE ${clauses}
ORDER BY timestamp DESC
LIMIT {limit:UInt32} OFFSET {offset:UInt32}
`.trim();

  return { query, query_params: { ...params, limit: p.limit ?? 50, offset: p.offset ?? 0 } };
}

export function buildToolCallListCount(
  p: TimeWindowParams & { kind?: string; user_id?: string; bridge_source?: string; executed_endpoint?: string },
): SqlResult {
  const { clauses, params } = toolCallWhereClauses(p);
  const query = `
SELECT count() AS total
FROM tool_call_logs
WHERE ${clauses}
`.trim();

  return { query, query_params: params };
}

export function buildWatermark(p: { data_cutoff?: string }): SqlResult {
  const cutoffClause = p.data_cutoff
    ? `AND timestamp >= parseDateTime64BestEffort({data_cutoff:String})`
    : "";
  const cutoffParams = p.data_cutoff ? { data_cutoff: p.data_cutoff } : {};
  const query = `
SELECT
  user_id,
  count() AS call_count,
  max(timestamp) AS max_timestamp,
  max(request_body_hash) AS max_request_hash
FROM tool_call_logs
WHERE kind = 'bridge_call'
  AND executed_endpoint != ''
  ${cutoffClause}
GROUP BY user_id
SETTINGS max_threads = 1, max_execution_time = 5
`.trim();

  return { query, query_params: cutoffParams };
}

export function buildDetailFetch(p: {
  data_cutoff?: string;
  users: Array<{ user_id: string; window_from?: string; window_to?: string }>;
  lookback_days?: number;
}): SqlResult {
  const lookback = p.lookback_days ?? 30;
  const params: Record<string, unknown> = {};
  const cutoffClause = p.data_cutoff
    ? `AND timestamp >= parseDateTime64BestEffort({data_cutoff:String})`
    : "";
  if (p.data_cutoff) params.data_cutoff = p.data_cutoff;

  const userConditions = p.users.map((u, i) => {
    const userParam = `user_${i}`;
    params[userParam] = u.user_id;
    let cond = `user_id = {${userParam}:String}`;
    if (u.window_from) {
      const fromParam = `from_${i}`;
      params[fromParam] = u.window_from;
      cond += ` AND timestamp >= parseDateTime64BestEffort({${fromParam}:String})`;
    } else {
      cond += ` AND timestamp > now() - INTERVAL ${lookback} DAY`;
    }
    if (u.window_to) {
      const toParam = `to_${i}`;
      params[toParam] = u.window_to;
      cond += ` AND timestamp <= parseDateTime64BestEffort({${toParam}:String})`;
    }
    return `(${cond})`;
  });

  const query = `
SELECT
  timestamp, session_key, turn_seq, user_id, agent_source,
  bridge_source, initiated_tool, executed_endpoint,
  request_body, request_body_hash, upstream_status, elapsed_ms, source_tag
FROM tool_call_logs
WHERE kind = 'bridge_call'
  AND executed_endpoint != ''
  ${cutoffClause}
  AND (${userConditions.join(" OR ")})
ORDER BY timestamp ASC, session_key ASC, turn_seq ASC, request_body_hash ASC
SETTINGS max_threads = 2, max_execution_time = 60
`.trim();

  return { query, query_params: params };
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export function buildUsageSummary(p: TimeWindowParams): SqlResult {
  const time = resolveTimeRange(p);
  const space = spaceFilter(p);
  const query = `
SELECT
  count() AS total_requests,
  sum(prompt_tokens) AS total_prompt_tokens,
  sum(completion_tokens) AS total_completion_tokens,
  sum(total_tokens) AS total_tokens,
  sum(cache_hit_tokens) AS total_cache_hit_tokens,
  round(sum(cache_hit_tokens) * 100.0 / nullIf(sum(prompt_tokens), 0), 2) AS cache_hit_rate,
  round(sum(credit), 2) AS total_credit,
  round(sum(credit_saved), 2) AS total_credit_saved,
  sum(compress_tokens_saved) AS total_compress_tokens_saved,
  uniq(session_key) AS distinct_sessions,
  uniq(user_id) AS distinct_users,
  uniq(model_id) AS distinct_models
FROM usage_logs
WHERE ${time.clause} ${space.clause}
`.trim();

  return { query, query_params: { ...time.params, ...space.params } };
}

export function buildUsageTimeseries(p: TimeWindowParams): SqlResult {
  const time = resolveTimeRange(p);
  const space = spaceFilter(p);
  const query = `
SELECT
  toDate(timestamp) AS day,
  count() AS requests,
  sum(prompt_tokens) AS prompt_tokens,
  sum(completion_tokens) AS completion_tokens,
  sum(cache_hit_tokens) AS cache_hit_tokens,
  round(sum(credit), 2) AS credit,
  round(sum(credit_saved), 2) AS credit_saved
FROM usage_logs
WHERE ${time.clause} ${space.clause}
GROUP BY day
ORDER BY day ASC
`.trim();

  return { query, query_params: { ...time.params, ...space.params } };
}

export function buildUsageByModel(p: TimeWindowParams): SqlResult {
  const time = resolveTimeRange(p);
  const space = spaceFilter(p);
  // CROSS JOIN approach avoids CH's "aggregate inside aggregate" error
  // that occurs with scalar subqueries referencing the same table in GROUP BY context.
  const query = `
SELECT
  t.model_id AS model_id,
  t.model_name AS model_name,
  t.requests AS requests,
  t.total_tokens AS total_tokens,
  t.credit AS credit,
  round(t.requests * 100.0 / nullIf(g.total_reqs, 0), 2) AS pct_requests,
  round(t.credit * 100.0 / nullIf(g.total_credit, 0), 2) AS pct_credit,
  t.routed_to_count AS routed_to_count
FROM (
  SELECT
    model_id,
    any(model_name) AS model_name,
    count() AS requests,
    sum(total_tokens) AS total_tokens,
    round(sum(credit), 2) AS credit,
    countIf(routed_from != '') AS routed_to_count
  FROM usage_logs
  WHERE ${time.clause} ${space.clause}
  GROUP BY model_id
) AS t
CROSS JOIN (
  SELECT count() AS total_reqs, sum(credit) AS total_credit
  FROM usage_logs
  WHERE ${time.clause} ${space.clause}
) AS g
ORDER BY t.credit DESC
`.trim();

  return { query, query_params: { ...time.params, ...space.params } };
}

function usageWhereClauses(
  p: TimeWindowParams & { user_id?: string; model_id?: string },
): { clauses: string; params: Record<string, unknown> } {
  const time = resolveTimeRange(p);
  const space = spaceFilter(p);
  const parts = [time.clause, space.clause];
  const params: Record<string, unknown> = { ...time.params, ...space.params };
  if (p.user_id) {
    parts.push(`AND user_id = {user_id:String}`);
    params.user_id = p.user_id;
  }
  if (p.model_id) {
    parts.push(`AND model_id = {model_id:String}`);
    params.model_id = p.model_id;
  }
  return { clauses: and(...parts), params };
}

export function buildUsageList(
  p: TimeWindowParams & PaginationParams & { user_id?: string; model_id?: string },
): SqlResult {
  const { clauses, params } = usageWhereClauses(p);
  const query = `
SELECT
  timestamp, session_key, turn_seq, model_id, model_name, user_id,
  prompt_tokens, completion_tokens, total_tokens, cache_hit_tokens,
  credit, credit_saved, routed_from, stream
FROM usage_logs
WHERE ${clauses}
ORDER BY timestamp DESC
LIMIT {limit:UInt32} OFFSET {offset:UInt32}
`.trim();

  return { query, query_params: { ...params, limit: p.limit ?? 50, offset: p.offset ?? 0 } };
}

export function buildUsageListCount(
  p: TimeWindowParams & { user_id?: string; model_id?: string },
): SqlResult {
  const { clauses, params } = usageWhereClauses(p);
  const query = `
SELECT count() AS total
FROM usage_logs
WHERE ${clauses}
`.trim();

  return { query, query_params: params };
}

// ---------------------------------------------------------------------------
// Usage raw
// ---------------------------------------------------------------------------

function usageRawWhereClauses(
  p: TimeWindowParams & { reason?: string },
): { clauses: string; params: Record<string, unknown> } {
  const time = resolveTimeRange(p);
  const space = spaceFilter(p);
  const parts = [time.clause, space.clause];
  const params: Record<string, unknown> = { ...time.params, ...space.params };
  if (p.reason) {
    parts.push(`AND reason = {reason:String}`);
    params.reason = p.reason;
  }
  return { clauses: and(...parts), params };
}

export function buildUsageRawList(
  p: TimeWindowParams & PaginationParams & { reason?: string },
): SqlResult {
  const { clauses, params } = usageRawWhereClauses(p);
  const query = `
SELECT
  timestamp, model_id, key_id, user_id, session_key,
  usage, reason, space_id
FROM usage_raw
WHERE ${clauses}
ORDER BY timestamp DESC
LIMIT {limit:UInt32} OFFSET {offset:UInt32}
`.trim();

  return { query, query_params: { ...params, limit: p.limit ?? 50, offset: p.offset ?? 0 } };
}

export function buildUsageRawListCount(
  p: TimeWindowParams & { reason?: string },
): SqlResult {
  const { clauses, params } = usageRawWhereClauses(p);
  const query = `
SELECT count() AS total
FROM usage_raw
WHERE ${clauses}
`.trim();

  return { query, query_params: params };
}

// ---------------------------------------------------------------------------
// Spaces
// ---------------------------------------------------------------------------

export function buildListSpaces(): SqlResult {
  return {
    query: `
SELECT DISTINCT space_id
FROM session_init_logs
WHERE timestamp >= now() - INTERVAL 30 DAY AND space_id != ''
ORDER BY space_id
`.trim(),
    query_params: {},
  };
}

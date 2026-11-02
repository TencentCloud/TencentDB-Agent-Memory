/**
 * Knowledge analytics routes (/v3/analytics/*, 5 endpoints).
 *
 * Queries tool_call_logs (source_tag='knowledge') from the same CH
 * that KnowledgeTelemetry writes to. Uses raw fetch (no @clickhouse/client).
 *
 * Auth: x-tdai-service-id required (same trust model as other Knowledge routes).
 * CH config fully reused from KNOWLEDGE_CLICKHOUSE_* — zero additional config.
 */

import { Hono } from "hono";
import type { ClickHouseTelemetryConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AnalyticsConfig {
  clickhouse: ClickHouseTelemetryConfig;
}

interface TimeWindow {
  days?: number;
  from?: string;
  to?: string;
  space_id?: string;
}

// ---------------------------------------------------------------------------
// CH query helper (raw fetch, same pattern as clickhouse-telemetry.ts)
// ---------------------------------------------------------------------------

async function chQuery<T = Record<string, unknown>>(
  config: ClickHouseTelemetryConfig,
  sql: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<T[]> {
  const url = new URL(config.url);
  url.searchParams.set("database", config.database);
  const headers: Record<string, string> = {
    "content-type": "text/plain; charset=utf-8",
  };
  if (config.user) headers["x-clickhouse-user"] = config.user;
  if (config.password) headers["x-clickhouse-key"] = config.password;

  // Append FORMAT JSON to get structured response
  const fullSql = sql.trimEnd().endsWith("FORMAT JSON") ? sql : `${sql}\nFORMAT JSON`;

  const response = await fetchImpl(url, {
    method: "POST",
    headers,
    body: fullSql,
    signal: AbortSignal.timeout(config.requestTimeoutMs || 30_000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`CH query failed: HTTP ${response.status} — ${detail.slice(0, 200)}`);
  }

  const payload = await response.json() as { data?: T[] };
  return payload.data ?? [];
}

async function chPing(config: ClickHouseTelemetryConfig, fetchImpl: typeof fetch = globalThis.fetch): Promise<boolean> {
  try {
    const url = new URL(config.url);
    url.searchParams.set("query", "SELECT 1");
    const headers: Record<string, string> = {};
    if (config.user) headers["x-clickhouse-user"] = config.user;
    if (config.password) headers["x-clickhouse-key"] = config.password;
    const resp = await fetchImpl(url, { method: "GET", headers, signal: AbortSignal.timeout(5000) });
    return resp.ok;
  } catch {
    return false;
  }
}

async function chTableExists(
  config: ClickHouseTelemetryConfig,
  table: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  try {
    const rows = await chQuery<{ result: number }>(config, `EXISTS TABLE ${table}`, fetchImpl);
    return rows.length > 0 && rows[0].result === 1;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

function safeStr(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function timeClause(p: TimeWindow): string {
  if (p.from) {
    let clause = `timestamp >= parseDateTime64BestEffort('${safeStr(p.from)}')`;
    if (p.to) clause += ` AND timestamp <= parseDateTime64BestEffort('${safeStr(p.to)}')`;
    return clause;
  }
  const days = [1, 7, 30, 90].includes(p.days ?? 7) ? (p.days ?? 7) : 7;
  return `timestamp >= now() - INTERVAL ${days} DAY`;
}

function spaceClause(p: TimeWindow): string {
  if (!p.space_id) return "";
  return `AND space_id = '${safeStr(p.space_id)}'`;
}

const TABLE = "tool_call_logs";
const BASE_WHERE = `kind = 'bridge_call' AND executed_endpoint != ''`;

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function ok(data: unknown) {
  return { code: 0, message: "ok", data };
}

function err(code: number, message: string) {
  return { code, message, data: null };
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createAnalyticsRoutes(
  analyticsConfig: AnalyticsConfig,
  fetchImpl?: typeof fetch,
): Hono {
  const router = new Hono();
  const chConfig = analyticsConfig.clickhouse;
  const doFetch = fetchImpl ?? globalThis.fetch;
  const chEnabled = chConfig.enabled && !!chConfig.url;

  // ── Auth middleware — same trust model as other Knowledge routes ──
  router.use("/*", async (c, next) => {
    const serviceId = c.req.header("x-tdai-service-id");
    if (!serviceId?.trim()) {
      return c.json(err(401, "Missing x-tdai-service-id header"), 401);
    }
    await next();
  });

  // ── GET /config ──
  router.get("/config", async (c) => {
    if (!chEnabled) {
      return c.json(ok({ configured: false, reachable: false, database: "", tables: {} }));
    }
    const [reachable, tableExists] = await Promise.all([
      chPing(chConfig, doFetch),
      chTableExists(chConfig, TABLE, doFetch),
    ]);
    return c.json(ok({
      configured: true,
      reachable,
      database: chConfig.database,
      tables: { [TABLE]: tableExists },
    }));
  });

  // ── CH-required guard for remaining routes ──
  function requireCh(): boolean {
    return chEnabled;
  }

  // ── POST /tool-calls/summary ──
  router.post("/tool-calls/summary", async (c) => {
    if (!requireCh()) return c.json(err(50301, "ClickHouse not configured"), 503);
    const body = await c.req.json().catch(() => ({})) as TimeWindow;
    const tc = timeClause(body);
    const sc = spaceClause(body);

    const sql = `
SELECT
  count() AS total_calls,
  uniq(session_key) AS distinct_sessions,
  uniq(user_id) AS distinct_users,
  round(avg(elapsed_ms), 0) AS avg_elapsed_ms,
  quantile(0.95)(elapsed_ms) AS p95_elapsed_ms,
  round(countIf(upstream_status >= 400) * 100.0 / nullIf(count(), 0), 2) AS error_rate
FROM ${TABLE}
WHERE ${BASE_WHERE} AND ${tc} ${sc}
`;
    const rows = await chQuery(chConfig, sql, doFetch);
    return c.json(ok(rows[0] ?? {}));
  });

  // ── POST /tool-calls/endpoint-share ──
  router.post("/tool-calls/endpoint-share", async (c) => {
    if (!requireCh()) return c.json(err(50301, "ClickHouse not configured"), 503);
    const body = await c.req.json().catch(() => ({})) as TimeWindow;
    const tc = timeClause(body);
    const sc = spaceClause(body);

    const sql = `
SELECT
  executed_endpoint,
  count() AS calls,
  round(count() * 100.0 / sum(count()) OVER (), 2) AS pct
FROM ${TABLE}
WHERE ${BASE_WHERE} AND ${tc} ${sc}
GROUP BY executed_endpoint
ORDER BY calls DESC
`;
    const rows = await chQuery(chConfig, sql, doFetch);
    return c.json(ok({ endpoints: rows }));
  });

  // ── POST /tool-calls/timeseries ──
  router.post("/tool-calls/timeseries", async (c) => {
    if (!requireCh()) return c.json(err(50301, "ClickHouse not configured"), 503);
    const body = await c.req.json().catch(() => ({})) as TimeWindow;
    const tc = timeClause(body);
    const sc = spaceClause(body);

    const sql = `
SELECT
  toDate(timestamp) AS day,
  count() AS total_calls,
  uniq(session_key) AS distinct_sessions,
  uniq(user_id) AS distinct_users,
  round(avg(elapsed_ms), 0) AS avg_elapsed_ms
FROM ${TABLE}
WHERE ${BASE_WHERE} AND ${tc} ${sc}
GROUP BY day
ORDER BY day ASC
`;
    const rows = await chQuery(chConfig, sql, doFetch);
    return c.json(ok({ series: rows }));
  });

  // ── POST /tool-calls/list ──
  router.post("/tool-calls/list", async (c) => {
    if (!requireCh()) return c.json(err(50301, "ClickHouse not configured"), 503);
    const body = await c.req.json().catch(() => ({})) as TimeWindow & {
      user_id?: string;
      executed_endpoint?: string;
      offset?: number;
      limit?: number;
    };
    const tc = timeClause(body);
    const sc = spaceClause(body);
    const offset = Math.max(0, body.offset ?? 0);
    const limit = Math.max(1, Math.min(200, body.limit ?? 50));
    let extraFilter = "";
    if (body.user_id) extraFilter += ` AND user_id = '${safeStr(body.user_id)}'`;
    if (body.executed_endpoint) extraFilter += ` AND executed_endpoint LIKE '%${safeStr(body.executed_endpoint)}%'`;

    const countSql = `SELECT count() AS total FROM ${TABLE} WHERE ${BASE_WHERE} AND ${tc} ${sc} ${extraFilter}`;
    const dataSql = `
SELECT
  timestamp, session_key, turn_seq, user_id, agent_source,
  bridge_source, initiated_tool, executed_endpoint,
  request_body, request_body_hash, upstream_status, elapsed_ms
FROM ${TABLE}
WHERE ${BASE_WHERE} AND ${tc} ${sc} ${extraFilter}
ORDER BY timestamp DESC
LIMIT ${limit} OFFSET ${offset}
`;
    const [countRows, items] = await Promise.all([
      chQuery<{ total: number }>(chConfig, countSql, doFetch),
      chQuery(chConfig, dataSql, doFetch),
    ]);

    return c.json(ok({
      total: Number(countRows[0]?.total ?? 0),
      offset,
      limit,
      items,
    }));
  });

  return router;
}

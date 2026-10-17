/**
 * v3 analytics router (/v3/analytics/*, 16 endpoints).
 *
 * Dispatch pattern mirrors v3-meta-router: raw `req` access for three-layer auth.
 * - Layer 1 (Bearer): handled by server.ts checkAuthForV2 before reaching here
 * - Layer 2 (x-tdai-service-id): extractInstanceId
 * - Layer 3 (x-tdai-user-key): authenticateV3 + system_admin check
 *
 * All endpoints except /config require system_admin.
 * All endpoints except /config return 503 when CH is not configured.
 */

import type * as http from "node:http";
import {
  successEnvelope,
  errorEnvelope,
  resolveRequestId,
} from "../v2-router.js";
import type { ApiResponseEnvelope } from "../v2-schemas.js";
import { extractInstanceId } from "../../metadata/router/instance.js";
import {
  extractUserKeyHeader,
  authenticateV3,
  type V3AuthContext,
} from "../../metadata/router/auth.js";
import { MetadataError, type MetadataService } from "../../metadata/service/metadata-service.js";
import type { AnalyticsChClient } from "./analytics-ch-client.js";
import * as schemas from "./analytics-schemas.js";
import * as sql from "./analytics-sql.js";
import { formatZodError } from "../v2-schemas.js";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

type Logger = {
  debug?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

export const V3_ANALYTICS_PREFIX = "/v3/analytics";

export interface AnalyticsRouterDeps {
  getAnalyticsChClient: (instanceId: string) => AnalyticsChClient | null | Promise<AnalyticsChClient | null>;
  getMetadataService: (instanceId: string) => Promise<MetadataService | undefined>;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Internal handler type
// ---------------------------------------------------------------------------

type HandlerFn = (
  body: unknown,
  chClient: AnalyticsChClient,
  requestId: string,
) => Promise<unknown>;

interface RouteEntry {
  method: "GET" | "POST";
  handler: HandlerFn;
  /** When true, skip x-tdai-user-key auth (e.g. /config). */
  noUserKey?: boolean;
  /** When true, don't require CH client (e.g. /config). */
  noCh?: boolean;
}

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

const ANALYTICS_TABLES = ["usage_logs", "usage_raw", "session_init_logs", "tool_call_logs"] as const;

const routeTable: Record<string, RouteEntry> = {
  [`${V3_ANALYTICS_PREFIX}/config`]:                       { method: "GET",  handler: handleConfig,                noUserKey: true, noCh: true },
  [`${V3_ANALYTICS_PREFIX}/spaces`]:                       { method: "GET",  handler: handleSpaces },
  [`${V3_ANALYTICS_PREFIX}/session-init/summary`]:         { method: "POST", handler: handleSessionInitSummary },
  [`${V3_ANALYTICS_PREFIX}/session-init/timeseries`]:      { method: "POST", handler: handleSessionInitTimeseries },
  [`${V3_ANALYTICS_PREFIX}/session-init/bypass-reasons`]:  { method: "POST", handler: handleBypassReasons },
  [`${V3_ANALYTICS_PREFIX}/tool-calls/endpoint-share`]:    { method: "POST", handler: handleToolCallEndpointShare },
  [`${V3_ANALYTICS_PREFIX}/tool-calls/top-bodies`]:        { method: "POST", handler: handleToolCallTopBodies },
  [`${V3_ANALYTICS_PREFIX}/tool-calls/timeseries`]:        { method: "POST", handler: handleToolCallTimeseries },
  [`${V3_ANALYTICS_PREFIX}/tool-calls/list`]:              { method: "POST", handler: handleToolCallList },
  [`${V3_ANALYTICS_PREFIX}/tool-calls/watermark`]:         { method: "POST", handler: handleToolCallWatermark },
  [`${V3_ANALYTICS_PREFIX}/tool-calls/detail-fetch`]:      { method: "POST", handler: handleToolCallDetailFetch },
  [`${V3_ANALYTICS_PREFIX}/usage/summary`]:                { method: "POST", handler: handleUsageSummary },
  [`${V3_ANALYTICS_PREFIX}/usage/timeseries`]:             { method: "POST", handler: handleUsageTimeseries },
  [`${V3_ANALYTICS_PREFIX}/usage/by-model`]:               { method: "POST", handler: handleUsageByModel },
  [`${V3_ANALYTICS_PREFIX}/usage/list`]:                   { method: "POST", handler: handleUsageList },
  [`${V3_ANALYTICS_PREFIX}/usage-raw/list`]:               { method: "POST", handler: handleUsageRawList },
};

/** Exported for tests — all registered route paths. */
export const ANALYTICS_ROUTES = Object.keys(routeTable);

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function handleV3AnalyticsRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  parseJsonBody: <T>(req: http.IncomingMessage) => Promise<T>,
  sendJson: (res: http.ServerResponse, status: number, body: unknown) => void,
  deps: AnalyticsRouterDeps,
): Promise<boolean> {
  if (!pathname.startsWith(V3_ANALYTICS_PREFIX)) return false;

  const route = routeTable[pathname];
  if (!route) return false;
  if (method.toUpperCase() !== route.method) {
    sendJson(res, 405, errorEnvelope(405, `Method ${method} not allowed`, ""));
    return true;
  }

  const requestId = resolveRequestId(req.headers as Record<string, string | string[] | undefined>);

  // Layer 2: extract instance ID from x-tdai-service-id
  let instanceId: string;
  try {
    instanceId = extractInstanceId(req.headers);
  } catch (err) {
    if (err instanceof MetadataError) {
      sendJson(res, 400, errorEnvelope(400, `${err.code}: ${err.message}`, requestId));
      return true;
    }
    throw err;
  }

  // Layer 3: user-key auth (unless noUserKey)
  if (!route.noUserKey) {
    const svc = await deps.getMetadataService(instanceId);
    if (!svc) {
      sendJson(res, 503, errorEnvelope(503, "MetadataService not available", requestId));
      return true;
    }

    const userKey = extractUserKeyHeader(req.headers);
    if (!userKey) {
      sendJson(res, 401, errorEnvelope(401, "unauthorized: missing x-tdai-user-key", requestId));
      return true;
    }

    const authResult = await authenticateV3(userKey, svc);
    if (!authResult.ok || !authResult.ctx) {
      sendJson(res, authResult.status ?? 401, errorEnvelope(authResult.status ?? 401, `unauthorized: ${authResult.reason}`, requestId));
      return true;
    }

    // Must be system_admin to access analytics
    if (!authResult.ctx.isSystemAdmin) {
      sendJson(res, 403, errorEnvelope(403, "forbidden: analytics requires system_admin", requestId));
      return true;
    }
  }

  // Resolve CH client
  const chClient = await Promise.resolve(deps.getAnalyticsChClient(instanceId));
  if (!chClient && !route.noCh) {
    sendJson(res, 503, errorEnvelope(50301, "ClickHouse analytics not configured", requestId));
    return true;
  }

  // Parse body (POST) or use empty object (GET)
  let body: unknown = {};
  if (route.method === "POST") {
    try {
      body = await parseJsonBody(req);
    } catch {
      sendJson(res, 400, errorEnvelope(400, "invalid JSON body", requestId));
      return true;
    }
  }

  // Execute handler
  try {
    const data = await route.handler(body, chClient!, requestId);
    sendJson(res, 200, successEnvelope(data, requestId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("VALIDATION:")) {
      sendJson(res, 400, errorEnvelope(400, msg.slice(11), requestId));
    } else {
      deps.logger.error?.("[analytics]", pathname, msg);
      sendJson(res, 500, errorEnvelope(500, "internal_error", requestId));
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

function validate<T>(schema: { safeParse: (data: unknown) => { success: boolean; data?: T; error?: import("zod").ZodError } }, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new Error(`VALIDATION:${formatZodError(result.error!)}`);
  }
  return result.data!;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleConfig(
  _body: unknown,
  chClient: AnalyticsChClient | null,
): Promise<unknown> {
  if (!chClient) {
    return { configured: false, reachable: false, database: "", tables: {} };
  }
  const [reachable, tables] = await Promise.all([
    chClient.ping(),
    chClient.checkTables([...ANALYTICS_TABLES]),
  ]);
  return {
    configured: true,
    reachable,
    database: "context_proxy",
    tables,
  };
}

async function handleSpaces(
  _body: unknown,
  chClient: AnalyticsChClient,
): Promise<unknown> {
  const { query, query_params } = sql.buildListSpaces();
  const rows = await chClient.query<{ space_id: string }>({ query, query_params });
  return { spaces: rows };
}

// ── Session-init ──

async function handleSessionInitSummary(
  body: unknown,
  chClient: AnalyticsChClient,
): Promise<unknown> {
  const params = validate(schemas.sessionInitSummarySchema, body);
  const { query, query_params } = sql.buildSessionInitSummary(params);
  const rows = await chClient.query<Record<string, unknown>>({ query, query_params });
  const r = rows[0] ?? {};
  const currentRate = Number(r.current_tool_call_rate_pct ?? 0);
  const previousRate = Number(r.previous_tool_call_rate_pct ?? 0);
  const currentAvg = Number(r.current_avg_calls ?? 0);
  const previousAvg = Number(r.previous_avg_calls ?? 0);
  const currentBypass = Number(r.current_bypass_pct ?? 0);
  const previousBypass = Number(r.previous_bypass_pct ?? 0);

  return {
    tool_call_rate: {
      current_pct: currentRate,
      previous_pct: previousRate,
      delta_pp: round2(currentRate - previousRate),
    },
    avg_calls: {
      current_avg: currentAvg,
      previous_avg: previousAvg,
      delta: round2(currentAvg - previousAvg),
    },
    bypass_rate: {
      current_pct: currentBypass,
      previous_pct: previousBypass,
      delta_pp: round2(currentBypass - previousBypass),
      bypass_sessions: Number(r.bypass_sessions ?? 0),
      non_bypass_sessions: Number(r.non_bypass_sessions ?? 0),
    },
    distinct_init_sessions: Number(r.distinct_init_sessions ?? 0),
    total_bridge_calls: Number(r.total_bridge_calls ?? 0),
  };
}

async function handleSessionInitTimeseries(
  body: unknown,
  chClient: AnalyticsChClient,
): Promise<unknown> {
  const params = validate(schemas.sessionInitTimeseriesSchema, body);
  const { query, query_params } = sql.buildSessionInitTimeseries(params);
  const rows = await chClient.query({ query, query_params });
  return { series: rows };
}

async function handleBypassReasons(
  body: unknown,
  chClient: AnalyticsChClient,
): Promise<unknown> {
  const params = validate(schemas.bypassReasonsSchema, body);
  const { query, query_params } = sql.buildBypassReasons(params);
  const rows = await chClient.query({ query, query_params });
  return { reasons: rows };
}

// ── Tool calls ──

async function handleToolCallEndpointShare(
  body: unknown,
  chClient: AnalyticsChClient,
): Promise<unknown> {
  const params = validate(schemas.toolCallEndpointShareSchema, body);
  const { query, query_params } = sql.buildToolCallEndpointShare(params);
  const rows = await chClient.query({ query, query_params });
  return { endpoints: rows };
}

async function handleToolCallTopBodies(
  body: unknown,
  chClient: AnalyticsChClient,
): Promise<unknown> {
  const params = validate(schemas.toolCallTopBodiesSchema, body);
  const { query, query_params } = sql.buildToolCallTopBodies(params);
  const rows = await chClient.query({ query, query_params });
  return { items: rows };
}

async function handleToolCallTimeseries(
  body: unknown,
  chClient: AnalyticsChClient,
): Promise<unknown> {
  const params = validate(schemas.toolCallTimeseriesSchema, body);
  const { query, query_params } = sql.buildToolCallTimeseries(params);
  const rows = await chClient.query({ query, query_params });
  return { series: rows };
}

async function handleToolCallList(
  body: unknown,
  chClient: AnalyticsChClient,
): Promise<unknown> {
  const params = validate(schemas.toolCallListSchema, body);
  const [countRows, items] = await Promise.all([
    chClient.query<{ total: number }>(sql.buildToolCallListCount(params)),
    chClient.query(sql.buildToolCallList(params)),
  ]);
  return {
    total: Number(countRows[0]?.total ?? 0),
    offset: params.offset,
    limit: params.limit,
    items,
  };
}

async function handleToolCallWatermark(
  body: unknown,
  chClient: AnalyticsChClient,
): Promise<unknown> {
  const params = validate(schemas.watermarkSchema, body);
  const { query, query_params } = sql.buildWatermark(params);
  const rows = await chClient.query<{
    user_id: string;
    call_count: number;
    max_timestamp: string;
    max_request_hash: string;
  }>({ query, query_params });

  const users: Record<string, string> = {};
  const userCounts: Record<string, number> = {};
  let count = 0;
  let maxTimestamp = "";
  let unassignedErrors = 0;

  for (const row of rows) {
    const uid = row.user_id ?? "";
    const callCount = Number(row.call_count ?? 0);
    count += callCount;
    if (row.max_timestamp > maxTimestamp) maxTimestamp = row.max_timestamp;

    if (uid) {
      userCounts[uid] = callCount;
      users[uid] = createHash("sha256")
        .update(`${callCount}\0${row.max_timestamp}\0${row.max_request_hash}`)
        .digest("hex");
    } else {
      unassignedErrors = callCount;
    }
  }

  const canonical = JSON.stringify(
    { count, max_timestamp: maxTimestamp, users },
    Object.keys({ count: 0, max_timestamp: "", users: {} }).sort(),
  );
  // Deterministic serialization for watermark
  const canonicalSorted = JSON.stringify(
    { count, max_timestamp: maxTimestamp, users },
    null, 0,
  ).split("").sort().join(""); // fallback — use proper canonical below
  const watermark = createHash("sha256")
    .update(JSON.stringify({ count, max_timestamp: maxTimestamp, users }, null, 0)
      // proper canonical: sort keys, no spaces
      .replace(/\s/g, ""))
    .digest("hex");

  // Proper canonical matching check-recall-telemetry.py:
  // json.dumps({"count": count, "max_timestamp": max_ts, "users": users}, sort_keys=True, separators=(",",":"))
  const canonicalObj: Record<string, unknown> = { count, max_timestamp: maxTimestamp, users };
  const sortedCanonical = JSON.stringify(canonicalObj, Object.keys(canonicalObj).sort());
  // Remove spaces after colons (JSON.stringify adds them)
  const compactCanonical = sortedCanonical.replace(/:\s/g, ":").replace(/,\s/g, ",");
  const correctWatermark = createHash("sha256").update(compactCanonical).digest("hex");

  return {
    watermark: correctWatermark,
    count,
    max_timestamp: maxTimestamp,
    users,
    user_counts: userCounts,
    unassigned_errors: unassignedErrors,
  };
}

async function handleToolCallDetailFetch(
  body: unknown,
  chClient: AnalyticsChClient,
): Promise<unknown> {
  const params = validate(schemas.detailFetchSchema, body);
  const { query, query_params } = sql.buildDetailFetch(params);
  const rows = await chClient.query({ query, query_params });
  return { total: rows.length, rows };
}

// ── Usage ──

async function handleUsageSummary(
  body: unknown,
  chClient: AnalyticsChClient,
): Promise<unknown> {
  const params = validate(schemas.usageSummarySchema, body);
  const { query, query_params } = sql.buildUsageSummary(params);
  const rows = await chClient.query({ query, query_params });
  return rows[0] ?? {};
}

async function handleUsageTimeseries(
  body: unknown,
  chClient: AnalyticsChClient,
): Promise<unknown> {
  const params = validate(schemas.usageTimeseriesSchema, body);
  const { query, query_params } = sql.buildUsageTimeseries(params);
  const rows = await chClient.query({ query, query_params });
  return { series: rows };
}

async function handleUsageByModel(
  body: unknown,
  chClient: AnalyticsChClient,
): Promise<unknown> {
  const params = validate(schemas.usageByModelSchema, body);
  const { query, query_params } = sql.buildUsageByModel(params);
  const rows = await chClient.query({ query, query_params });
  return { models: rows };
}

async function handleUsageList(
  body: unknown,
  chClient: AnalyticsChClient,
): Promise<unknown> {
  const params = validate(schemas.usageListSchema, body);
  const [countRows, items] = await Promise.all([
    chClient.query<{ total: number }>(sql.buildUsageListCount(params)),
    chClient.query(sql.buildUsageList(params)),
  ]);
  return {
    total: Number(countRows[0]?.total ?? 0),
    offset: params.offset,
    limit: params.limit,
    items,
  };
}

async function handleUsageRawList(
  body: unknown,
  chClient: AnalyticsChClient,
): Promise<unknown> {
  const params = validate(schemas.usageRawListSchema, body);
  const [countRows, items] = await Promise.all([
    chClient.query<{ total: number }>(sql.buildUsageRawListCount(params)),
    chClient.query(sql.buildUsageRawList(params)),
  ]);
  return {
    total: Number(countRows[0]?.total ?? 0),
    offset: params.offset,
    limit: params.limit,
    items,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

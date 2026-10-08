import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DAY_MS = 24 * 60 * 60 * 1000;
const SEARCH_QUERY_LIMIT = 512;
const ROUTES = {
  "POST /v3/conversation/add": { layer: "L0", action: "write", kind: "write" },
  "POST /v3/conversation/search": { layer: "L0", action: "search", kind: "search" },
  "POST /v3/atomic/search": { layer: "L1", action: "search", kind: "search" },
  "POST /v3/scenario/ls": { layer: "L2", action: "read", kind: "list" },
  "POST /v3/scenario/read": { layer: "L2", action: "read", kind: "file" },
  "POST /v3/core/read": { layer: "L3", action: "read", kind: "file" },
};

const recorders = new Map();

export function classify(method, pathname) {
  const pathOnly = String(pathname || "").split("?")[0];
  return ROUTES[`${method} ${pathOnly}`] || null;
}

export function shanghaiDay(tsMs) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(tsMs));
}

export function shanghaiHour(tsMs) {
  const hour = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    hourCycle: "h23",
  }).format(new Date(tsMs));
  return `${shanghaiDay(tsMs)} ${hour}:00`;
}

export function judgeOutcome(classification, status, body) {
  if (!classification) return null;
  const failed = status >= 400
    || !body
    || typeof body !== "object"
    || (typeof body.code === "number" && body.code !== 0);
  if (failed) {
    return { outcome: "error", hitCount: 0, topScore: null, typeCounts: {} };
  }
  if (classification.action === "write") {
    return { outcome: "accepted", hitCount: 0, topScore: null, typeCounts: {} };
  }
  const data = body.data && typeof body.data === "object" ? body.data : {};
  if (classification.kind === "list") {
    const entries = Array.isArray(data.entries) ? data.entries : [];
    return {
      outcome: entries.length ? "hit" : "miss",
      hitCount: entries.length,
      topScore: null,
      typeCounts: {},
    };
  }
  if (classification.kind === "file") {
    const content = data.content;
    const hit = typeof content === "string" && content.trim().length > 0;
    return { outcome: hit ? "hit" : "miss", hitCount: hit ? 1 : 0, topScore: null, typeCounts: {} };
  }
  const items = classification.layer === "L0"
    ? (Array.isArray(data.messages) ? data.messages : [])
    : (Array.isArray(data.items) ? data.items : []);
  const typeCounts = {};
  let topScore = null;
  for (const item of items) {
    if (classification.layer === "L1") {
      const kind = textId(item?.type) || "unknown";
      typeCounts[kind] = (typeCounts[kind] || 0) + 1;
    }
    const score = Number(item?.score);
    if (Number.isFinite(score)) topScore = topScore == null ? score : Math.max(topScore, score);
  }
  return {
    outcome: items.length ? "hit" : "miss",
    hitCount: items.length,
    topScore,
    typeCounts,
  };
}

export function resolveUsageOptions(config = {}, env = {}) {
  const deployMode = config.deployMode || "standalone";
  const usage = config.usage || {};
  let enabled;
  if (env.USAGE_ENABLED === "true" || env.USAGE_ENABLED === "1") enabled = true;
  else if (env.USAGE_ENABLED === "false" || env.USAGE_ENABLED === "0") enabled = false;
  else if (typeof usage.enabled === "boolean") enabled = usage.enabled;
  else enabled = deployMode !== "service";
  const retentionRaw = Number(usage.retentionDays ?? env.USAGE_RETENTION_DAYS ?? 30);
  const retentionDays = Number.isFinite(retentionRaw) && retentionRaw > 0 ? retentionRaw : 30;
  const dataDir = config.data?.baseDir || config.dataDir || ".";
  const dbPath = env.USAGE_DB_PATH || config.dbPath || path.join(dataDir, "usage.sqlite");
  return { enabled, retentionDays, dbPath, deployMode };
}

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function textId(value) {
  if (typeof value === "string") return value.slice(0, 128);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function searchQuery(action, body) {
  if (action !== "search" || !body || typeof body.query !== "string") return "";
  return body.query.slice(0, SEARCH_QUERY_LIMIT);
}

function ensureQueryColumn(db) {
  const columns = db.prepare("PRAGMA table_info(memory_usage)").all();
  if (columns.some((column) => column.name === "query")) return;
  db.exec("ALTER TABLE memory_usage ADD COLUMN query TEXT NOT NULL DEFAULT ''");
}

function hitRate(hits, misses) {
  const total = hits + misses;
  return total ? hits / total : null;
}

function parseCounts(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function addCounts(target, extra) {
  for (const [key, value] of Object.entries(extra)) {
    target[key] = (target[key] || 0) + value;
  }
}

export class UsageStore {
  constructor(options) {
    this.options = options;
    this.db = null;
    this.insert = null;
    this.timer = null;
    if (!options.enabled) return;
    fs.mkdirSync(path.dirname(options.dbPath), { recursive: true });
    this.db = new DatabaseSync(options.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts_ms INTEGER NOT NULL,
        layer TEXT NOT NULL,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        hit_count INTEGER NOT NULL,
        top_score REAL,
        team_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        path TEXT NOT NULL,
        type_counts TEXT NOT NULL,
        query TEXT NOT NULL DEFAULT ''
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_usage_ts ON memory_usage(ts_ms)");
    ensureQueryColumn(this.db);
    this.insert = this.db.prepare(`
      INSERT INTO memory_usage (
        ts_ms, layer, action, outcome, status_code, latency_ms, hit_count, top_score,
        team_id, agent_id, user_id, session_id, path, type_counts, query
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.purgeExpired(this.now());
    if (!options.disableTimer) {
      this.timer = setInterval(() => {
        try {
          this.purgeExpired(this.now());
        } catch {
          // Retention failure must not take down the gateway process.
        }
      }, DAY_MS);
      this.timer.unref?.();
    }
  }

  now() {
    return typeof this.options.now === "function" ? this.options.now() : Date.now();
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.db) return;
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // The file read in tests still sees committed rows after close.
    }
    this.db.close();
    this.db = null;
  }

  purgeExpired(now) {
    if (!this.db) return;
    const cutoff = now - this.options.retentionDays * DAY_MS;
    this.db.prepare("DELETE FROM memory_usage WHERE ts_ms < ?").run(cutoff);
  }

  count() {
    if (!this.db) return 0;
    return this.db.prepare("SELECT COUNT(*) AS n FROM memory_usage").get().n;
  }

  observe(call) {
    const response = call.responseBody;
    if (!this.options.enabled || !this.db) return { recorded: false, response };
    const classification = classify(call.method, call.pathname);
    if (!classification) return { recorded: false, response };
    const judged = judgeOutcome(classification, call.status, response);
    const ts = call.now ?? this.now();
    const startedAt = call.startedAt ?? ts;
    const body = call.requestBody && typeof call.requestBody === "object" && !Array.isArray(call.requestBody)
      ? call.requestBody
      : {};
    try {
      this.insert.run(
        ts,
        classification.layer,
        classification.action,
        judged.outcome,
        Number(call.status) || 0,
        Math.max(0, ts - startedAt),
        judged.hitCount,
        judged.topScore,
        textId(body.team_id ?? body.teamId),
        textId(body.agent_id ?? body.agentId),
        textId(body.user_id ?? body.userId),
        textId(body.session_id ?? body.sessionId),
        String(call.pathname || "").split("?")[0],
        JSON.stringify(judged.typeCounts || {}),
        searchQuery(classification.action, body),
      );
    } catch {
      return { recorded: false, response };
    }
    return { recorded: true, response };
  }

  summary(query = {}) {
    const rows = this.rows(this.window(query));
    let hits = 0;
    let misses = 0;
    let writes = 0;
    const users = new Set();
    const latencies = [];
    const typeCounts = {};
    for (const row of rows) {
      if (row.action === "write") writes += 1;
      if (row.action !== "write" && row.outcome === "hit") hits += 1;
      if (row.action !== "write" && row.outcome === "miss") misses += 1;
      if (row.user_id) users.add(row.user_id);
      latencies.push(row.latency_ms);
      if (row.layer === "L1") addCounts(typeCounts, parseCounts(row.type_counts));
    }
    const bounds = this.window(query);
    return {
      from: bounds.from,
      to: bounds.to,
      calls: rows.length,
      writes,
      hits,
      misses,
      hit_rate: hitRate(hits, misses),
      active_users: users.size,
      latency_ms: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
      type_counts: typeCounts,
    };
  }

  timeseries(query = {}) {
    const bounds = this.window(query);
    const bucket = bounds.bucket;
    const grouped = new Map();
    for (const row of this.rows(bounds)) {
      const key = bucket === "hour" ? shanghaiHour(row.ts_ms) : shanghaiDay(row.ts_ms);
      const point = grouped.get(key) || blankPoint(key);
      point.calls += 1;
      if (row.action === "write") point.writes += 1;
      if (row.action === "search") point.searches += 1;
      if (row.action === "read") point.reads += 1;
      if (row.action !== "write" && row.outcome === "hit") point.hits += 1;
      if (row.action !== "write" && row.outcome === "miss") point.misses += 1;
      if (row.user_id) point.users.add(row.user_id);
      point.latencies.push(row.latency_ms);
      if (row.layer === "L1") addCounts(point.typeCounts, parseCounts(row.type_counts));
      grouped.set(key, point);
    }
    const keys = bucket === "day" ? listDays(bounds.from, bounds.to) : [...grouped.keys()].sort();
    return {
      bucket,
      from: bounds.from,
      to: bounds.to,
      points: keys.map((key) => finishPoint(grouped.get(key) || blankPoint(key))),
    };
  }

  recent(query = {}) {
    const bounds = this.window(query);
    const limit = clampLimit(query.limit);
    const userId = bounds.userId;
    const layer = bounds.layer;
    const outcome = bounds.outcome;
    const rows = this.db.prepare(`
      SELECT ts_ms, layer, action, outcome, status_code, latency_ms, hit_count, top_score,
             team_id, agent_id, user_id, session_id, path, type_counts, query
      FROM memory_usage
      WHERE ts_ms >= ? AND ts_ms <= ?
        AND (? = '' OR user_id = ?)
        AND (? = '' OR layer = ?)
        AND (? = '' OR outcome = ?)
      ORDER BY ts_ms DESC, id DESC
      LIMIT ?
    `).all(bounds.from, bounds.to, userId, userId, layer, layer, outcome, outcome, limit);
    return {
      items: rows.map((row) => ({
        ts_ms: row.ts_ms,
        layer: row.layer,
        action: row.action,
        outcome: row.outcome,
        status: row.status_code,
        latency_ms: row.latency_ms,
        hit_count: row.hit_count,
        top_score: row.top_score,
        team_id: row.team_id,
        agent_id: row.agent_id,
        user_id: row.user_id,
        session_id: row.session_id,
        path: row.path,
        type_counts: parseCounts(row.type_counts),
        query: row.query || "",
      })),
    };
  }

  window(query = {}) {
    const now = this.now();
    const minFrom = now - this.options.retentionDays * DAY_MS;
    let from = query.from ?? minFrom;
    let to = query.to ?? now;
    if (from < minFrom) from = minFrom;
    if (from > to) from = to;
    return {
      from,
      to,
      userId: query.userId || "",
      layer: query.layer || "",
      outcome: query.outcome || "",
      bucket: query.bucket === "hour" ? "hour" : "day",
    };
  }

  rows(bounds) {
    return this.db.prepare(`
      SELECT ts_ms, layer, action, outcome, latency_ms, user_id, type_counts
      FROM memory_usage
      WHERE ts_ms >= ? AND ts_ms <= ?
        AND (? = '' OR user_id = ?)
        AND (? = '' OR layer = ?)
        AND (? = '' OR outcome = ?)
      ORDER BY ts_ms ASC
    `).all(
      bounds.from,
      bounds.to,
      bounds.userId,
      bounds.userId,
      bounds.layer,
      bounds.layer,
      bounds.outcome,
      bounds.outcome,
    );
  }
}

function blankPoint(bucket) {
  return {
    bucket,
    calls: 0,
    writes: 0,
    searches: 0,
    reads: 0,
    hits: 0,
    misses: 0,
    users: new Set(),
    latencies: [],
    typeCounts: {},
  };
}

function finishPoint(point) {
  return {
    bucket: point.bucket,
    calls: point.calls,
    writes: point.writes,
    searches: point.searches,
    reads: point.reads,
    hits: point.hits,
    misses: point.misses,
    hit_rate: hitRate(point.hits, point.misses),
    active_users: point.users.size,
    p50: percentile(point.latencies, 50),
    p95: percentile(point.latencies, 95),
    type_counts: point.typeCounts,
  };
}

function listDays(from, to) {
  const days = [];
  let cursor = Date.parse(`${shanghaiDay(from)}T00:00:00+08:00`);
  const end = Date.parse(`${shanghaiDay(to)}T00:00:00+08:00`);
  while (cursor <= end && days.length < 400) {
    days.push(shanghaiDay(cursor));
    cursor += DAY_MS;
  }
  return days;
}

function clampLimit(value) {
  const parsed = value == null || value === "" ? 50 : Number(value);
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(200, Math.max(1, Math.floor(parsed)));
}

function parseBound(value, end) {
  if (value == null || value === "") return null;
  if (/^\d+$/.test(value)) return Number(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const stamp = end ? `${value}T23:59:59.999+08:00` : `${value}T00:00:00.000+08:00`;
    return Date.parse(stamp);
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function handleUsageRead({ method, pathname, searchParams, store, authorized }) {
  if (!authorized) {
    return { status: 401, body: { code: 401, message: "unauthorized", data: null } };
  }
  if (method !== "GET") {
    return { status: 405, body: { code: 405, message: "method not allowed", data: null } };
  }
  if (!store?.options?.enabled) {
    return { status: 404, body: { code: 404, message: "usage not enabled", data: null } };
  }
  const name = String(pathname || "").split("?")[0].replace(/^\/v3\/usage\/?/, "");
  const bucket = searchParams.get("bucket") || "day";
  if (bucket !== "day" && bucket !== "hour") {
    return { status: 400, body: { code: 400, message: "bucket must be day or hour", data: null } };
  }
  const layer = searchParams.get("layer") || "";
  const outcome = searchParams.get("outcome") || "";
  if (layer && !["L0", "L1", "L2", "L3"].includes(layer)) {
    return { status: 400, body: { code: 400, message: "invalid layer", data: null } };
  }
  if (outcome && !["hit", "miss", "error", "accepted"].includes(outcome)) {
    return { status: 400, body: { code: 400, message: "invalid outcome", data: null } };
  }
  const query = {
    from: parseBound(searchParams.get("from"), false) ?? undefined,
    to: parseBound(searchParams.get("to"), true) ?? undefined,
    userId: searchParams.get("user_id") || "",
    layer,
    outcome,
    bucket,
    limit: searchParams.get("limit"),
  };
  let data;
  if (name === "summary") data = store.summary(query);
  else if (name === "timeseries") data = store.timeseries(query);
  else if (name === "recent") data = store.recent(query);
  else return { status: 404, body: { code: 404, message: "usage not enabled", data: null } };
  return { status: 200, body: { code: 0, message: "ok", data } };
}

export function handleUsageReadRoute(req, res, pathname, method, sendJson, store) {
  const pathOnly = String(pathname || "").split("?")[0];
  if (pathOnly !== "/v3/usage" && !pathOnly.startsWith("/v3/usage/")) return false;
  const url = new URL(req.url || pathOnly, "http://127.0.0.1");
  const result = handleUsageRead({
    method,
    pathname: pathOnly,
    searchParams: url.searchParams,
    store,
    authorized: true,
  });
  sendJson(res, result.status, result.body);
  return true;
}

export function getUsageRecorder(config, env = process.env) {
  const options = resolveUsageOptions(config, env);
  const key = `${options.dbPath}:${options.enabled}`;
  const existing = recorders.get(key);
  if (existing) return existing;
  const store = new UsageStore(options);
  recorders.set(key, store);
  return store;
}

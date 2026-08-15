import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { ClickHouseTelemetryConfig } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("clickhouse-telemetry");
const REQUEST_BODY_MAX_BYTES = 512;
const MAX_BUFFER_ROWS = 10_000;
const RETAINED_BUFFER_ROWS = 5_000;
const SENSITIVE_KEY_PATTERN = /(?:authorization|api[_-]?key|access[_-]?token|password|secret|token|credential)/i;

export interface ToolCallLogRow {
  timestamp: string;
  session_key: string;
  turn_seq: number;
  space_id: string;
  user_id: string;
  team_id: string;
  agent_id: string;
  agent_source: string;
  kind: string;
  bridge_source: string;
  initiated_tool: string;
  executed_endpoint: string;
  request_body: string;
  request_body_hash: string;
  upstream_status: number;
  elapsed_ms: number;
  source_tag: string;
  host: string;
}

export interface KnowledgeToolCallInput {
  timestamp?: Date;
  headers: Headers;
  rawBody: string;
  status: number;
  elapsedMs: number;
}

export interface KnowledgeTelemetry {
  initialize(): Promise<void>;
  recordToolCall(input: KnowledgeToolCallInput): void;
  shutdown(): Promise<void>;
}

function toClickHouseTimestamp(date: Date): string {
  // tool_call_logs uses Asia/Shanghai; insert a timezone-free Beijing wall-clock value.
  const utc8 = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return utc8.toISOString().replace("T", " ").replace("Z", "");
}

function header(headers: Headers, name: string): string {
  return headers.get(name)?.trim() ?? "";
}

function parseTurnSeq(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : redact(child);
  }
  return output;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/u, "");
}

export function sanitizeToolCallBody(rawBody: string): { body: string; toolName: string } {
  if (!rawBody) return { body: "", toolName: "" };
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    const rawToolName = typeof parsed.tool_name === "string" ? parsed.tool_name : parsed.name;
    const toolName = typeof rawToolName === "string" ? rawToolName.slice(0, 128) : "";
    return {
      body: truncateUtf8(JSON.stringify(redact(parsed)), REQUEST_BODY_MAX_BYTES),
      toolName,
    };
  } catch {
    return { body: "[UNPARSEABLE_BODY]", toolName: "" };
  }
}

export function buildKnowledgeToolCallRow(input: KnowledgeToolCallInput): ToolCallLogRow {
  const { body, toolName } = sanitizeToolCallBody(input.rawBody);
  return {
    timestamp: toClickHouseTimestamp(input.timestamp ?? new Date()),
    session_key: header(input.headers, "x-conversation-id"),
    turn_seq: parseTurnSeq(header(input.headers, "x-tdai-turn-seq")),
    space_id: header(input.headers, "x-tdai-space-id"),
    user_id: header(input.headers, "x-tdai-user-id"),
    team_id: header(input.headers, "x-tdai-team-id"),
    agent_id: header(input.headers, "x-tdai-agent-id"),
    agent_source: header(input.headers, "x-tdai-agent-source") || "unknown",
    kind: "bridge_call",
    bridge_source: "knowledge-service",
    initiated_tool: toolName,
    executed_endpoint: toolName ? `tools/call/${toolName}` : "tools/call",
    request_body: body,
    request_body_hash: body ? createHash("sha256").update(body).digest("hex").slice(0, 16) : "",
    upstream_status: input.status,
    elapsed_ms: Math.max(0, Math.round(input.elapsedMs)),
    source_tag: "knowledge",
    host: process.env.HOSTNAME ?? "",
  };
}

function quoteIdentifier(identifier: string): string {
  return `\`${identifier}\``;
}

function qualifiedTable(config: ClickHouseTelemetryConfig): string {
  return `${quoteIdentifier(config.database)}.${quoteIdentifier(config.table)}`;
}

function tableDdl(config: ClickHouseTelemetryConfig): string {
  const ttl = config.ttlDays > 0
    ? `TTL toDateTime(timestamp) + INTERVAL ${config.ttlDays} DAY`
    : "";
  return [
    `CREATE TABLE IF NOT EXISTS ${qualifiedTable(config)} (`,
    "  timestamp DateTime64(3, 'Asia/Shanghai'),",
    "  session_key String,",
    "  turn_seq UInt32 DEFAULT 0,",
    "  space_id String,",
    "  user_id String,",
    "  team_id String DEFAULT '',",
    "  agent_id String DEFAULT '',",
    "  agent_source LowCardinality(String),",
    "  kind LowCardinality(String),",
    "  bridge_source LowCardinality(String) DEFAULT '',",
    "  initiated_tool String,",
    "  executed_endpoint String,",
    "  request_body String CODEC(ZSTD(3)),",
    "  request_body_hash FixedString(16) DEFAULT '',",
    "  upstream_status UInt16 DEFAULT 0,",
    "  elapsed_ms UInt32 DEFAULT 0,",
    "  source_tag LowCardinality(String) DEFAULT 'proxy',",
    "  host LowCardinality(String)",
    ") ENGINE = MergeTree()",
    "ORDER BY (space_id, session_key, timestamp)",
    ttl,
  ].filter(Boolean).join("\n");
}

class DisabledKnowledgeTelemetry implements KnowledgeTelemetry {
  async initialize(): Promise<void> {}
  recordToolCall(): void {}
  async shutdown(): Promise<void> {}
}

export class ClickHouseKnowledgeTelemetry implements KnowledgeTelemetry {
  private buffer: ToolCallLogRow[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;

  constructor(
    private readonly config: ClickHouseTelemetryConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async initialize(): Promise<void> {
    try {
      await this.executeQuery(tableDdl(this.config));
      log.info("ClickHouse knowledge telemetry initialized", {
        database: this.config.database,
        table: this.config.table,
      });
    } catch (err) {
      log.warn("ClickHouse telemetry table initialization failed; requests remain available", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.timer = setInterval(() => void this.flush(), this.config.flushIntervalMs);
    this.timer.unref?.();
  }

  recordToolCall(input: KnowledgeToolCallInput): void {
    try {
      this.buffer.push(buildKnowledgeToolCallRow(input));
      this.trimBuffer();
      if (this.buffer.length >= this.config.flushThreshold) void this.flush();
    } catch {
      // Telemetry must never affect the request path.
    }
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
    // A row may have arrived while an earlier flush was in flight.
    if (this.buffer.length > 0) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.buffer.length === 0) return;
    const rows = this.buffer.splice(0);
    this.flushing = this.insertRows(rows)
      .catch((err) => {
        this.buffer.unshift(...rows);
        this.trimBuffer();
        log.warn("ClickHouse telemetry flush failed", {
          rows: rows.length,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        this.flushing = null;
      });
    return this.flushing;
  }

  private trimBuffer(): void {
    if (this.buffer.length <= MAX_BUFFER_ROWS) return;
    const dropped = this.buffer.length - RETAINED_BUFFER_ROWS;
    this.buffer = this.buffer.slice(-RETAINED_BUFFER_ROWS);
    log.warn("ClickHouse telemetry buffer overflow", { dropped });
  }

  private async insertRows(rows: ToolCallLogRow[]): Promise<void> {
    const payload = rows.map((row) => JSON.stringify(row)).join("\n");
    await this.executeQuery(
      `INSERT INTO ${qualifiedTable(this.config)} FORMAT JSONEachRow`,
      payload,
    );
  }

  private async executeQuery(query: string, data = ""): Promise<void> {
    const url = new URL(this.config.url);
    url.searchParams.set("query", query);
    const headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8" };
    if (this.config.user) headers["x-clickhouse-user"] = this.config.user;
    if (this.config.password) headers["x-clickhouse-key"] = this.config.password;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body: data,
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
    if (!response.ok) {
      const detail = truncateUtf8(await response.text(), 256);
      throw new Error(`ClickHouse HTTP ${response.status}: ${detail}`);
    }
  }
}

export function createKnowledgeTelemetry(
  config: ClickHouseTelemetryConfig,
  fetchImpl?: typeof fetch,
): KnowledgeTelemetry {
  return config.enabled
    ? new ClickHouseKnowledgeTelemetry(config, fetchImpl)
    : new DisabledKnowledgeTelemetry();
}

export function createKnowledgeTelemetryMiddleware(
  telemetry: KnowledgeTelemetry,
): MiddlewareHandler {
  return async (c, next) => {
    const startedAt = performance.now();
    // The outer access logger has already consumed the raw stream and populated
    // Hono's body cache. Prefer that cache; cloning an already-consumed Request
    // throws synchronously with `TypeError: unusable` in Node/Undici.
    const bodyCache = c.req.bodyCache as unknown as {
      text?: string | Promise<string>;
      json?: unknown | Promise<unknown>;
    };
    let bodyPromise: Promise<string>;
    if (bodyCache.text !== undefined) {
      bodyPromise = Promise.resolve(bodyCache.text).catch(() => "");
    } else if (bodyCache.json !== undefined) {
      bodyPromise = Promise.resolve(bodyCache.json)
        .then((body) => JSON.stringify(body))
        .catch(() => "");
    } else {
      try {
        bodyPromise = c.req.raw.clone().text().catch(() => "");
      } catch {
        bodyPromise = Promise.resolve("");
      }
    }
    await next();
    telemetry.recordToolCall({
      headers: c.req.raw.headers,
      rawBody: await bodyPromise,
      status: c.res.status,
      elapsedMs: performance.now() - startedAt,
    });
  };
}

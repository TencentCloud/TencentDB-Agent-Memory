/**
 * ClickHouse async batch writer for usage logs (official @clickhouse/client SDK).
 *
 * 定位：**自建/云 ClickHouse 的用量上报**，用于给每个用户展示 token 消耗（按 turn）。
 * 与 Langfuse / Opik 上报互相独立 —— Langfuse 做 trace 可视化，这里做用量/计费数据源。
 *
 * Features:
 * - 官方 SDK（createClient + insert(JSONEachRow) + command(DDL)）
 * - 内存缓冲 + 定时/阈值 flush
 * - 失败重排队（带缓冲上限防 OOM）
 * - Error-silent：绝不阻塞或拖垮业务请求
 * - graceful shutdown：退出前 flush 剩余缓冲
 *
 * 可靠性说明：失败行会重排队重试，但缓冲超上限时丢弃最早的行（"尽量不丢"而非
 * "绝对不丢"）。若计费要求零丢失，需后续加落盘 WAL —— 当前不做。
 */

import type { ClickHouseClient } from "@clickhouse/client";
import { log } from "./report/log.js";
import { hostname } from "node:os";
import { createHash } from "node:crypto";
import { computeCreditDelta } from "./credit-reporter.js";
import { getModelPricing, resolveModelName } from "./pricing.js";
import type { CreditPricingConfig, CreditPricingEntry } from "./types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ClickHouseConfig {
  /** Whether ClickHouse logging is enabled. */
  enabled: boolean;
  /** ClickHouse HTTP endpoint (e.g. http://<CLICKHOUSE_HOST>:8123). */
  url: string;
  /** Database name. */
  database: string;
  /** Table name for usage logs. */
  table: string;
  /** Raw usage traceability table (non-TokenHub / unrecognized format). */
  rawTable: string;
  /** Auth user. */
  user: string;
  /** Auth password. */
  password: string;
  /** Flush interval in ms (default: 5000). */
  flushIntervalMs: number;
  /** Buffer flush threshold in rows (default: 50). */
  flushThreshold: number;
  /** Data retention TTL in days. 0 = no TTL. Default: 0. */
  ttlDays: number;
}

/** One row = one upstream request (primary usage or extension telemetry). turn 由 (session_key, turn_seq) 标识。 */
export interface ClickHouseRow {
  timestamp: string;       // ClickHouse DateTime64 format "YYYY-MM-DD HH:MM:SS.mmm"
  event: string;           // 'usage' | 'analyzer_usage' (extension telemetry)
  session_key: string;     // 会话隔离键（turn 归并用）
  turn_seq: number;        // turn 序号
  user_input: string;      // 该 turn 的用户输入（仅首请求有值，去噪后；其余为空）
  model_id: string;
  model_name: string;      // UI 展示名（来自定价表 modelName；未匹配时回落 modelId）
  user_id: string;         // 用户标识（auth 启用时为 user_id，否则为 SHA-256(apiKey)[:8]）
  upstream_url: string;
  stream: number;          // 0 or 1
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_hit_tokens: number;    // 命中（cache_read）
  cache_miss_tokens: number;
  cache_write_tokens: number;  // 写缓存（cache_creation，总量）
  // ── TokenHub Anthropic 原样字段（不做转换） ─────────────────────────
  input_tokens: number;                                  // 非缓存输入（TokenHub 已排除 cache）
  cache_creation_ephemeral_5m_input_tokens: number;      // 5m TTL 缓存写入
  cache_creation_ephemeral_1h_input_tokens: number;      // 1h TTL 缓存写入
  credit: number;
  credit_saved: number;        // 路由节省的 credit（仅 event=usage 且 routed_from 非空时有值）
  routed_from: string;
  space_id: string;            // 空间/租户标识（从 /proxy/<spaceId>/... 路径提取）
  source_tag: string;          // 来源标记，恒定为 "proxy"
  host: string;
  upstream_request_id: string; // 上游响应 header `x-request-id`（tokenhub/OpenAI 兼容网关生成），用于跨系统追溯
  /**
   * 压缩节省的 token 数：max(0, pre_compress_tokens − post_compress_tokens)。
   * 来自 cost-guard extensionStats；未压缩时为 0。
   */
  compress_tokens_saved: number;
  /**
   * 压缩服务报告的压缩前 token 数（仅统计它真的返回过数字的内容）。
   *
   * 口径提示：这是压缩服务自己的 tokenizer 数出来的，与同一行的 `input_tokens`
   * （上游模型的计费口径）不是同一把尺子，两者不可相减、也不能直接折算成费用。
   * 它的用途是算压缩率 `post / pre`。
   */
  pre_compress_tokens: number;
  /** 同一批内容压缩后的 token 数；保留原文的项记为与压缩前相同。 */
  post_compress_tokens: number;
}

/**
 * Raw usage row for traceability (non-TokenHub or unrecognized format).
 *
 * 字段与主表 `ClickHouseRow` 尽量对齐，方便运维/报表跨表 JOIN 查询。
 * 与 `usage_logs` 的差异：
 *  - 保留 `usage` 原文（JSON 字符串），不做解析
 *  - `reason` 字段记录落入 raw 表的原因（unknown_model / invalid_format / ...）
 *  - `key_id` 与 `user_id` **双写**（老表用 key_id，新表用 user_id），
 *    通过 ClickHouse `JSONEachRow` 格式的容错性实现双向兼容
 */
export interface ClickHouseRawUsageRow {
  timestamp: string;
  model_id: string;
  model_name: string;          // 展示名（与主表对齐；无定价配置时回落 model_id）
  key_id: string;              // 老列（兼容存量表）
  user_id: string;             // 新列（与主表 user_id 命名统一），值 = key_id
  session_key: string;
  turn_seq: number;            // 与主表对齐
  user_input: string;          // 与主表对齐（用户输入前缀）
  upstream_url: string;
  stream: number;
  usage: string;               // JSON.stringify(raw usage), unmodified
  reason: string;              // 'non_tokenhub' | 'unknown_model' | 'invalid_format' | 'invalid_credit' | 'report_failed'
  routed_from: string;         // 路由前的原始模型
  space_id: string;            // 空间/租户标识（从 /proxy/<spaceId>/... 提取）
  source_tag: string;          // 来源标记，恒为 "proxy"
  host: string;
  upstream_request_id: string; // 上游响应 header `x-request-id`（追溯用；与主表对齐）
}

// ── Writer state ────────────────────────────────────────────────────────────

const HOST_ID = hostname();

let config: ClickHouseConfig | null = null;
let client: ClickHouseClient | null = null;
let buffer: ClickHouseRow[] = [];
let rawBuffer: ClickHouseRawUsageRow[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let disabled = false;

/**
 * Initialize the ClickHouse writer.
 * Must be called once at startup. Idempotent.
 */
export function initClickHouse(cfg: ClickHouseConfig): void {
  if (!cfg.enabled) {
    disabled = true;
    return;
  }
  if (!cfg.url) {
    log.warn("clickhouse.init.skipped", { reason: "empty url" });
    disabled = true;
    return;
  }

  config = cfg;
  disabled = false;

  // Periodic flush (both main and raw buffers)
  flushTimer = setInterval(() => {
    void flush();
    void flushRaw();
    // Internal telemetry buffers (§7.1) — 静默兜底防 unhandledRejection
    void flushSessionInit().catch(() => {});
    void flushToolCall().catch(() => {});
  }, cfg.flushIntervalMs);
  flushTimer.unref(); // Don't prevent process exit

  log.info("clickhouse.init", {
    url: cfg.url,
    database: cfg.database,
    table: cfg.table,
    flushIntervalMs: cfg.flushIntervalMs,
    flushThreshold: cfg.flushThreshold,
    ttlDays: cfg.ttlDays,
  });

  // Fire-and-forget: create client + database + table (idempotent)
  ensureClickHouse(cfg).catch((err: unknown) => {
    log.warn("clickhouse.init.ensureFailed", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * Create the SDK client (against the `default` db for DDL), ensure database +
 * table exist, then re-point the client at the target database for inserts.
 */
async function ensureClickHouse(cfg: ClickHouseConfig): Promise<void> {
  const { createClient } = await import("@clickhouse/client");

  // Bootstrap client (no database bound) to create the target database.
  const bootstrap = createClient({
    url: cfg.url,
    username: cfg.user,
    password: cfg.password,
    request_timeout: 10_000,
  });

  try {
    await bootstrap.command({
      query: `CREATE DATABASE IF NOT EXISTS ${cfg.database}`,
      clickhouse_settings: { wait_end_of_query: 1 },
    });
  } finally {
    await bootstrap.close().catch(() => {});
  }

  // Target client bound to the database, reused for all inserts.
  client = createClient({
    url: cfg.url,
    username: cfg.user,
    password: cfg.password,
    database: cfg.database,
    request_timeout: 10_000,
    keep_alive: { enabled: true },
  });

  const ttlClause = cfg.ttlDays > 0 ? `TTL timestamp + INTERVAL ${cfg.ttlDays} DAY` : "";
  const ddl = [
    `CREATE TABLE IF NOT EXISTS ${cfg.table} (`,
    "  timestamp DateTime64(3, 'Asia/Shanghai'),",
    "  event LowCardinality(String),",
    "  session_key String,",
    "  turn_seq UInt32,",
    "  user_input String,",
    "  model_id String,",
    "  model_name String DEFAULT '',",
    "  user_id String,",
    "  upstream_url String,",
    "  stream UInt8,",
    "  prompt_tokens UInt64,",
    "  completion_tokens UInt64,",
    "  total_tokens UInt64,",
    "  cache_hit_tokens UInt64,",
    "  cache_miss_tokens UInt64,",
    "  cache_write_tokens UInt64,",
    "  input_tokens UInt64 DEFAULT 0,",
    "  cache_creation_ephemeral_5m_input_tokens UInt64 DEFAULT 0,",
    "  cache_creation_ephemeral_1h_input_tokens UInt64 DEFAULT 0,",
    "  credit Float64,",
    "  credit_saved Float64 DEFAULT 0,",
    "  routed_from LowCardinality(String),",
    "  space_id String DEFAULT '',",
    "  source_tag LowCardinality(String) DEFAULT 'proxy',",
    "  host LowCardinality(String),",
    "  upstream_request_id String DEFAULT '',",
    "  compress_tokens_saved UInt64 DEFAULT 0,",
    "  pre_compress_tokens UInt64 DEFAULT 0,",
    "  post_compress_tokens UInt64 DEFAULT 0",
    ") ENGINE = MergeTree()",
    "ORDER BY (user_id, session_key, timestamp)",
    ttlClause,
  ]
    .filter(Boolean)
    .join("\n");

  await client.command({
    query: ddl,
    clickhouse_settings: { wait_end_of_query: 1 },
  });

  // Raw usage table (traceability for non-TokenHub / unrecognized format).
  if (cfg.rawTable) {
    // 新表默认排序键用 user_id（与主表对齐）；老表继续用 key_id（在 migrate 里补齐 user_id 列即可）
    const rawDdl = [
      `CREATE TABLE IF NOT EXISTS ${cfg.rawTable} (`,
      "  timestamp DateTime64(3, 'Asia/Shanghai'),",
      "  model_id String,",
      "  model_name String DEFAULT '',",
      "  key_id LowCardinality(String),",
      "  user_id String DEFAULT '',",
      "  session_key String,",
      "  turn_seq UInt32 DEFAULT 0,",
      "  user_input String DEFAULT '',",
      "  upstream_url String,",
      "  stream UInt8,",
      "  usage String,",
      "  reason LowCardinality(String),",
      "  routed_from String DEFAULT '',",
      "  space_id String DEFAULT '',",
      "  source_tag LowCardinality(String) DEFAULT 'proxy',",
      "  host LowCardinality(String),",
      "  upstream_request_id String DEFAULT ''",
      ") ENGINE = MergeTree()",
      "ORDER BY (user_id, timestamp)",
      ttlClause,
    ]
      .filter(Boolean)
      .join("\n");

    await client.command({
      query: rawDdl,
      clickhouse_settings: { wait_end_of_query: 1 },
    });
  }

  // 补齐历史 schema 漂移：对存量表执行 ALTER TABLE ADD COLUMN IF NOT EXISTS。
  // 幂等且失败不阻断（缺 DDL 权限时降级为 warn，业务继续用可写字段）。
  await migrateSchema(client, cfg);

  // Internal Usage Telemetry (§7.1) — 两张新表 DDL 幂等注册。
  // 失败不阻断启动：单独 try/catch，记 warn 后继续（跟老表相同的失败降级思路）。
  try {
    await createTableIfNotExists(client, sessionInitTableDdl());
    await createTableIfNotExists(client, toolCallTableDdl());
    log.info("clickhouse.init.telemetryTableReady", {
      sessionInitTable: `${cfg.database}.${SESSION_INIT_TABLE}`,
      toolCallTable: `${cfg.database}.${TOOL_CALL_TABLE}`,
      ttlDays: TELEMETRY_TTL_DAYS,
    });
  } catch (err: unknown) {
    log.warn("clickhouse.init.telemetryTableFailed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  log.info("clickhouse.init.tableReady", {
    table: `${cfg.database}.${cfg.table}`,
    rawTable: cfg.rawTable ? `${cfg.database}.${cfg.rawTable}` : undefined,
    ttlDays: cfg.ttlDays,
  });
}

/**
 * 补齐 ClickHouse 表 schema 的历史漂移。
 *
 * `CREATE TABLE IF NOT EXISTS` 仅在表不存在时执行 DDL，一旦表建成后代码 DDL
 * 的字段变更（新增列、类型调整）都无法自动同步到现网表。本函数遍历一份
 * 显式的迁移清单，对每张目标表执行 `ALTER TABLE ADD COLUMN IF NOT EXISTS`。
 *
 * 特性：
 *  - **幂等**：`IF NOT EXISTS` 由 ClickHouse (≥20.3) 原生保证，重复运行零成本
 *  - **失败降级**：单列 ALTER 失败（如应用账号缺 ALTER 权限）→ 只记 warn，
 *    继续处理其余列；启动流程不中断
 *  - **变更审计**：最终打一条 `clickhouse.migrate.done` 汇总日志
 *
 * 该函数在 `initClickHouse` 的 `CREATE TABLE IF NOT EXISTS` 之后调用，
 * 对全新表相当于 no-op（列都已在 CREATE 中定义），对存量老表则起补齐作用。
 *
 * @exported for unit testing.
 */
export async function migrateSchema(
  client: ClickHouseClient,
  cfg: ClickHouseConfig,
): Promise<void> {
  const migrations: Array<{ table: string; column: string; type: string }> = [
    // usage_logs：主表补齐（历史欠账 + 本次新增 model_name）
    { table: cfg.table, column: "session_key", type: "String" },
    { table: cfg.table, column: "turn_seq", type: "UInt32 DEFAULT 0" },
    { table: cfg.table, column: "user_input", type: "String DEFAULT ''" },
    { table: cfg.table, column: "user_id", type: "String DEFAULT ''" },
    { table: cfg.table, column: "model_name", type: "String DEFAULT ''" },
    { table: cfg.table, column: "input_tokens", type: "UInt64 DEFAULT 0" },
    {
      table: cfg.table,
      column: "cache_creation_ephemeral_5m_input_tokens",
      type: "UInt64 DEFAULT 0",
    },
    {
      table: cfg.table,
      column: "cache_creation_ephemeral_1h_input_tokens",
      type: "UInt64 DEFAULT 0",
    },
    { table: cfg.table, column: "credit_saved", type: "Float64 DEFAULT 0" },
    { table: cfg.table, column: "space_id", type: "String DEFAULT ''" },
    {
      table: cfg.table,
      column: "source_tag",
      type: "LowCardinality(String) DEFAULT 'proxy'",
    },
    // 上游响应 header `x-request-id`（tokenhub 等 OpenAI/Anthropic 兼容网关返回）。
    // 本次新增：用于跨系统追溯（客户端 x-request-id → 我方 upstream_request_id → 上游日志）。
    { table: cfg.table, column: "upstream_request_id", type: "String DEFAULT ''" },
    // cost-guard 压缩节省 token：max(0, preCompressTokens − postCompressTokens)
    { table: cfg.table, column: "compress_tokens_saved", type: "UInt64 DEFAULT 0" },
    // 压缩前后的原始计数，用于算压缩率——只有差值算不出分母。
    { table: cfg.table, column: "pre_compress_tokens", type: "UInt64 DEFAULT 0" },
    { table: cfg.table, column: "post_compress_tokens", type: "UInt64 DEFAULT 0" },
  ];

  // usage_raw：追溯表补齐（本次新增 6 列 + model_name + upstream_request_id）
  if (cfg.rawTable) {
    migrations.push(
      { table: cfg.rawTable, column: "user_id", type: "String DEFAULT ''" },
      { table: cfg.rawTable, column: "model_name", type: "String DEFAULT ''" },
      { table: cfg.rawTable, column: "turn_seq", type: "UInt32 DEFAULT 0" },
      { table: cfg.rawTable, column: "user_input", type: "String DEFAULT ''" },
      { table: cfg.rawTable, column: "routed_from", type: "String DEFAULT ''" },
      { table: cfg.rawTable, column: "space_id", type: "String DEFAULT ''" },
      {
        table: cfg.rawTable,
        column: "source_tag",
        type: "LowCardinality(String) DEFAULT 'proxy'",
      },
      {
        table: cfg.rawTable,
        column: "upstream_request_id",
        type: "String DEFAULT ''",
      },
    );
  }

  // tool_call_logs：补 reject_reason 列 (存量表由本次上线时通过 ALTER 加齐)
  migrations.push({
    table: TOOL_CALL_TABLE,
    column: "reject_reason",
    type: "LowCardinality(String) DEFAULT ''",
  });

  let ok = 0;
  let failed = 0;
  for (const m of migrations) {
    try {
      await client.command({
        query: `ALTER TABLE ${m.table} ADD COLUMN IF NOT EXISTS ${m.column} ${m.type}`,
        clickhouse_settings: { wait_end_of_query: 1 },
      });
      ok++;
    } catch (err: unknown) {
      failed++;
      log.warn("clickhouse.migrate.column_failed", {
        table: m.table,
        column: m.column,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  log.info("clickhouse.migrate.done", {
    ok,
    failed,
    total: migrations.length,
  });
}

/** ClickHouse timestamp 目标时区偏移（小时）。8 = 中国标准时间 (UTC+8)。 */
const CH_UTC_OFFSET_HOURS = 8;

/**
 * Convert an ISO 8601 UTC timestamp to a ClickHouse DateTime64 string in
 * China Standard Time (UTC+8).
 *
 * 调用方用 `new Date().toISOString()` 生成时间戳（恒为 UTC，带 "Z"）。
 * ClickHouse `timestamp` 列声明为 `DateTime64(3, 'Asia/Shanghai')`，写入时会把
 * 不带时区的裸字符串按 Asia/Shanghai 解析。因此这里先把 UTC 墙钟前移 8 小时
 * 得到「北京墙钟数字」——写入后 ClickHouse 解析回的**绝对时刻正确**（epoch 不变），
 * 且展示与时间函数（now() / toStartOfDay() / toDate()）都按北京时间处理。
 *
 * Input:  "2026-06-16T10:00:00.000Z"  (UTC)
 * Output: "2026-06-16 18:00:00.000"   (北京墙钟；按列时区解析回的 epoch = 原 UTC 时刻)
 */
function toChTimestamp(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    // 解析失败时回退到不做偏移的裸格式化（尽量不丢数据）。
    return iso.replace("T", " ").replace("Z", "").slice(0, 23);
  }
  const shifted = new Date(ms + CH_UTC_OFFSET_HOURS * 60 * 60 * 1000);
  return shifted.toISOString().replace("T", " ").replace("Z", "").slice(0, 23);
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

/** Sanity cap for credit values. A single request should never plausibly
 *  produce credit exceeding this value; anything above indicates a bug in
 *  pricing config or upstream usage payload.
 */
const CREDIT_SANITY_CAP = 1_000_000;

/**
 * Detect whether a computed credit value is anomalous and should be routed
 * to the raw traceability table instead of trusted for billing.
 *
 * Triggers:
 *   - NaN / Infinity / -Infinity (arithmetic broke somewhere)
 *   - Negative values (pricing bug or negative token counts)
 *   - Values > CREDIT_SANITY_CAP (misconfigured pricing or malformed upstream usage)
 *
 * Boundary: exactly CREDIT_SANITY_CAP (1_000_000) is still considered normal.
 */
export function isCreditAnomalous(credit: number): boolean {
  if (!Number.isFinite(credit)) return true;
  if (credit < 0) return true;
  if (credit > CREDIT_SANITY_CAP) return true;
  return false;
}

/** Input shape accepted by writeClickHouse / buildClickHouseRow. */
export interface ClickHouseWriteEntry {
  timestamp: string;
  event: string;
  modelId: string;
  /** User identifier: user_id from auth/verify when enabled, or SHA-256(apiKey)[:8] fallback. */
  keyId: string;
  sessionKey?: string;
  turnSeq?: number;
  userInput?: string;
  upstreamUrl: string;
  stream: boolean;
  usage?: Record<string, unknown>;
  routedFrom?: string;
  /** Space/tenant ID extracted from /proxy/<spaceId>/... path. */
  spaceId?: string;
  /**
   * Upstream request id — 来自上游响应 header `x-request-id`（tokenhub 等
   * OpenAI/Anthropic 兼容网关会返回）。缺失时上游没返回或读取失败，落表为 ""。
   * 用于跨系统追溯：客户端拿到的 x-request-id → 我方 usage_logs.upstream_request_id
   * → 上游服务日志。
   */
  upstreamRequestId?: string;
  /**
   * Opaque scalar counters from the optional request-preparation stage
   * (cost-guard). `preCompressTokens` / `postCompressTokens` feed the three
   * compression columns; the rest is carried to the JSONL log untouched.
   */
  extensionStats?: Record<string, unknown>;
  /** Pricing config for credit calculation (from config.yaml). */
  pricingConfig?: CreditPricingConfig;
}

/**
 * Compute expected credit saved by routing to a different model.
 * Only applies when event='usage' AND routed_from is non-empty.
 * credit_saved = credit_if_original_model - actual_credit
 */
function computeCreditSaved(
  entry: ClickHouseWriteEntry,
  usage: Record<string, unknown>,
): number {
  // Only for main usage events with routing
  if (entry.event !== "usage") return 0;
  if (!entry.routedFrom) return 0;

  // Compute what credit would have been if using the original model
  const creditIfOriginal = computeCreditDelta(
    usage,
    entry.pricingConfig,
    entry.routedFrom,
    entry.upstreamUrl,
  );
  // Actual credit (using the routed model)
  const actualCredit = computeCreditDelta(
    usage,
    entry.pricingConfig,
    entry.modelId,
    entry.upstreamUrl,
  );

  const saved = creditIfOriginal - actualCredit;
  return saved > 0 ? saved : 0;
}

/**
 * Read the compression token pair out of extensionStats.
 *
 * Both columns are written together or not at all: a post without a pre has no
 * denominator and would read as a 100% saving. Anything missing or non-finite
 * means the stage produced no measurement, which is recorded as three zeros
 * rather than a guess.
 */
function computeCompressTokens(
  extensionStats: Record<string, unknown> | undefined,
): { pre: number; post: number; saved: number } {
  const none = { pre: 0, post: 0, saved: 0 };
  if (!extensionStats) return none;
  const pre = extensionStats.preCompressTokens;
  const post = extensionStats.postCompressTokens;
  if (typeof pre !== "number" || typeof post !== "number") return none;
  if (!Number.isFinite(pre) || !Number.isFinite(post)) return none;
  if (pre < 0 || post < 0) return none;
  const saved = pre - post;
  return {
    pre: Math.floor(pre),
    post: Math.floor(post),
    saved: saved > 0 ? Math.floor(saved) : 0,
  };
}

/**
 * Pure mapper: usage log entry → ClickHouse row.
 * Returns null for error records (4xx/5xx upstream errors carry no real usage).
 * Parses cache tokens across Anthropic / OpenAI / DeepSeek usage formats.
 * Exported for unit testing.
 */
export function buildClickHouseRow(entry: ClickHouseWriteEntry): ClickHouseRow | null {
  const usage = entry.usage ?? {};
  if (usage.error) return null;

  const promptDetails = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  const cacheCreation = usage.cache_creation as Record<string, unknown> | undefined;
  const cacheHit =
    num(usage.prompt_cache_hit_tokens) ||
    num(usage.cache_read_input_tokens) ||
    num(promptDetails?.cached_tokens);
  const cacheMiss = num(usage.prompt_cache_miss_tokens);
  const cacheWrite =
    num(usage.prompt_cache_write_tokens) ||
    num(usage.cache_creation_input_tokens);

  // prompt_tokens 语义：总输入（含缓存）
  //   - OpenAI / DeepSeek: 直接取 usage.prompt_tokens
  //   - TokenHub Anthropic: usage.input_tokens 已排除 cache，需加回 cache_hit + cache_write
  //     才能得到总输入
  const inputTokens = num(usage.input_tokens);
  const promptTokens =
    num(usage.prompt_tokens) || (inputTokens + cacheHit + cacheWrite);
  const completionTokens = num(usage.completion_tokens) || num(usage.output_tokens);
  // total_tokens 语义：总 token = 输入 + 输出。
  //   - OpenAI / DeepSeek: 上游已给 usage.total_tokens，直接采用
  //   - TokenHub Anthropic: 上游无 total_tokens 字段，回退为 promptTokens + completionTokens
  //     （promptTokens 已是含缓存的总输入）
  const totalTokens = num(usage.total_tokens) || (promptTokens + completionTokens);

  const compressTokens = computeCompressTokens(entry.extensionStats);

  return {
    timestamp: toChTimestamp(entry.timestamp),
    event: entry.event,
    session_key: entry.sessionKey ?? "",
    turn_seq: entry.turnSeq ?? 0,
    user_input: entry.userInput ?? "",
    model_id: entry.modelId,
    model_name: resolveModelName(entry.pricingConfig, entry.modelId),
    user_id: entry.keyId,
    upstream_url: entry.upstreamUrl,
    stream: entry.stream ? 1 : 0,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    cache_hit_tokens: cacheHit,
    cache_miss_tokens: cacheMiss,
    cache_write_tokens: cacheWrite,
    // TokenHub Anthropic 原样字段 —— 不与其他格式合并
    input_tokens: inputTokens,
    cache_creation_ephemeral_5m_input_tokens: num(cacheCreation?.ephemeral_5m_input_tokens),
    cache_creation_ephemeral_1h_input_tokens: num(cacheCreation?.ephemeral_1h_input_tokens),
    credit: computeCreditDelta(usage, entry.pricingConfig, entry.modelId, entry.upstreamUrl),
    credit_saved: computeCreditSaved(entry, usage),
    routed_from: entry.routedFrom ?? "",
    space_id: entry.spaceId ?? "",
    source_tag: "proxy",
    host: HOST_ID,
    upstream_request_id: entry.upstreamRequestId ?? "",
    compress_tokens_saved: compressTokens.saved,
    pre_compress_tokens: compressTokens.pre,
    post_compress_tokens: compressTokens.post,
  };
}

/**
 * Determine if usage should be written to the raw traceability table.
 *
 * Returns the reason string when the usage should be captured raw:
 *   - 'non_tokenhub'    — upstream URL does not contain "tokenhub"
 *   - 'unknown_model'   — TokenHub but model is not in the pricing table
 *   - 'invalid_format'  — TokenHub but usage lacks input/output fields
 *   - 'invalid_credit'  — TokenHub with valid format & known model, but the
 *                         computed credit is anomalous (NaN/Inf/negative/>1e6),
 *                         indicating a bug in pricing config or upstream payload
 * Returns `null` for normal, recognized TokenHub usage (no raw record needed).
 *
 * Priority (short-circuit): non_tokenhub → unknown_model → invalid_format → invalid_credit → null
 *
 * Exported for unit testing.
 */
export function getRawUsageReason(
  upstreamUrl: string,
  usage: Record<string, unknown> | null | undefined,
  pricingConfig: CreditPricingConfig | null | undefined,
  modelId?: string,
): string | null {
  if (!usage || Object.keys(usage).length === 0) return null;

  // Non-TokenHub → always write raw
  if (!/tokenhub/i.test(upstreamUrl)) return "non_tokenhub";

  // TokenHub but model not in pricing table
  if (modelId && pricingConfig && !getModelPricing(pricingConfig, modelId)) {
    return "unknown_model";
  }

  // TokenHub but missing expected fields
  const hasInput =
    typeof usage.input_tokens === "number" || typeof usage.prompt_tokens === "number";
  const hasOutput =
    typeof usage.output_tokens === "number" || typeof usage.completion_tokens === "number";
  if (!hasInput || !hasOutput) return "invalid_format";

  // TokenHub, valid format, known model — but credit calculation produced anomalous value.
  // We recompute here (not passed in) to keep this function callable from writeClickHouse
  // without threading the credit through. Extra compute is cheap (< 1μs).
  const credit = computeCreditDelta(usage, pricingConfig, modelId, upstreamUrl);
  if (isCreditAnomalous(credit)) return "invalid_credit";

  return null; // Normal TokenHub usage, no need for raw table
}

/** Pure mapper: usage log entry + reason → raw usage row. Exported for unit testing. */
export function buildRawUsageRow(
  entry: ClickHouseWriteEntry,
  reason: string,
): ClickHouseRawUsageRow {
  return {
    timestamp: toChTimestamp(entry.timestamp),
    model_id: entry.modelId,
    model_name: resolveModelName(entry.pricingConfig, entry.modelId),
    key_id: entry.keyId,          // 老列兼容（老 usage_raw 表仍以 key_id 作为主键的一部分）
    user_id: entry.keyId,          // 新列（与主表统一）；双写靠 JSONEachRow 容错
    session_key: entry.sessionKey ?? "",
    turn_seq: entry.turnSeq ?? 0,
    user_input: entry.userInput ?? "",
    upstream_url: entry.upstreamUrl,
    stream: entry.stream ? 1 : 0,
    usage: JSON.stringify(entry.usage ?? {}),
    reason,
    routed_from: entry.routedFrom ?? "",
    space_id: entry.spaceId ?? "",
    source_tag: "proxy",
    host: HOST_ID,
    upstream_request_id: entry.upstreamRequestId ?? "",
  };
}

/**
 * Pure mapper: build a raw-table row for a **failed credit report** scenario.
 *
 * Reason is fixed to `"report_failed"`. The error detail (HTTP status / timeout
 * / upstream code message) is embedded into the usage JSON under a meta field
 * `__report_error`, so the raw table's `usage` column self-contains everything
 * an ops user needs to reconstruct the failure without a JOIN.
 *
 * Row shape is identical to `buildRawUsageRow` output, allowing it to be
 * appended to the same `usage_raw` table and flushed by `flushRaw`.
 */
export function buildFailedReportRawRow(
  entry: ClickHouseWriteEntry,
  errorDetail: string,
): ClickHouseRawUsageRow {
  const usageWithError = {
    ...(entry.usage ?? {}),
    __report_error: errorDetail,
  };
  return {
    timestamp: toChTimestamp(entry.timestamp),
    model_id: entry.modelId,
    model_name: resolveModelName(entry.pricingConfig, entry.modelId),
    key_id: entry.keyId,
    user_id: entry.keyId,
    session_key: entry.sessionKey ?? "",
    turn_seq: entry.turnSeq ?? 0,
    user_input: entry.userInput ?? "",
    upstream_url: entry.upstreamUrl,
    stream: entry.stream ? 1 : 0,
    usage: JSON.stringify(usageWithError),
    reason: "report_failed",
    routed_from: entry.routedFrom ?? "",
    space_id: entry.spaceId ?? "",
    source_tag: "proxy",
    host: HOST_ID,
    upstream_request_id: entry.upstreamRequestId ?? "",
  };
}

/**
 * Enqueue a "credit report failed" raw record to the traceability table.
 *
 * Fire-and-forget: never throws, no-op when ClickHouse disabled or `rawTable`
 * not configured. Uses the same `rawBuffer` and `flushRaw` machinery as
 * `writeClickHouse`, so retries/overflow protection apply automatically.
 *
 * Call from handlers when `tryReportCreditFromPath` returns `attempted && !ok`.
 */
export function writeFailedReportRaw(
  entry: ClickHouseWriteEntry,
  errorDetail: string,
): void {
  if (disabled || !config || !config.rawTable) return;
  try {
    rawBuffer.push(buildFailedReportRawRow(entry, errorDetail));
    if (rawBuffer.length >= (config?.flushThreshold ?? 50)) {
      void flushRaw();
    }
  } catch {
    // Silent — never block business logic.
  }
}

/**
 * Write a usage log entry to ClickHouse (buffered, async).
 * Fire-and-forget — never throws.
 */
export function writeClickHouse(entry: ClickHouseWriteEntry): void {
  if (disabled || !config) return;

  try {
    // Raw usage traceability (only when rawTable is configured).
    if (config.rawTable) {
      const rawReason = getRawUsageReason(
        entry.upstreamUrl,
        entry.usage,
        entry.pricingConfig,
        entry.modelId,
      );
      if (rawReason) {
        rawBuffer.push(buildRawUsageRow(entry, rawReason));
        if (rawBuffer.length >= (config?.flushThreshold ?? 50)) {
          void flushRaw();
        }
      }
    }

    const row = buildClickHouseRow(entry);
    if (!row) return;

    buffer.push(row);

    if (buffer.length >= (config?.flushThreshold ?? 50)) {
      void flush();
    }
  } catch {
    // Silent — never block business logic.
  }
}

/** Re-enqueue failed rows for retry, capping buffer to prevent unbounded growth. */
function requeue(rows: ClickHouseRow[]): void {
  buffer.unshift(...rows);
  if (buffer.length > 10000) {
    const dropped = buffer.length - 5000;
    buffer = buffer.slice(buffer.length - 5000);
    log.warn("clickhouse.buffer.overflow", { dropped });
  }
}

/** Re-enqueue failed raw rows for retry, capping buffer to prevent unbounded growth. */
function requeueRaw(rows: ClickHouseRawUsageRow[]): void {
  rawBuffer.unshift(...rows);
  if (rawBuffer.length > 10000) {
    const dropped = rawBuffer.length - 5000;
    rawBuffer = rawBuffer.slice(rawBuffer.length - 5000);
    log.warn("clickhouse.rawBuffer.overflow", { dropped });
  }
}

/**
 * Flush buffered rows to ClickHouse.
 * Returns a promise; callers may ignore it for fire-and-forget.
 */
export async function flush(): Promise<void> {
  if (!config || !client || buffer.length === 0) return;

  const rows = buffer.splice(0);
  try {
    await client.insert({
      table: config.table,
      values: rows,
      format: "JSONEachRow",
      clickhouse_settings: { async_insert: 1, wait_for_async_insert: 1 },
    });
    log.debug("clickhouse.flush.ok", { rows: rows.length });
  } catch (err: unknown) {
    log.error(
      "clickhouse.flush.error",
      { rows: rows.length },
      err instanceof Error ? err : new Error(String(err)),
    );
    requeue(rows);
  }
}

/**
 * Flush buffered raw usage rows to ClickHouse.
 * Returns a promise; callers may ignore it for fire-and-forget.
 */
export async function flushRaw(): Promise<void> {
  if (!config || !client || !config.rawTable || rawBuffer.length === 0) return;

  const rows = rawBuffer.splice(0);
  try {
    await client.insert({
      table: config.rawTable,
      values: rows,
      format: "JSONEachRow",
      clickhouse_settings: { async_insert: 1, wait_for_async_insert: 1 },
    });
    log.debug("clickhouse.flushRaw.ok", { rows: rows.length });
  } catch (err: unknown) {
    log.error(
      "clickhouse.flushRaw.error",
      { rows: rows.length },
      err instanceof Error ? err : new Error(String(err)),
    );
    requeueRaw(rows);
  }
}

/**
 * Graceful shutdown: stop timer, flush remaining buffer, close client.
 */
export async function shutdownClickHouse(): Promise<void> {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  await flush();
  await flushRaw();
  // Internal telemetry buffers (see §7.1)
  await flushSessionInit().catch(() => {});
  await flushToolCall().catch(() => {});
  if (client) {
    await client.close().catch(() => {});
    client = null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Internal Usage Telemetry — 团队记忆内部使用埋点
// 详见 docs/design/2026-08-03-internal-usage-telemetry-plan.md
//
// 两张新表：session_init_logs / tool_call_logs
// 三个通用 helper：createTableIfNotExists / enqueueRow / flushBuffer /
//                requeueWithOverflowGuard
//
// 硬约束（§7.-1）：
//   1. 所有 write*Row 同步返回 void，绝不 throw
//   2. 内部 helper 也不 throw（enqueueRow 除了阈值触发 flush 外全静默）
//   3. 老代码路径 (writeClickHouse/flush/writeFailedReportRaw) 一行不动
// ════════════════════════════════════════════════════════════════════════════

// ── §9 决策常量 ─────────────────────────────────────────────────────────────

/** request_body 截断长度（与 usage_logs.user_input 同口径） */
const TOOL_CALL_BODY_MAX_BYTES = 512;
/** bypass_reason 截断长度（防止 log 文案改动导致列基数爆炸） */
const BYPASS_REASON_MAX_CHARS = 128;
/** reject_reason 截断长度（与 bypass_reason 对称；LowCardinality 保基数稳） */
const REJECT_REASON_MAX_CHARS = 128;
/** 表名（DDL + insert 共用） */
const SESSION_INIT_TABLE = "session_init_logs";
const TOOL_CALL_TABLE = "tool_call_logs";
/** TTL（天）—— 内部观测 90 天足够 */
const TELEMETRY_TTL_DAYS = 90;

// ── 类型定义 ────────────────────────────────────────────────────────────────

/** 埋点点位传入的 session_init 行输入（构造 row 前的原始形态）。 */
export interface SessionInitLogInput {
  /** ISO 8601 UTC 时间字符串（`new Date().toISOString()`） */
  timestamp: string;
  /** proxy 会话隔离键（compositeKey / x-conversation-id 兜底） */
  sessionKey: string;
  /** kernel tenant / instance ID（来自 sessionInfo.space_id） */
  spaceId?: string;
  /** 用户/团队/agent ID（bypass 时可能为空） */
  userId?: string;
  teamId?: string;
  agentId?: string;
  /** "claude-code" | "codebuddy" */
  agentSource: string;
  /** state.bypassed 的实际值 */
  bypassed: boolean;
  /** init.ts 里 log 原文首句（会被截断到 128 字符） */
  bypassReason: string;
  /** 恒为 "initialized"，未来若加更多终态可扩展 */
  finalStatus: string;
}

/** ClickHouse `session_init_logs` 表一行的最终形态。 */
export interface SessionInitLogRow {
  timestamp: string;
  session_key: string;
  space_id: string;
  user_id: string;
  team_id: string;
  agent_id: string;
  agent_source: string;
  bypassed: number;
  bypass_reason: string;
  final_status: string;
  source_tag: string;
  host: string;
}

/** 埋点点位传入的 tool_call 行输入。 */
export interface ToolCallLogInput {
  timestamp: string;
  sessionKey: string;
  turnSeq?: number;
  spaceId?: string;
  userId?: string;
  teamId?: string;
  agentId?: string;
  agentSource: string;
  /** 'model_intent' | 'bridge_call' */
  kind: string;
  /** 'memory-bridge' | 'skill-bridge' | ''（意图侧留空） */
  bridgeSource?: string;
  /** 模型 SSE 里的 function.name / tool_use.name（bridge_call 侧留空） */
  initiatedTool?: string;
  /** bridge 转发的 sub 字符串，如 "atomic/search"（意图侧留空） */
  executedEndpoint: string;
  /** 已脱敏的 body 内容（会被截断到 512 字节） */
  requestBody: string;
  /** upstream HTTP 状态（意图侧填 0） */
  upstreamStatus?: number;
  /** upstream 耗时毫秒（意图侧填 0） */
  elapsedMs?: number;
  /**
   * 前置校验失败原因（proxy 层拒绝了请求, 没能打到上游）。
   * 空串 = 请求进入了 upstream fetch 阶段（成功或 4xx/5xx 都走此路径）。
   * 非空 = 前置早退（枚举: unknown_path / subpath_forbidden / method_not_allowed /
   * content_type_invalid / missing_conversation_id / session_not_initialized /
   * write_ops_disabled / body_not_object / invalid_json_body）。
   * 与 session_init.bypass_reason 对称, 均截断到 REJECT_REASON_MAX_CHARS。
   */
  rejectReason?: string;
}

/** ClickHouse `tool_call_logs` 表一行的最终形态。 */
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
  reject_reason: string;
  source_tag: string;
  host: string;
}

// ── Pure builders（无副作用，可单测） ───────────────────────────────────────

/** 计算 body 的 sha256 前 16 hex 字符（TopN GROUP BY 去重用）。空 body 返回空串。 */
function bodyHash16(body: string): string {
  if (!body) return "";
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

/** 构造 session_init 行；纯函数便于测试。 */
export function buildSessionInitLogRow(input: SessionInitLogInput): SessionInitLogRow {
  const reason = (input.bypassReason ?? "").slice(0, BYPASS_REASON_MAX_CHARS);
  return {
    timestamp: toChTimestamp(input.timestamp),
    session_key: input.sessionKey ?? "",
    space_id: input.spaceId ?? "",
    user_id: input.userId ?? "",
    team_id: input.teamId ?? "",
    agent_id: input.agentId ?? "",
    agent_source: input.agentSource,
    bypassed: input.bypassed ? 1 : 0,
    bypass_reason: reason,
    final_status: input.finalStatus,
    source_tag: "proxy",
    host: HOST_ID,
  };
}

/** 构造 tool_call 行；纯函数便于测试。 */
export function buildToolCallLogRow(input: ToolCallLogInput): ToolCallLogRow {
  const body = (input.requestBody ?? "").slice(0, TOOL_CALL_BODY_MAX_BYTES);
  return {
    timestamp: toChTimestamp(input.timestamp),
    session_key: input.sessionKey ?? "",
    turn_seq: input.turnSeq ?? 0,
    space_id: input.spaceId ?? "",
    user_id: input.userId ?? "",
    team_id: input.teamId ?? "",
    agent_id: input.agentId ?? "",
    agent_source: input.agentSource,
    kind: input.kind,
    bridge_source: input.bridgeSource ?? "",
    initiated_tool: input.initiatedTool ?? "",
    executed_endpoint: input.executedEndpoint,
    request_body: body,
    request_body_hash: bodyHash16(body),
    upstream_status: input.upstreamStatus ?? 0,
    elapsed_ms: input.elapsedMs ?? 0,
    reject_reason: (input.rejectReason ?? "").slice(0, REJECT_REASON_MAX_CHARS),
    source_tag: "proxy",
    host: HOST_ID,
  };
}

// ── 通用 helper（三个薄函数替代复制粘贴模板） ──────────────────────────────

/**
 * 转发 DDL 到 client.command。抽出以消除
 * `client.command({ query, clickhouse_settings: { wait_end_of_query: 1 } })`
 * 的模板重复。异常向上抛，让 ensureClickHouse 记录到启动日志。
 */
export async function createTableIfNotExists(
  ch: ClickHouseClient,
  ddl: string,
): Promise<void> {
  await ch.command({
    query: ddl,
    clickhouse_settings: { wait_end_of_query: 1 },
  });
}

/**
 * 通用入队 + 阈值触发 flush（fire-and-forget）。
 *
 * - 内部两层 try/catch：一层 push 兜底，一层 flushFn 抛（异步 Promise 不 await）。
 * - 绝不向调用方 throw。
 */
export function enqueueRow<T>(
  buf: T[],
  row: T,
  flushFn: () => Promise<void>,
  threshold: number,
): void {
  try {
    buf.push(row);
    if (buf.length >= threshold) {
      // fire-and-forget；错误在 flushBuffer 里已 log，同时用 .catch() 兜底
      void flushFn().catch(() => { /* never throw */ });
    }
  } catch {
    // 极端情况：buffer 本身坏了 —— 保持业务链路不受影响
  }
}

/**
 * 通用 flush：排空 buffer → 批量 insert → 失败调 requeueFn。
 *
 * - client 为 null / buf 为空时 no-op
 * - 成功后 buf 已被 splice(0) 空掉
 * - 失败时 rows 已从 buf 取出 → 交给 requeueFn；异常 log.error 后 resolve（不 reject）
 */
export async function flushBuffer<T>(
  buf: T[],
  ch: ClickHouseClient | null,
  tableName: string,
  requeueFn: (rows: T[]) => void,
  logLabel: string,
): Promise<void> {
  if (!ch || buf.length === 0) return;
  const rows = buf.splice(0);
  try {
    await ch.insert({
      table: tableName,
      values: rows,
      format: "JSONEachRow",
      clickhouse_settings: { async_insert: 1, wait_for_async_insert: 1 },
    });
    log.debug(`${logLabel}.flush.ok`, { rows: rows.length });
  } catch (err: unknown) {
    log.error(
      `${logLabel}.flush.error`,
      { rows: rows.length },
      err instanceof Error ? err : new Error(String(err)),
    );
    try {
      requeueFn(rows);
    } catch {
      // requeue 也炸 → 只能丢；至少不 rethrow 拖垮业务
    }
  }
}

/**
 * 重排队 + overflow 保护：buffer 超过 10_000 时丢弃最早的一半保留 5_000。
 *
 * 返回值是新的 buffer 引用（可能与传入的是同一个数组，也可能是切片后的新数组）。
 * 调用方需将返回值赋回自己的 buffer 变量。
 */
export function requeueWithOverflowGuard<T>(
  buf: T[],
  failedRows: T[],
  logLabel: string,
): T[] {
  try {
    buf.unshift(...failedRows);
    if (buf.length > 10000) {
      const dropped = buf.length - 5000;
      const trimmed = buf.slice(buf.length - 5000);
      log.warn(logLabel, { dropped });
      return trimmed;
    }
    return buf;
  } catch {
    return buf;
  }
}

// ── Session Init writer ─────────────────────────────────────────────────────

let sessionInitBuffer: SessionInitLogRow[] = [];

function requeueSessionInit(rows: SessionInitLogRow[]): void {
  sessionInitBuffer = requeueWithOverflowGuard(
    sessionInitBuffer,
    rows,
    "clickhouse.sessionInit.overflow",
  );
}

async function flushSessionInit(): Promise<void> {
  await flushBuffer(
    sessionInitBuffer,
    client,
    SESSION_INIT_TABLE,
    requeueSessionInit,
    "clickhouse.sessionInit",
  );
}

/**
 * 写一条 session_init 记录（fire-and-forget，绝不抛）。
 * CH 未启用/未初始化时 no-op；构造异常静默吞掉。
 */
export function writeSessionInitRow(input: SessionInitLogInput): void {
  if (disabled || !config) return;
  try {
    const row = buildSessionInitLogRow(input);
    enqueueRow(
      sessionInitBuffer,
      row,
      flushSessionInit,
      config?.flushThreshold ?? 50,
    );
  } catch {
    // 绝不阻塞业务
  }
}

// ── Tool Call writer ────────────────────────────────────────────────────────

let toolCallBuffer: ToolCallLogRow[] = [];

function requeueToolCall(rows: ToolCallLogRow[]): void {
  toolCallBuffer = requeueWithOverflowGuard(
    toolCallBuffer,
    rows,
    "clickhouse.toolCall.overflow",
  );
}

async function flushToolCall(): Promise<void> {
  await flushBuffer(
    toolCallBuffer,
    client,
    TOOL_CALL_TABLE,
    requeueToolCall,
    "clickhouse.toolCall",
  );
}

/**
 * 写一条 tool_call 记录（fire-and-forget，绝不抛）。
 * CH 未启用/未初始化时 no-op；构造异常静默吞掉。
 */
export function writeToolCallRow(input: ToolCallLogInput): void {
  if (disabled || !config) return;
  try {
    const row = buildToolCallLogRow(input);
    enqueueRow(
      toolCallBuffer,
      row,
      flushToolCall,
      config?.flushThreshold ?? 50,
    );
  } catch {
    // 绝不阻塞业务
  }
}

// ── DDL 常量（在 ensureClickHouse 追加调用 createTableIfNotExists） ────────

/** session_init_logs 的 DDL（内部使用埋点 §3.1） */
export function sessionInitTableDdl(): string {
  const ttlClause = TELEMETRY_TTL_DAYS > 0
    ? `TTL toDateTime(timestamp) + INTERVAL ${TELEMETRY_TTL_DAYS} DAY`
    : "";
  return [
    `CREATE TABLE IF NOT EXISTS ${SESSION_INIT_TABLE} (`,
    "  timestamp DateTime64(3, 'Asia/Shanghai'),",
    "  session_key String,",
    "  space_id String,",
    "  user_id String,",
    "  team_id String,",
    "  agent_id String,",
    "  agent_source LowCardinality(String),",
    "  bypassed UInt8,",
    "  bypass_reason String,",
    "  final_status LowCardinality(String),",
    "  source_tag LowCardinality(String) DEFAULT 'proxy',",
    "  host LowCardinality(String)",
    ") ENGINE = MergeTree()",
    "ORDER BY (space_id, timestamp)",
    ttlClause,
  ].filter(Boolean).join("\n");
}

/** tool_call_logs 的 DDL（内部使用埋点 §3.2） */
export function toolCallTableDdl(): string {
  const ttlClause = TELEMETRY_TTL_DAYS > 0
    ? `TTL toDateTime(timestamp) + INTERVAL ${TELEMETRY_TTL_DAYS} DAY`
    : "";
  return [
    `CREATE TABLE IF NOT EXISTS ${TOOL_CALL_TABLE} (`,
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
    // proxy 前置校验失败原因; 上游已响应/异常时为空串; 与 session_init.bypass_reason 对称。
    "  reject_reason LowCardinality(String) DEFAULT '',",
    "  source_tag LowCardinality(String) DEFAULT 'proxy',",
    "  host LowCardinality(String)",
    ") ENGINE = MergeTree()",
    "ORDER BY (space_id, session_key, timestamp)",
    ttlClause,
  ].filter(Boolean).join("\n");
}

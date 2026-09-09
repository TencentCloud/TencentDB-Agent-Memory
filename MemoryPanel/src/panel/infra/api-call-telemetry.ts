/**
 * Panel API 调用审计 — 可选 ClickHouse 上报。
 *
 * - enabled=false 或 url 为空 → 返回 NoOp 实例，零开销零副作用
 * - enabled=true + 有效 url → 连接 CH，自动建表 + schema 自愈，缓冲批量写入
 * - 写失败不阻塞请求，重入队 + 溢出保护
 *
 * ## Schema 自愈（动态字段）
 * 每次启动 initialize() 里 ensureSchema() 会：
 *   1. `DESCRIBE {table}` 拿现有列
 *   2. 对比 EXPECTED_COLUMNS 补齐缺失列（ALTER ADD COLUMN IF NOT EXISTS）
 *   3. ALTER 在 CH 是轻量元数据变更，秒级完成，不重写数据
 * 以后新增字段只需 append 一行到 EXPECTED_COLUMNS，重启自动生效。
 *
 * ## 历史 user_id 回填
 * initialize() 后异步跑 maybeBackfillUserId()：
 *   - telemetry_meta 表记录 backfill_version_user_id
 *   - 版本落后于 CURRENT_BACKFILL_VERSION 才跑
 *   - 扫 DISTINCT user_key WHERE user_id='' → 逐个查缓存 → ALTER TABLE UPDATE
 *   - 完成后写版本号，下次启动 skip
 *
 * 参照 MemoryKnowledge/src/clickhouse-telemetry.ts 的 raw fetch 模式，无外部依赖。
 */

import type { PanelClickHouseConfig } from '../config/panel-config.js';
import type { Logger } from './logger.js';
import type { PanelUserIdResolver, UserIdResolveCtx } from './user-id-resolver.js';

// ── 数据行 ──────────────────────────────────────────────────────────────────

export interface ApiCallLogRow {
  timestamp: string;
  instance_id: string;
  user_key: string;
  user_id: string;
  endpoint: string;
  http_method: string;
  http_status: number;
  duration_ms: number;
  request_id: string;
  host: string;
}

// ── Schema 自愈 ─────────────────────────────────────────────────────────────

/**
 * 表期望列清单。ensureSchema 会跟 DESCRIBE 结果对比，缺啥补啥。
 * **新增字段只需 append 一行**：写清 name + ddl 片段（不含逗号），
 * ensureSchema 会拼成 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS <name> <ddl>`。
 */
export const EXPECTED_COLUMNS: Array<{ name: string; ddl: string }> = [
  // user_id 从表初版就在，列出来是为了防漏；ensureSchema 已存在时跳过
  { name: 'user_id', ddl: "String DEFAULT ''" },
];

/** telemetry_meta(key, value) 里存的 user_id 回填当前版本号。bump 后重跑一次。 */
const CURRENT_BACKFILL_VERSION = '1';
const BACKFILL_VERSION_KEY = 'backfill_version_user_id';

// ── 接口 ────────────────────────────────────────────────────────────────────

export interface PanelApiCallTelemetry {
  /** 建表（幂等）+ schema 自愈 + 启动定时 flush。非阻塞，失败只 warn。 */
  initialize(): Promise<void>;
  /**
   * 建表 + schema 自愈完成后，可选后台跑历史 user_id 回填。
   * 独立方法便于测试；main() 在 initialize 后 fire-and-forget 调一次。
   */
  runBackfillIfNeeded(resolver: PanelUserIdResolver): Promise<void>;
  /** 记录一行。同步、不阻塞、不抛异常。 */
  record(row: ApiCallLogRow): void;
  /** 优雅关闭：flush 剩余 + 清 timer。 */
  shutdown(): Promise<void>;
}

// ── NoOp 实现 ───────────────────────────────────────────────────────────────

class DisabledPanelApiCallTelemetry implements PanelApiCallTelemetry {
  async initialize(): Promise<void> { /* noop */ }
  async runBackfillIfNeeded(_resolver: PanelUserIdResolver): Promise<void> { /* noop */ }
  record(_row: ApiCallLogRow): void { /* noop */ }
  async shutdown(): Promise<void> { /* noop */ }
}

// ── ClickHouse 实现 ─────────────────────────────────────────────────────────

const MAX_BUFFER_ROWS = 10_000;
const RETAINED_BUFFER_ROWS = 5_000;

class ClickHousePanelApiCallTelemetry implements PanelApiCallTelemetry {
  private buffer: ApiCallLogRow[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;
  private initialized = false;

  constructor(
    private readonly config: PanelClickHouseConfig,
    private readonly logger: Logger,
    private readonly instanceCtxProvider: (instanceId: string) => UserIdResolveCtx | null,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async initialize(): Promise<void> {
    try {
      await this.ensureTable();
      await this.ensureSchema();
      await this.ensureMetaTable();
      this.initialized = true;
      this.timer = setInterval(() => void this.flush(), this.config.flushIntervalMs);
      this.timer.unref();
      this.logger.info('[api-call-telemetry] initialized', {
        database: this.config.database,
        table: this.config.table,
      });
    } catch (err) {
      this.logger.warn('[api-call-telemetry] initialize failed (telemetry disabled)', {
        error: (err as Error).message,
      });
    }
  }

  async runBackfillIfNeeded(resolver: PanelUserIdResolver): Promise<void> {
    if (!this.initialized) return;
    try {
      const done = await this.readMeta(BACKFILL_VERSION_KEY);
      if (done === CURRENT_BACKFILL_VERSION) {
        this.logger.debug('[api-call-telemetry] user_id backfill already done', {
          version: done,
        });
        return;
      }
      this.logger.info('[api-call-telemetry] starting user_id backfill', {
        currentVersion: done ?? '(none)',
        targetVersion: CURRENT_BACKFILL_VERSION,
      });
      const changed = await this.backfillUserIds(resolver);
      await this.writeMeta(BACKFILL_VERSION_KEY, CURRENT_BACKFILL_VERSION);
      this.logger.info('[api-call-telemetry] user_id backfill done', {
        version: CURRENT_BACKFILL_VERSION,
        userKeysMigrated: changed,
      });
    } catch (err) {
      this.logger.warn('[api-call-telemetry] user_id backfill failed', {
        error: (err as Error).message,
      });
    }
  }

  record(row: ApiCallLogRow): void {
    if (!this.initialized) return;
    try {
      this.buffer.push(row);
      if (this.buffer.length > MAX_BUFFER_ROWS) {
        this.buffer = this.buffer.slice(-RETAINED_BUFFER_ROWS);
      }
      if (this.buffer.length >= this.config.flushThreshold) {
        void this.flush();
      }
    } catch {
      // 永不抛——审计不能影响业务
    }
  }

  async shutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
    // flush 期间可能有新行入队
    if (this.buffer.length > 0) {
      await this.flush();
    }
  }

  // ── 内部 ──

  private async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.buffer.length === 0) return;
    this.flushing = this.doFlush();
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
  }

  private async doFlush(): Promise<void> {
    const rows = this.buffer.splice(0);
    if (rows.length === 0) return;
    try {
      await this.insertRows(rows);
    } catch (err) {
      this.logger.warn('[api-call-telemetry] flush failed, requeuing', {
        error: (err as Error).message,
        dropped: rows.length,
      });
      // 重入队到头部
      this.buffer.unshift(...rows);
      if (this.buffer.length > MAX_BUFFER_ROWS) {
        this.buffer = this.buffer.slice(-RETAINED_BUFFER_ROWS);
      }
    }
  }

  private async insertRows(rows: ApiCallLogRow[]): Promise<void> {
    const payload = rows.map((r) => JSON.stringify(r)).join('\n');
    const qualifiedTable = `${this.config.database}.${this.config.table}`;
    await this.executeQuery(
      `INSERT INTO ${qualifiedTable} FORMAT JSONEachRow`,
      payload,
    );
  }

  private async ensureTable(): Promise<void> {
    const ttlClause = this.config.ttlDays > 0
      ? `TTL toDateTime(timestamp) + INTERVAL ${this.config.ttlDays} DAY`
      : '';

    const ddl = [
      `CREATE TABLE IF NOT EXISTS ${this.config.database}.${this.config.table} (`,
      "  timestamp DateTime64(3, 'Asia/Shanghai'),",
      '  instance_id String,',
      '  user_key String,',
      "  user_id String DEFAULT '',",
      '  endpoint String,',
      '  http_method LowCardinality(String),',
      '  http_status UInt16 DEFAULT 0,',
      '  duration_ms UInt32 DEFAULT 0,',
      '  request_id String,',
      '  host LowCardinality(String)',
      ') ENGINE = MergeTree()',
      'ORDER BY (instance_id, timestamp)',
      ttlClause,
    ].filter(Boolean).join('\n');

    await this.executeQuery(ddl);
  }

  /**
   * Schema 自愈：对齐 EXPECTED_COLUMNS 与线上表实际列，缺啥补啥。
   * 用于处理老实例可能缺新字段的情况——未来加字段只 append EXPECTED_COLUMNS 即可。
   */
  private async ensureSchema(): Promise<void> {
    const existing = await this.queryExistingColumns();
    for (const col of EXPECTED_COLUMNS) {
      if (existing.has(col.name)) continue;
      const alter = `ALTER TABLE ${this.config.database}.${this.config.table} ` +
        `ADD COLUMN IF NOT EXISTS ${col.name} ${col.ddl}`;
      try {
        await this.executeQuery(alter);
        this.logger.info('[api-call-telemetry] added column', {
          column: col.name,
          ddl: col.ddl,
        });
      } catch (err) {
        // ALTER 失败只 warn 不停：可能是权限/版本差异，不影响 INSERT
        this.logger.warn('[api-call-telemetry] add column failed', {
          column: col.name,
          error: (err as Error).message,
        });
      }
    }
  }

  private async queryExistingColumns(): Promise<Set<string>> {
    const sql = `SELECT name FROM system.columns ` +
      `WHERE database = '${this.config.database}' AND table = '${this.config.table}' ` +
      `FORMAT JSONEachRow`;
    const text = await this.queryText(sql);
    const cols = new Set<string>();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { name?: string };
        if (row.name) cols.add(row.name);
      } catch {
        // ignore malformed lines
      }
    }
    return cols;
  }

  private async ensureMetaTable(): Promise<void> {
    const ddl = `CREATE TABLE IF NOT EXISTS ${this.config.database}.telemetry_meta (` +
      `key String, ` +
      `value String, ` +
      `updated_at DateTime DEFAULT now()` +
      `) ENGINE = ReplacingMergeTree(updated_at) ORDER BY key`;
    await this.executeQuery(ddl);
  }

  private async readMeta(key: string): Promise<string | null> {
    const sql = `SELECT value FROM ${this.config.database}.telemetry_meta FINAL ` +
      `WHERE key = '${escapeString(key)}' LIMIT 1 FORMAT JSONEachRow`;
    try {
      const text = await this.queryText(sql);
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const row = JSON.parse(line) as { value?: string };
        if (typeof row.value === 'string') return row.value;
      }
    } catch (err) {
      this.logger.debug('[api-call-telemetry] readMeta failed', {
        key,
        error: (err as Error).message,
      });
    }
    return null;
  }

  private async writeMeta(key: string, value: string): Promise<void> {
    const payload = JSON.stringify({
      key,
      value,
      updated_at: formatClickHouseTimestamp(new Date()).split('.')[0],
    });
    await this.executeQuery(
      `INSERT INTO ${this.config.database}.telemetry_meta FORMAT JSONEachRow`,
      payload,
    );
  }

  /**
   * 扫 DISTINCT user_key WHERE user_id='' → 每个 key 尝试解析出 user_id →
   * ALTER TABLE UPDATE 回填。CH mutation 是异步执行、串行 merge，不阻塞查询。
   *
   * 返回：成功回填的 user_key 数（不算 verify 失败跳过的）。
   */
  private async backfillUserIds(resolver: PanelUserIdResolver): Promise<number> {
    const rows = await this.listUnresolvedUserKeys();
    if (rows.length === 0) return 0;

    this.logger.info('[api-call-telemetry] backfill candidates', {
      distinctUserKeys: rows.length,
    });

    let migrated = 0;
    for (const { instance_id, user_key } of rows) {
      if (!user_key || !instance_id) continue;
      // 尝试从 registry 拿 gateway 参数；缺失就跳过（老实例可能已下线）
      const ctx = this.pickResolverCtxForInstance(instance_id);
      if (!ctx) {
        this.logger.debug('[api-call-telemetry] backfill skip (no instance ctx)', {
          instanceId: instance_id,
          userKey: user_key,
        });
        continue;
      }
      // trigger cache refresh + wait 一小会儿让 auth/verify 回来
      resolver.get(user_key, ctx);
      const uid = await waitForUserId(resolver, user_key, ctx, 2000);
      if (!uid) continue;
      try {
        const alter = `ALTER TABLE ${this.config.database}.${this.config.table} ` +
          `UPDATE user_id = '${escapeString(uid)}' ` +
          `WHERE instance_id = '${escapeString(instance_id)}' ` +
          `AND user_key = '${escapeString(user_key)}' ` +
          `AND user_id = ''`;
        await this.executeQuery(alter);
        migrated += 1;
      } catch (err) {
        this.logger.warn('[api-call-telemetry] backfill mutation failed', {
          instanceId: instance_id,
          userKey: user_key,
          error: (err as Error).message,
        });
      }
    }
    return migrated;
  }

  /**
   * 回填要 per-instance 调 auth/verify（同一个 user_key 在不同 instance 下语义不同）。
   * ctor 注入的 provider 兜底：registry 里找不到的老 instance_id 返回 null 跳过。
   */
  private pickResolverCtxForInstance(instanceId: string): UserIdResolveCtx | null {
    return this.instanceCtxProvider(instanceId);
  }

  private async listUnresolvedUserKeys(): Promise<
    Array<{ instance_id: string; user_key: string }>
  > {
    const sql = `SELECT instance_id, user_key ` +
      `FROM ${this.config.database}.${this.config.table} ` +
      `WHERE user_id = '' AND user_key != '' ` +
      `GROUP BY instance_id, user_key ` +
      `FORMAT JSONEachRow`;
    const text = await this.queryText(sql);
    const out: Array<{ instance_id: string; user_key: string }> = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { instance_id?: string; user_key?: string };
        if (row.instance_id && row.user_key) {
          out.push({ instance_id: row.instance_id, user_key: row.user_key });
        }
      } catch {
        // ignore
      }
    }
    return out;
  }

  private async executeQuery(query: string, data = ''): Promise<void> {
    const url = new URL(this.config.url);
    url.searchParams.set('query', query);

    const headers: Record<string, string> = {
      'content-type': 'text/plain; charset=utf-8',
    };
    if (this.config.user) headers['x-clickhouse-user'] = this.config.user;
    if (this.config.password) headers['x-clickhouse-key'] = this.config.password;

    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: data || undefined,
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`ClickHouse HTTP ${response.status}: ${body.slice(0, 200)}`);
    }
  }

  /** SELECT 类查询：走 GET body 返回文本。 */
  private async queryText(query: string): Promise<string> {
    const url = new URL(this.config.url);
    const headers: Record<string, string> = {
      'content-type': 'text/plain; charset=utf-8',
    };
    if (this.config.user) headers['x-clickhouse-user'] = this.config.user;
    if (this.config.password) headers['x-clickhouse-key'] = this.config.password;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: query,
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`ClickHouse HTTP ${response.status}: ${body.slice(0, 200)}`);
    }
    return await response.text();
  }
}

// ── 工厂 ────────────────────────────────────────────────────────────────────

export function createPanelApiCallTelemetry(
  config: PanelClickHouseConfig,
  logger: Logger,
  instanceCtxProvider: (instanceId: string) => UserIdResolveCtx | null,
  fetchImpl?: typeof fetch,
): PanelApiCallTelemetry {
  if (!config.enabled || !config.url) {
    return new DisabledPanelApiCallTelemetry();
  }
  return new ClickHousePanelApiCallTelemetry(config, logger, instanceCtxProvider, fetchImpl);
}

// ── 辅助 ────────────────────────────────────────────────────────────────────

/** CH SQL 字符串转义：单引号、反斜杠。避免 user_key 里出现特殊字符注入。 */
function escapeString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * 等 resolver 后台 refresh 拿到 user_id。轮询 50ms 一次，超时返回 undefined。
 * 只在 backfill 场景用（真实请求路径永远走 fire-and-forget 不 wait）。
 */
async function waitForUserId(
  resolver: PanelUserIdResolver,
  userKey: string,
  ctx: UserIdResolveCtx,
  timeoutMs: number,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const uid = resolver.get(userKey, ctx);
    if (uid) return uid;
    await new Promise((r) => setTimeout(r, 50));
  }
  return undefined;
}

/** 生成 ClickHouse DateTime64(3) 兼容的时间戳字符串 (Asia/Shanghai)。 */
export function formatClickHouseTimestamp(d: Date): string {
  // ClickHouse DateTime64 接受 ISO 格式，timezone 由表定义决定
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

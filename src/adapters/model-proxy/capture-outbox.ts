import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  CapturePayload,
  ModelProxyGateway,
  ModelProxyLogger,
} from "./types.js";

interface OutboxRow {
  id: string;
  payload: string;
  attempts: number;
}

const NOOP_LOGGER: ModelProxyLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * A durable, deduplicating capture queue.
 *
 * Model responses never wait for Gateway capture. Failed writes remain in
 * SQLite and are retried with bounded exponential backoff.
 */
export class CaptureOutbox {
  private readonly database: DatabaseSync;
  private readonly gateway: ModelProxyGateway;
  private readonly logger: ModelProxyLogger;
  private readonly baseRetryMs: number;
  private readonly maxRetryMs: number;
  private timer?: ReturnType<typeof setTimeout>;
  private draining = false;
  private closed = false;

  constructor(options: {
    databasePath: string;
    gateway: ModelProxyGateway;
    logger?: ModelProxyLogger;
    baseRetryMs?: number;
    maxRetryMs?: number;
  }) {
    if (options.databasePath !== ":memory:") {
      mkdirSync(dirname(options.databasePath), { recursive: true });
    }
    this.database = new DatabaseSync(options.databasePath);
    this.gateway = options.gateway;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.baseRetryMs = options.baseRetryMs ?? 1_000;
    this.maxRetryMs = options.maxRetryMs ?? 60_000;

    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS model_proxy_capture_outbox (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_model_proxy_outbox_due
      ON model_proxy_capture_outbox(next_attempt_at, created_at);
    `);
    this.schedule(0);
  }

  enqueue(id: string, payload: CapturePayload): void {
    if (this.closed) throw new Error("Capture outbox is closed");
    this.database
      .prepare(`
        INSERT OR IGNORE INTO model_proxy_capture_outbox
          (id, payload, attempts, next_attempt_at, created_at)
        VALUES (?, ?, 0, 0, ?)
      `)
      .run(id, JSON.stringify({ ...payload, idempotency_key: id }), Date.now());
    this.schedule(0);
  }

  pendingCount(): number {
    const row = this.database
      .prepare("SELECT COUNT(*) AS count FROM model_proxy_capture_outbox")
      .get() as { count: number };
    return Number(row.count);
  }

  async flush(): Promise<void> {
    while (this.draining) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    await this.drainDue({ ignoreBackoff: true });
  }

  async drainDue(options?: { ignoreBackoff?: boolean }): Promise<void> {
    if (this.draining || this.closed) return;
    this.draining = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    try {
      const now = Date.now();
      const rows = this.database
        .prepare(`
          SELECT id, payload, attempts
          FROM model_proxy_capture_outbox
          WHERE next_attempt_at <= ? OR ? = 1
          ORDER BY created_at ASC
          LIMIT 32
        `)
        .all(now, options?.ignoreBackoff ? 1 : 0) as unknown as OutboxRow[];

      for (const row of rows) {
        try {
          await this.gateway.capture(JSON.parse(row.payload) as CapturePayload);
          this.database
            .prepare("DELETE FROM model_proxy_capture_outbox WHERE id = ?")
            .run(row.id);
        } catch (error) {
          const attempts = row.attempts + 1;
          const delay = Math.min(
            this.maxRetryMs,
            this.baseRetryMs * (2 ** Math.min(attempts - 1, 10)),
          );
          this.database
            .prepare(`
              UPDATE model_proxy_capture_outbox
              SET attempts = ?, next_attempt_at = ?
              WHERE id = ?
            `)
            .run(attempts, Date.now() + delay, row.id);
          this.logger.warn(
            `[model-proxy] Capture ${row.id.slice(0, 12)} deferred after failure: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    } finally {
      this.draining = false;
      this.scheduleNext();
    }
  }

  async close(options?: { flush?: boolean }): Promise<void> {
    if (this.closed) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (options?.flush) await this.flush();
    else {
      while (this.draining) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.closed = true;
    this.database.close();
  }

  private schedule(delayMs: number): void {
    if (this.closed || this.timer || this.draining) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drainDue();
    }, delayMs);
    this.timer.unref();
  }

  private scheduleNext(): void {
    if (this.closed || this.pendingCount() === 0) return;
    const row = this.database
      .prepare(`
        SELECT MIN(next_attempt_at) AS next_attempt_at
        FROM model_proxy_capture_outbox
      `)
      .get() as { next_attempt_at: number | null };
    const delay = Math.max(0, Number(row.next_attempt_at ?? Date.now()) - Date.now());
    this.schedule(delay);
  }
}

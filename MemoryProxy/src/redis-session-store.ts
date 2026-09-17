/**
 * RedisSessionStore — Redis-backed session storage for the private extension.
 *
 * The host treats stored values as opaque JSON blobs and never inspects
 * their shape. It only provides transport-level primitives:
 * - JSON serialization of an opaque state object
 * - Automatic TTL via Redis SETEX
 * - Graceful degradation: returns null on connection errors (passthrough behavior)
 * - Key prefix isolation for multi-tenant Redis instances
 * - An atomic per-session sequence counter (incrTurnSeq)
 * - Separate keys for the extension's task-archive and judge side state
 *   (required by the current SessionStore contract)
 */

import Redis from "ioredis";
import type { RedisConfig } from "./types.js";
import { log } from "./report/log.js";

/**
 * Generic session store contract. Payloads are opaque (`unknown`) to the host —
 * only the extension understands their structure.
 */
export interface SessionStore {
  get(key: string): Promise<unknown | null>;
  set(key: string, state: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  incrTurnSeq(key: string): Promise<number>;
  getTaskArchive(key: string): Promise<unknown | null>;
  setTaskArchive(key: string, state: unknown): Promise<void>;
  recordJudgeToolTurn(key: string, everyN: number): Promise<{ count: number; shouldJudge: boolean }>;
  getJudgeVerdict(key: string): Promise<unknown | null>;
  setJudgeVerdict(key: string, verdict: unknown): Promise<void>;
}

export class RedisSessionStore implements SessionStore {
  private client: Redis;
  private readonly keyPrefix: string;
  private readonly ttlSeconds: number;
  private connected = false;

  constructor(config: RedisConfig) {
    this.keyPrefix = config.keyPrefix || "cg:sess:";
    this.ttlSeconds = config.ttlSeconds || 1800;

    if (config.url) {
      this.client = new Redis(config.url, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        retryStrategy: (times) => {
          if (times > 3) return null; // Stop retrying after 3 attempts
          return Math.min(times * 500, 2000);
        },
      });
    } else {
      this.client = new Redis({
        host: config.host || "127.0.0.1",
        port: config.port || 6379,
        password: config.password || undefined,
        db: config.db ?? 0,
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        retryStrategy: (times) => {
          if (times > 3) return null;
          return Math.min(times * 500, 2000);
        },
      });
    }

    this.client.on("connect", () => {
      this.connected = true;
      log.info("redis.connected", { keyPrefix: this.keyPrefix });
    });

    this.client.on("error", (err) => {
      this.connected = false;
      log.warn("redis.error", { error: String(err) });
    });

    this.client.on("close", () => {
      this.connected = false;
    });

    // Initiate connection
    this.client.connect().catch((err) => {
      log.warn("redis.connect_failed", { error: String(err) });
    });
  }

  private buildKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  /** Key for the atomic turn-sequence counter (separate from the state blob). */
  private buildTurnSeqKey(key: string): string {
    return `${this.keyPrefix}turnseq:${key}`;
  }

  /** Key for the multi-task archive blob (never truncated). */
  private buildArchiveKey(key: string): string {
    return `${this.keyPrefix}arch:${key}`;
  }

  private buildJudgeCountKey(key: string): string {
    return `${this.keyPrefix}judge-count:${key}`;
  }

  private buildJudgeVerdictKey(key: string): string {
    return `${this.keyPrefix}judge-verdict:${key}`;
  }

  async get(key: string): Promise<unknown | null> {
    if (!this.connected) return null;

    try {
      const raw = await this.client.get(this.buildKey(key));
      if (!raw) return null;

      return JSON.parse(raw) as unknown;
    } catch (err) {
      log.warn("redis.get_error", { key, error: String(err) });
      return null;
    }
  }

  async set(key: string, state: unknown): Promise<void> {
    if (!this.connected) return;

    try {
      const serialized = JSON.stringify(state, (_k, v) => {
        // Truncate over-long string fields to avoid oversized values.
        if (typeof v === "string" && v.length > 4096) {
          return v.slice(0, 4096);
        }
        return v;
      });
      const results = await this.client
        .pipeline()
        .setex(this.buildKey(key), this.ttlSeconds, serialized)
        // Keep side keys alive in lockstep with the state blob. Their TTL is
        // otherwise only refreshed on increment/write, so a long tool-loop
        // could let them expire while the blob survives.
        .expire(this.buildTurnSeqKey(key), this.ttlSeconds)
        .expire(this.buildArchiveKey(key), this.ttlSeconds)
        .expire(this.buildJudgeCountKey(key), this.ttlSeconds)
        .expire(this.buildJudgeVerdictKey(key), this.ttlSeconds)
        .exec();
      const commandNames = ["setex", "expire-turnseq", "expire-archive", "expire-judge-count", "expire-judge-verdict"];
      const failures = results
        ? results.flatMap(([err], index) => err ? [`${commandNames[index] ?? index}: ${String(err)}`] : [])
        : ["pipeline returned no result"];
      if (failures.length > 0) {
        log.warn("redis.set_error", { key, error: failures.join("; ") });
      }
    } catch (err) {
      log.warn("redis.set_error", { key, error: String(err) });
    }
  }

  async delete(key: string): Promise<void> {
    if (!this.connected) return;

    try {
      await this.client.del(
        this.buildKey(key),
        this.buildTurnSeqKey(key),
        this.buildArchiveKey(key),
        this.buildJudgeCountKey(key),
        this.buildJudgeVerdictKey(key),
      );
    } catch (err) {
      log.warn("redis.delete_error", { key, error: String(err) });
    }
  }

  /**
   * Atomically increment the per-session turn sequence counter.
   *
   * Uses a dedicated key (`<prefix>turnseq:<session>`) with Redis INCR so that
   * concurrent requests on the same session are serialized by Redis itself —
   * each caller gets a unique, strictly increasing value. The counter's TTL is
   * refreshed on every increment to match the session lifetime.
   *
   * Returns 0 when Redis is unavailable so the host can fall back to its
   * stateless turn count.
   */
  async incrTurnSeq(key: string): Promise<number> {
    if (!this.connected) return 0;

    try {
      const turnSeqKey = this.buildTurnSeqKey(key);
      const results = await this.client
        .pipeline()
        .incr(turnSeqKey)
        .expire(turnSeqKey, this.ttlSeconds)
        .exec();
      const incrResult = results?.[0];
      if (!incrResult || incrResult[0]) {
        log.warn("redis.incr_turnseq_error", {
          key,
          error: String(incrResult?.[0] ?? "pipeline returned no result"),
        });
        return 0;
      }
      return Number(incrResult[1]);
    } catch (err) {
      log.warn("redis.incr_turnseq_error", { key, error: String(err) });
      return 0;
    }
  }

  async getTaskArchive(key: string): Promise<unknown | null> {
    if (!this.connected) return null;

    try {
      const raw = await this.client.get(this.buildArchiveKey(key));
      if (!raw) return null;
      return JSON.parse(raw) as unknown;
    } catch (err) {
      log.warn("redis.get_archive_error", { key, error: String(err) });
      return null;
    }
  }

  /**
   * Persist the task archive under its own key. Unlike `set()`, the value is
   * NOT truncated — free-text archive fields must round-trip intact.
   */
  async setTaskArchive(key: string, state: unknown): Promise<void> {
    if (!this.connected) return;

    try {
      await this.client.setex(this.buildArchiveKey(key), this.ttlSeconds, JSON.stringify(state));
    } catch (err) {
      log.warn("redis.set_archive_error", { key, error: String(err) });
    }
  }

  async recordJudgeToolTurn(key: string, everyN: number): Promise<{ count: number; shouldJudge: boolean }> {
    if (!this.connected) return { count: 0, shouldJudge: false };

    try {
      const countKey = this.buildJudgeCountKey(key);
      const results = await this.client
        .pipeline()
        .incr(countKey)
        .expire(countKey, this.ttlSeconds)
        .exec();
      const incrResult = results?.[0];
      if (!incrResult || incrResult[0]) {
        log.warn("redis.incr_judge_count_error", {
          key,
          error: String(incrResult?.[0] ?? "pipeline returned no result"),
        });
        return { count: 0, shouldJudge: false };
      }
      const count = Number(incrResult[1]);
      const frequency = Math.max(1, Math.floor(everyN));
      return { count, shouldJudge: count % frequency === 0 };
    } catch (err) {
      log.warn("redis.incr_judge_count_error", { key, error: String(err) });
      return { count: 0, shouldJudge: false };
    }
  }

  async getJudgeVerdict(key: string): Promise<unknown | null> {
    if (!this.connected) return null;
    try {
      const raw = await this.client.get(this.buildJudgeVerdictKey(key));
      return raw ? JSON.parse(raw) as unknown : null;
    } catch (err) {
      log.warn("redis.get_judge_verdict_error", { key, error: String(err) });
      return null;
    }
  }

  async setJudgeVerdict(key: string, verdict: unknown): Promise<void> {
    if (!this.connected) return;
    try {
      await this.client.setex(
        this.buildJudgeVerdictKey(key),
        this.ttlSeconds,
        JSON.stringify(verdict),
      );
    } catch (err) {
      log.warn("redis.set_judge_verdict_error", { key, error: String(err) });
    }
  }

  /** Check if Redis is currently connected. */
  isConnected(): boolean {
    return this.connected;
  }

  /** Gracefully close the Redis connection. */
  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}

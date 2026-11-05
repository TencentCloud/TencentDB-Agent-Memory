/**
 * Shared Redis client factory used by both routing and Injection layers.
 *
 * One ioredis instance per process; lazy-connect with retry.
 * Callers receive `Redis | null` — null means Redis is disabled or the client
 * could not be constructed, and they should use their SQLite / Null fallback.
 *
 * Once constructed, the client is kept for the process lifetime and reconnects
 * in the background forever (callers such as the rate limiter cache it).
 * Commands issued while disconnected queue for up to OFFLINE_GRACE_MS so a brief
 * blip stays invisible; past that they fail immediately so callers fall back
 * without adding latency to requests.
 */
import Redis, { type RedisOptions } from "ioredis";
import type { RedisConfig } from "../types.js";

let _client: Redis | null = null;
let _failed = false;

export const OFFLINE_GRACE_MS = 1000;

export function redisRetryDelay(times: number): number {
  return Math.min(times * 500, 5000);
}

const CLIENT_OPTIONS: RedisOptions = {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  retryStrategy: redisRetryDelay,
};

type QueueToggleClient = Pick<Redis, "on"> & { options: Pick<RedisOptions, "enableOfflineQueue"> };

/** ioredis reads `options.enableOfflineQueue` per command, so toggling it at runtime takes effect. */
export function installOfflineQueueGrace(client: QueueToggleClient, graceMs = OFFLINE_GRACE_MS): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  client.on("close", () => {
    if (timer || !client.options.enableOfflineQueue) return;
    timer = setTimeout(() => {
      timer = undefined;
      client.options.enableOfflineQueue = false;
    }, graceMs);
    timer.unref?.();
  });
  client.on("ready", () => {
    clearTimeout(timer);
    timer = undefined;
    client.options.enableOfflineQueue = true;
  });
}

export function getRedisClient(config: RedisConfig): Redis | null {
  if (_client) return _client;
  if (_failed || !config.enabled) return null;

  try {
    const client = config.url
      ? new Redis(config.url, CLIENT_OPTIONS)
      : new Redis({
          ...CLIENT_OPTIONS,
          host: config.host || "127.0.0.1",
          port: config.port || 6379,
          password: config.password || undefined,
          db: config.db ?? 0,
        });

    // Without a listener ioredis logs every reconnect failure as unhandled.
    client.on("error", () => {});
    installOfflineQueueGrace(client);

    // A failed first attempt still leaves retryStrategy reconnecting in the background.
    client.connect().catch(() => {});

    _client = client;
    return _client;
  } catch {
    _failed = true;
    return null;
  }
}

/** Reset singleton (tests only). */
export function __resetRedisClientForTests(): void {
  if (_client) {
    try { _client.disconnect(); } catch { /* ignore */ }
  }
  _client = null;
  _failed = false;
}

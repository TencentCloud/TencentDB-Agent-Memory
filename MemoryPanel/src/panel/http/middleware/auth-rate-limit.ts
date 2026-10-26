/**
 * In-memory fixed-window rate limiter for the unauthenticated auth
 * endpoints (user-key preview/login, woa preview-key) — brute force of
 * user-chosen keys and unlimited account creation otherwise.
 *
 * Keyed by socket remote address (NOT x-forwarded-for — spoofable).
 * Entries are pruned opportunistically on each check so the map cannot
 * grow unbounded. The clock is injectable for tests.
 */
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, Next } from 'hono';

const WINDOW_MS = 60_000;

interface WindowEntry {
  count: number;
  windowStart: number;
}

export class FixedWindowRateLimiter {
  private readonly limitPerMinute: number;
  private readonly now: () => number;
  private readonly hits = new Map<string, WindowEntry>();

  constructor(opts: { limitPerMinute: number; now?: () => number }) {
    this.limitPerMinute = opts.limitPerMinute;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Returns null when the request is allowed, or the Retry-After
   * seconds when the key has exhausted its window allowance.
   */
  check(key: string): number | null {
    if (this.limitPerMinute <= 0) return null; // disabled
    const now = this.now();
    // Opportunistic prune of expired windows — bounds map size to the
    // number of distinct keys seen inside a single window.
    for (const [k, e] of this.hits) {
      if (now - e.windowStart >= WINDOW_MS) this.hits.delete(k);
    }

    const entry = this.hits.get(key);
    if (!entry || now - entry.windowStart >= WINDOW_MS) {
      this.hits.set(key, { count: 1, windowStart: now });
      return null;
    }
    if (entry.count >= this.limitPerMinute) {
      return Math.max(1, Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000));
    }
    entry.count += 1;
    return null;
  }
}

/** PANEL_AUTH_RATE_LIMIT_PER_MINUTE — default 60; 0 disables. */
export function resolveAuthRateLimitPerMinute(raw?: string): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60;
}

export function authRateLimitMiddleware(limiter: FixedWindowRateLimiter) {
  return async (c: Context, next: Next) => {
    let key = 'unknown';
    try {
      key = getConnInfo(c).remote.address ?? 'unknown';
    } catch {
      // conninfo unavailable in this runtime — bucket under "unknown"
    }
    const retryAfter = limiter.check(key);
    if (retryAfter !== null) {
      c.header('Retry-After', String(retryAfter));
      return c.json(
        { code: 429, message: 'RATE_LIMITED', request_id: c.get('reqId') ?? '', data: null },
        429,
      );
    }
    await next();
  };
}

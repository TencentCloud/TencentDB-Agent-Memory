/**
 * In-memory fixed-window rate limiter for the unauthenticated auth
 * endpoints (user-key preview/login, woa preview-key) — brute force of
 * user-chosen keys and unlimited account creation otherwise.
 *
 * Keyed by socket remote address by default (NOT x-forwarded-for — spoofable).
 * Behind a reverse proxy / load balancer every client shares the proxy's
 * address; set PANEL_AUTH_RATE_LIMIT_TRUST_PROXY=1 there to key on the last
 * X-Forwarded-For hop (the address your proxy appended), or raise/disable
 * the limit. Expired entries are pruned at most once per window so the map
 * cannot grow unbounded. The clock is injectable for tests.
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
  private lastPruneAt = 0;

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
    // Prune expired windows at most once per window — bounds map size to the
    // keys seen in ~two windows without an O(n) scan on every request.
    if (now - this.lastPruneAt >= WINDOW_MS) {
      this.lastPruneAt = now;
      for (const [k, e] of this.hits) {
        if (now - e.windowStart >= WINDOW_MS) this.hits.delete(k);
      }
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

/** PANEL_AUTH_RATE_LIMIT_TRUST_PROXY — "1"/"true" keys on the last X-Forwarded-For hop. */
export function resolveAuthRateLimitTrustProxy(raw?: string): boolean {
  return raw === '1' || raw?.toLowerCase() === 'true';
}

/** Last X-Forwarded-For entry: the client address as seen by the nearest (trusted) proxy. */
export function lastForwardedFor(header: string | undefined): string | null {
  const hops = (header ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  return hops.length > 0 ? hops[hops.length - 1]! : null;
}

export function authRateLimitMiddleware(limiter: FixedWindowRateLimiter, opts: { trustProxy?: boolean } = {}) {
  return async (c: Context, next: Next) => {
    let key = 'unknown';
    try {
      key = getConnInfo(c).remote.address ?? 'unknown';
    } catch {
      // conninfo unavailable in this runtime — bucket under "unknown"
    }
    if (opts.trustProxy) key = lastForwardedFor(c.req.header('x-forwarded-for')) ?? key;
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

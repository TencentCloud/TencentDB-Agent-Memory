import { describe, it, expect } from 'vitest';
import {
  FixedWindowRateLimiter,
  lastForwardedFor,
  resolveAuthRateLimitPerMinute,
  resolveAuthRateLimitTrustProxy,
} from '../src/panel/http/middleware/auth-rate-limit.js';

describe('FixedWindowRateLimiter', () => {
  it('allows up to the limit then returns Retry-After seconds', () => {
    let t = 0;
    const l = new FixedWindowRateLimiter({ limitPerMinute: 3, now: () => t });
    expect(l.check('ip')).toBeNull();
    expect(l.check('ip')).toBeNull();
    expect(l.check('ip')).toBeNull();
    expect(l.check('ip')).toBe(60);
    t = 30_000;
    expect(l.check('ip')).toBe(30);
  });

  it('resets after the window', () => {
    let t = 0;
    const l = new FixedWindowRateLimiter({ limitPerMinute: 1, now: () => t });
    expect(l.check('ip')).toBeNull();
    expect(l.check('ip')).not.toBeNull();
    t = 61_000;
    expect(l.check('ip')).toBeNull();
  });

  it('tracks keys independently and prunes expired entries', () => {
    let t = 0;
    const l = new FixedWindowRateLimiter({ limitPerMinute: 1, now: () => t });
    expect(l.check('a')).toBeNull();
    expect(l.check('b')).toBeNull();
    expect(l.check('a')).not.toBeNull();
    t = 61_000;
    // 'a' and 'b' are expired — the next check prunes them.
    expect(l.check('c')).toBeNull();
    expect((l as unknown as { hits: Map<string, unknown> }).hits.size).toBe(1);
  });

  it('limit 0 disables limiting entirely', () => {
    const l = new FixedWindowRateLimiter({ limitPerMinute: 0 });
    for (let i = 0; i < 100; i++) expect(l.check('ip')).toBeNull();
  });
});

describe('resolveAuthRateLimitPerMinute', () => {
  it('defaults to 60, honors 0 and valid values, falls back on garbage', () => {
    expect(resolveAuthRateLimitPerMinute(undefined)).toBe(60);
    expect(resolveAuthRateLimitPerMinute('0')).toBe(0);
    expect(resolveAuthRateLimitPerMinute('10')).toBe(10);
    expect(resolveAuthRateLimitPerMinute('bogus')).toBe(60);
    expect(resolveAuthRateLimitPerMinute('-5')).toBe(60);
  });
});

describe('trust-proxy keying', () => {
  it('uses the last X-Forwarded-For hop (the one the trusted proxy appended)', () => {
    expect(lastForwardedFor('1.1.1.1, 10.0.0.5')).toBe('10.0.0.5');
    expect(lastForwardedFor(' 203.0.113.7 ')).toBe('203.0.113.7');
    expect(lastForwardedFor('')).toBeNull();
    expect(lastForwardedFor(undefined)).toBeNull();
  });

  it('is opt-in', () => {
    expect(resolveAuthRateLimitTrustProxy(undefined)).toBe(false);
    expect(resolveAuthRateLimitTrustProxy('0')).toBe(false);
    expect(resolveAuthRateLimitTrustProxy('1')).toBe(true);
    expect(resolveAuthRateLimitTrustProxy('TRUE')).toBe(true);
  });
});

describe('authRateLimitMiddleware', () => {
  async function hit(app: import('hono').Hono, xff?: string) {
    const res = await app.request('/login', { method: 'POST', headers: xff ? { 'x-forwarded-for': xff } : {} });
    return res.status;
  }

  it('returns 429 with Retry-After once the bucket is exhausted', async () => {
    const { Hono } = await import('hono');
    const { authRateLimitMiddleware } = await import('../src/panel/http/middleware/auth-rate-limit.js');
    const app = new Hono();
    app.use('/login', authRateLimitMiddleware(new FixedWindowRateLimiter({ limitPerMinute: 1 })));
    app.post('/login', (c) => c.text('ok'));
    expect(await hit(app)).toBe(200);
    const res = await app.request('/login', { method: 'POST' });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).not.toBeNull();
  });

  it('ignores X-Forwarded-For unless trustProxy is enabled', async () => {
    const { Hono } = await import('hono');
    const { authRateLimitMiddleware } = await import('../src/panel/http/middleware/auth-rate-limit.js');
    const untrusted = new Hono();
    untrusted.use('/login', authRateLimitMiddleware(new FixedWindowRateLimiter({ limitPerMinute: 1 })));
    untrusted.post('/login', (c) => c.text('ok'));
    expect(await hit(untrusted, '1.1.1.1')).toBe(200);
    expect(await hit(untrusted, '2.2.2.2')).toBe(429);

    const trusted = new Hono();
    trusted.use('/login', authRateLimitMiddleware(new FixedWindowRateLimiter({ limitPerMinute: 1 }), { trustProxy: true }));
    trusted.post('/login', (c) => c.text('ok'));
    expect(await hit(trusted, '1.1.1.1')).toBe(200);
    expect(await hit(trusted, '2.2.2.2')).toBe(200);
    expect(await hit(trusted, '2.2.2.2')).toBe(429);
  });
});

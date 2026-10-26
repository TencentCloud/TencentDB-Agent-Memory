import { describe, it, expect } from 'vitest';
import { FixedWindowRateLimiter, resolveAuthRateLimitPerMinute } from '../src/panel/http/middleware/auth-rate-limit.js';

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

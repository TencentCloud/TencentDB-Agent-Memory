import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemorySessionStore } from '../src/panel/auth/session-store.js';

const INPUT = {
  instanceId: 'i', coreUserId: 'u', userKey: 'k',
  providerId: 'p', externalSubject: 's',
} as const;

describe('MemorySessionStore expired-session sweep', () => {
  afterEach(() => vi.useRealTimers());

  it('sweeps expired entries on create, at most once per 60s', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const store = new MemorySessionStore(60); // 60s TTL
    const old = store.create({ ...INPUT });
    vi.setSystemTime(1_000_000 + 30_000);
    const live = store.create({ ...INPUT }); // expires at t+90s

    vi.setSystemTime(1_000_000 + 61_000); // only 'old' expired
    const third = store.create({ ...INPUT });
    const map = (store as unknown as { sessions: Map<string, unknown> }).sessions;
    expect(map.has(old.token)).toBe(false);
    expect(map.has(live.token)).toBe(true);
    expect(map.has(third.token)).toBe(true);
  });

  it('does not sweep more often than every 60s', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const store = new MemorySessionStore(1); // 1s TTL
    store.create({ ...INPUT });            // arms sweep timer (t=1,000,000)
    vi.setSystemTime(1_000_000 + 2_000);   // session expired but <60s since sweep
    store.create({ ...INPUT });
    const map = (store as unknown as { sessions: Map<string, unknown> }).sessions;
    expect(map.size).toBe(2);              // expired one not swept yet
    vi.setSystemTime(1_000_000 + 61_000);
    store.create({ ...INPUT });
    expect(map.size).toBe(1);              // now swept
  });
});

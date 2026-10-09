import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemorySessionStore } from '../../src/panel/auth/session-store.js';

const sessionInput = {
  instanceId: 'instance-a',
  coreUserId: 'user-a',
  userKey: 'user-key-a',
  providerId: 'woa',
  externalSubject: 'external-user-a',
};

describe('MemorySessionStore expiry and revocation', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z')); });
  afterEach(() => vi.useRealTimers());

  it('issues distinct opaque tokens and stores the selected instance and user', () => {
    const store = new MemorySessionStore(60);
    const a = store.create(sessionInput);
    const b = store.create(sessionInput);
    expect(a.token).not.toBe(b.token);
    expect(a.token).not.toContain(sessionInput.userKey);
    expect(store.get(a.token)).toMatchObject(sessionInput);
    expect(a.expiresAt - a.createdAt).toBe(60_000);
  });

  it('expires at the exact TTL boundary and never revives after clock rollback', () => {
    const store = new MemorySessionStore(60);
    const session = store.create(sessionInput);
    vi.advanceTimersByTime(59_999);
    expect(store.get(session.token)).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(store.get(session.token)).toBeNull();
    vi.setSystemTime(session.createdAt);
    expect(store.get(session.token)).toBeNull();
  });

  it('revokes only the selected session and tolerates unknown tokens', () => {
    const store = new MemorySessionStore(60);
    const a = store.create(sessionInput);
    const b = store.create(sessionInput);
    store.destroy(a.token);
    store.destroy(undefined);
    store.destroy('unknown');
    expect(store.get(a.token)).toBeNull();
    expect(store.get(b.token)).not.toBeNull();
    expect(store.get(undefined)).toBeNull();
    expect(store.get('unknown')).toBeNull();
  });
});

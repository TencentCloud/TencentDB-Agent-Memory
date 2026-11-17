import { describe, it, expect, vi } from 'vitest';
import { PanelAuthService } from '../src/panel/auth/service.js';
import { encryptSecret } from '../src/panel/auth/identity-store.js';

const SECRET = 'test-secret';
function makeSvc() {
  const svc = Object.create(PanelAuthService.prototype) as Record<string, unknown>;
  svc.config = { sessionSecret: SECRET };
  svc.providers = { get: (id: string) => (id === 'woa' ? {} : undefined) };
  svc.sessions = { create: vi.fn(() => ({ token: 'sess' })) };
  svc.consumedPendingWoa = new Map<string, number>();
  svc.logger = { debug() {}, info() {}, warn() {}, error() {} };
  return svc as unknown as {
    completePendingWoaLogin(i: { token: string; userKey: string }): Promise<unknown>;
    getPendingWoaLogin(t: string | undefined): unknown;
    dismissPendingWoaLogin(t: string | undefined): void;
    provisionIdentity: (i: unknown) => Promise<unknown>;
    consumedPendingWoa: Map<string, number>;
  };
}

function makeToken(expiresAt = Date.now() + 60_000): string {
  return encryptSecret(JSON.stringify({
    version: 1, instanceId: 'i', expiresAt, nonce: 'n',
    identity: { providerId: 'woa', subject: 's', loginName: 'l' },
  }), SECRET);
}

describe('completePendingWoaLogin consume-once', () => {
  it('second concurrent submit of the same token is rejected', async () => {
    const svc = makeSvc();
    let release!: () => void;
    svc.provisionIdentity = vi.fn(() => new Promise((r) => { release = () => r({ coreUserId: 'u', userKey: 'k' }); }));
    const token = makeToken();
    const p1 = svc.completePendingWoaLogin({ token, userKey: 'k' });
    await expect(svc.completePendingWoaLogin({ token, userKey: 'k' }))
      .rejects.toMatchObject({ code: 'WOA_LOGIN_EXPIRED' });
    release();
    await p1;
    expect(svc.provisionIdentity).toHaveBeenCalledTimes(1);
  });

  it('un-consumes on provisioning failure so retry is possible', async () => {
    const svc = makeSvc();
    const token = makeToken();
    svc.provisionIdentity = vi.fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ coreUserId: 'u', userKey: 'k' });
    await expect(svc.completePendingWoaLogin({ token, userKey: 'k' })).rejects.toThrow('db down');
    await expect(svc.completePendingWoaLogin({ token, userKey: 'k' })).resolves.toBeTruthy();
    expect(svc.provisionIdentity).toHaveBeenCalledTimes(2);
  });
});

describe('consumedPendingWoa pruning', () => {
  it('prunes expired tombstones when adding and keeps recent ones', () => {
    const svc = makeSvc();
    svc.consumedPendingWoa.set('old', Date.now() - 1000);
    svc.dismissPendingWoaLogin(makeToken());
    expect(svc.consumedPendingWoa.has('old')).toBe(false);
    expect(svc.consumedPendingWoa.size).toBe(1);
  });

  it('undecodable token gets a ~5min tombstone', () => {
    const svc = makeSvc();
    svc.dismissPendingWoaLogin('garbage-token');
    const exp = svc.consumedPendingWoa.get('garbage-token')!;
    expect(exp - Date.now()).toBeGreaterThan(4 * 60_000);
  });
});

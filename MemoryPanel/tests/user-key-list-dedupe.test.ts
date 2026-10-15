import { afterEach, describe, expect, it, vi } from 'vitest';
import { setPanelSession, clearPanelSession } from '../web/src/lib/panelSession';
import { userKeysApi } from '../web/src/lib/api/users';

vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));

type PendingResponse = {
  instanceId: string;
  keyId: string;
  resolve: (value: Response) => void;
};

function response(keyId: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ code: 0, message: 'ok', data: { items: [{ key_id: keyId }], total: 1 } }),
  } as Response;
}

describe('user Key list request deduplication', () => {
  const storage = new Map<string, string>();

  afterEach(() => {
    clearPanelSession();
    storage.clear();
    vi.unstubAllGlobals();
  });

  function setup() {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    });
    const pending: PendingResponse[] = [];
    vi.stubGlobal('fetch', vi.fn((_path: string, init: RequestInit) =>
      new Promise<Response>((resolve) => {
        const headers = init.headers as Record<string, string>;
        pending.push({
          instanceId: headers['X-Tdai-Service-Id'],
          keyId: headers['X-Tdai-User-Key'],
          resolve,
        });
      }),
    ));
    return pending;
  }

  it('keeps concurrent requests for the same user in different instances separate', async () => {
    const pending = setup();
    setPanelSession({ instanceId: 'instance-a', userKey: 'secret-a', keyId: 'login-a' });
    const fromA = userKeysApi.list('same-user');
    // 不同实例允许存在相同的 Key 资源 ID，实例本身必须参与隔离。
    setPanelSession({ instanceId: 'instance-b', userKey: 'secret-b', keyId: 'login-a' });
    const fromB = userKeysApi.list('same-user');

    const observedInstances = pending.map(({ instanceId }) => instanceId);
    pending[1]?.resolve(response('key-b'));
    pending[0].resolve(response('key-a'));
    expect(observedInstances).toEqual(['instance-a', 'instance-b']);
    expect((await fromB).map(({ key_id }) => key_id)).toEqual(['key-b']);
    expect((await fromA).map(({ key_id }) => key_id)).toEqual(['key-a']);
  });

  it('deduplicates requests in one instance with the same login Key', async () => {
    const pending = setup();
    setPanelSession({ instanceId: 'instance-a', userKey: 'secret-a', keyId: 'login-a' });
    const first = userKeysApi.list('same-user');
    const second = userKeysApi.list('same-user');

    expect(pending).toHaveLength(1);
    pending[0].resolve(response('key-a'));
    expect(await first).toEqual(await second);
  });

  it('keeps different login Keys in the same instance separate', async () => {
    const pending = setup();
    setPanelSession({ instanceId: 'instance-a', userKey: 'secret-a', keyId: 'login-a' });
    const first = userKeysApi.list('same-user');
    setPanelSession({ instanceId: 'instance-a', userKey: 'secret-b', keyId: 'login-b' });
    const second = userKeysApi.list('same-user');

    expect(pending).toHaveLength(2);
    pending[0].resolve(response('first'));
    pending[1].resolve(response('second'));
    expect((await first)[0].key_id).toBe('first');
    expect((await second)[0].key_id).toBe('second');
  });

  it('does not share requests when the login Key ID is unavailable', async () => {
    const pending = setup();
    setPanelSession({ instanceId: 'instance-a', userKey: 'secret-a' });
    const first = userKeysApi.list('same-user');
    const second = userKeysApi.list('same-user');

    expect(pending).toHaveLength(2);
    pending[0].resolve(response('first'));
    pending[1].resolve(response('second'));
    expect((await first)[0].key_id).toBe('first');
    expect((await second)[0].key_id).toBe('second');
  });
});

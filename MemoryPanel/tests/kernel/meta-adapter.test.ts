import { describe, expect, it, vi } from 'vitest';
import { FetchMetaKernelAdapter } from '../../src/panel/kernel/adapters/fetch-meta-kernel-adapter.js';
import type { KernelHttpPort } from '../../src/panel/kernel/ports/kernel-http-port.js';

const ctx = { instanceId: 'instance-a', gatewayEndpoint: 'https://core.test', gatewayApiKey: 'server-key', userKey: 'caller-key', reqId: 'request-1' };

function fixture() {
  const postEnvelope = vi.fn().mockResolvedValue({ code: 0, message: 'ok', request_id: 'request-1', data: {} });
  return { postEnvelope, adapter: new FetchMetaKernelAdapter({ postEnvelope } as unknown as KernelHttpPort, 5000) };
}

describe('Meta adapter cross-service contract', () => {
  it('forwards list pagination and all request-scoped credentials', async () => {
    const { adapter, postEnvelope } = fixture();
    await adapter.invoke('agent/list', { team_id: 'team-a', limit: 25, offset: 50 }, ctx);
    expect(postEnvelope).toHaveBeenCalledWith('/v3/meta/agent/list', { team_id: 'team-a', limit: 25, offset: 50 }, {
      endpoint: 'https://core.test', apiKey: 'server-key', instanceId: 'instance-a', userKey: 'caller-key', timeoutMs: 5000, requestId: 'request-1',
    });
  });

  it('removes list-only fields from mutations without changing the caller body', async () => {
    const { adapter, postEnvelope } = fixture();
    const body = { agent_id: 'agent-a', name: 'Updated', limit: 25, offset: 50 };
    await adapter.invoke('agent/update', body, ctx);
    expect(postEnvelope.mock.calls[0][1]).toEqual({ agent_id: 'agent-a', name: 'Updated' });
    expect(body).toHaveProperty('limit', 25);
    expect(body).toHaveProperty('offset', 50);
  });

  it('verifies the body key without also sending a caller header', async () => {
    const { adapter, postEnvelope } = fixture();
    await adapter.invoke('auth/verify', { user_key: 'verification-target' }, ctx);
    expect(postEnvelope.mock.calls[0][1]).toEqual({ user_key: 'verification-target' });
    expect(postEnvelope.mock.calls[0][2]).toMatchObject({ apiKey: 'server-key', userKey: undefined });
  });

  it.each(['user/create', 'user/create-with-key'])('retains caller authorization for %s', async (action) => {
    const { adapter, postEnvelope } = fixture();
    await adapter.invoke(action, { username: 'new-user' }, ctx);
    expect(postEnvelope.mock.calls[0][2].userKey).toBe('caller-key');
  });

  it('preserves upstream business errors for the proxy to relay', async () => {
    const { adapter, postEnvelope } = fixture();
    const denied = { code: 403, message: 'permission_denied', request_id: 'upstream-id', data: null };
    postEnvelope.mockResolvedValue(denied);
    expect(await adapter.invoke('agent/update', {}, ctx)).toBe(denied);
  });
});

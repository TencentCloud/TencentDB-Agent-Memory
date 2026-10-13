import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { InstanceRegistry } from '../../src/panel/config/instance-registry.js';
import { validatePanelMetaHeaders } from '../../src/panel/http/middleware/validate-panel-headers.js';
import type { PanelDeps } from '../../src/panel/panel-deps.js';

function fixture() {
  const registry = new InstanceRegistry([
    { instance_id: 'a', name: 'A', gateway_endpoint: 'https://core-a.test', api_key: 'server-secret-a' },
    { instance_id: 'b', name: 'B', gateway_endpoint: 'https://core-b.test', api_key: 'server-secret-b', proxy_endpoint: 'https://proxy-b.test' },
  ]);
  const resolveSession = vi.fn((instanceId: string, token?: string) => (
    instanceId === 'a' && token === 'session-a' ? { userKey: 'cookie-user-key', coreUserId: 'user-a' } : null
  ));
  const deps = { instanceRegistry: registry, config: { auth: { sessionCookieName: 'panel-session' } }, auth: { resolveSession } } as unknown as PanelDeps;
  const app = new Hono();
  app.use('*', validatePanelMetaHeaders(deps));
  app.post('*', (c) => c.json(c.get('panelMeta')));
  const request = (headers: Record<string, string>, path = '/meta/agent/list') => app.request(path, { method: 'POST', headers });
  return { request, resolveSession, registry };
}

describe('Panel instance and credential admission', () => {
  it.each([
    { headers: {}, message: 'MISSING_INSTANCE_ID' },
    { headers: { 'x-tdai-service-id': 'unknown' }, message: 'INVALID_INSTANCE' },
    { headers: { 'x-tdai-service-id': 'a' }, message: 'MISSING_USER_KEY' },
  ])('rejects $message before forwarding', async ({ headers, message }) => {
    const { request } = fixture();
    const response = await request(headers);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 400, message });
  });

  it('takes server credentials and gateway from the selected registry entry', async () => {
    const { request, resolveSession } = fixture();
    const response = await request({ 'x-tdai-service-id': ' b ', 'x-tdai-user-key': ' supplied-key ', authorization: 'Bearer attacker', cookie: 'panel-session=session-a' });
    expect(await response.json()).toEqual({ instanceId: 'b', gatewayEndpoint: 'https://core-b.test', gatewayApiKey: 'server-secret-b', userKey: 'supplied-key', authMethod: 'user_key' });
    expect(resolveSession).not.toHaveBeenCalled();
  });

  it('uses a valid session only for its own instance', async () => {
    const { request, resolveSession } = fixture();
    const valid = await request({ 'x-tdai-service-id': 'a', cookie: 'other=x; panel-session=session-a' });
    expect(await valid.json()).toMatchObject({ instanceId: 'a', userKey: 'cookie-user-key', userId: 'user-a', authMethod: 'idp' });
    const other = await request({ 'x-tdai-service-id': 'b', cookie: 'panel-session=session-a' });
    expect(other.status).toBe(400);
    expect(resolveSession).toHaveBeenLastCalledWith('b', 'session-a');
  });

  it('admits auth/verify without a user header and omits even a supplied header', async () => {
    const { request, resolveSession } = fixture();
    for (const userHeaders of [{}, { 'x-tdai-user-key': 'should-not-forward' }]) {
      const response = await request({ 'x-tdai-service-id': 'a', ...userHeaders }, '/meta/auth/verify');
      expect(response.status).toBe(200);
      expect(await response.json()).not.toHaveProperty('userKey');
    }
    expect(resolveSession).not.toHaveBeenCalled();
  });

  it('requires a user key on lookalike verification paths', async () => {
    const { request } = fixture();
    expect((await request({ 'x-tdai-service-id': 'a' }, '/meta/auth/verify/extra')).status).toBe(400);
  });

  it('never publishes server API keys and keeps optional proxy URLs separate', () => {
    const { registry } = fixture();
    expect(registry.listPublic()).toEqual([
      { instance_id: 'a', name: 'A', gateway_endpoint: 'https://core-a.test' },
      { instance_id: 'b', name: 'B', gateway_endpoint: 'https://core-b.test', proxy_endpoint: 'https://proxy-b.test' },
    ]);
  });
});

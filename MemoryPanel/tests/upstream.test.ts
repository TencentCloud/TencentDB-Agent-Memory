import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { InstanceRegistry } from '../src/panel/config/instance-registry.js';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import { registerUpstreamTestRoute } from '../src/panel/http/routes/upstream-test.js';
import { registerMetaProxyRoutes } from '../src/panel/http/routes/meta/proxy.js';
import { UPSTREAM_CLIENTS } from '../src/panel/api/upstream-clients.js';
const invoke = vi.fn();
const upstream = vi.fn();
const internal = vi.fn();
let app: Hono;
beforeEach(() => {
  invoke.mockReset().mockResolvedValue({ code: 0, data: { valid: true, user: { user_type: 'system_admin' } } });
  internal.mockReset().mockResolvedValue({ code: 0, data: { items: [{ agent_source: 'claude-code', base_url: 'https://provider.example/v1', api_key: 'stored-provider-key' }] } });
  upstream.mockReset().mockImplementation(async (url: string) => Response.json(url.endsWith('/messages')
    ? { content: [{ type: 'text', text: 'OK' }] }
    : url.endsWith('/responses') ? { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }] }
    : { choices: [{ message: { role: 'assistant', content: 'OK' } }] }));
  vi.stubGlobal('fetch', upstream);
  app = new Hono();
  const deps = { instanceRegistry: new InstanceRegistry([{ instance_id: 'a', name: 'A', gateway_endpoint: 'http://core', api_key: 'core-secret' }]), metaKernel: { invoke }, kernelHttp: { postEnvelope: internal } } as unknown as PanelDeps;
  registerUpstreamTestRoute(app, deps);
  registerMetaProxyRoutes(app, deps);
});
afterEach(() => vi.unstubAllGlobals());
const draft = { agent_source: 'claude-code', base_url: 'https://provider.example/v1', api_key: 'provider-secret', model_id: 'model' };
const call = (body: unknown = draft, action = 'test') => app.request('/meta/instance-upstream/' + action, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-tdai-service-id': 'a', 'x-tdai-user-key': 'sk-mem-private' }, body: JSON.stringify(body),
});
it.each(UPSTREAM_CLIENTS)('$name tests required protocols without forwarding Memory credentials', async (client) => {
  const r = await (await call({ ...draft, agent_source: client.id })).json();
  expect(r.data.results).toEqual(client.protocols.map((protocol) => ({ protocol, status: 'ready' })));
  expect(upstream).toHaveBeenCalledTimes(client.protocols.length);
  for (const [, init] of upstream.mock.calls) {
    expect(JSON.stringify(init)).not.toMatch(/sk-mem-private|core-secret/);
    expect(JSON.stringify(init.headers)).toContain('provider-secret');
    expect(init.redirect).toBe('error');
    expect(JSON.parse(init.body).model).toBe('model');
  }
  expect(invoke.mock.calls.every(([action]) => action === 'auth/verify')).toBe(true);
});
it('denies non-administrators before contacting the provider', async () => {
  invoke.mockResolvedValue({ code: 0, data: { valid: true, user: { user_type: 'member' } } });
  expect((await call()).status).toBe(403); expect(upstream).not.toHaveBeenCalled();
});
it.each([
  { api_key: 'sk-mem-do-not-send' }, { base_url: 'file:///etc/passwd' },
  { base_url: 'https://user:password@provider.example' }, { base_url: 'https://provider.example?key=hidden' },
  { base_url: 'https://provider.example/v1/messages' }, { agent_source: 'unknown' }, { model_id: '' },
])('rejects invalid draft %j without a network call', async (patch) => {
  expect((await call({ ...draft, ...patch })).status).toBe(400); expect(upstream).not.toHaveBeenCalled();
});
it('does not expose the upstream error body or treat HTTP success as model success', async () => {
  upstream.mockResolvedValueOnce(new Response('provider-secret', { status: 401 }));
  let r = await (await call()).json();
  expect(r.data.results).toEqual([{ protocol: 'anthropic', status: 'http_error', httpStatus: 401 }]);
  expect(JSON.stringify(r)).not.toContain('provider-secret');
  upstream.mockResolvedValueOnce(Response.json({ status: 'healthy' }));
  r = await (await call()).json(); expect(r.data.results[0].status).toBe('invalid_response');
});
it('reports output exhaustion and network errors independently for WorkBuddy', async () => {
  upstream.mockResolvedValueOnce(Response.json({ choices: [{ finish_reason: 'length' }] })).mockRejectedValueOnce(new Error('secret-url'));
  const r = await (await call({ ...draft, agent_source: 'workbuddy' })).json();
  expect(r.data.results).toEqual([{ protocol: 'chat', status: 'output_limited' }, { protocol: 'responses', status: 'unreachable' }]);
});
it.each(['list', 'set', 'reset'])('reuses Core %s with the caller identity and no credential readback', async (action) => {
  invoke.mockResolvedValue({ code: 0, data: { items: [], api_key_masked: '****' } });
  const r = await call({ agent_source: 'codex', type: 'conversation' }, action);
  expect(r.status).toBe(200);
  expect(invoke.mock.calls[0][0]).toBe('instance-upstream/' + action);
  expect(invoke.mock.calls[0][2].userKey).toBe('sk-mem-private');
});

it('uses a saved key only for its exact client, and never returns it', async () => {
  const response = await (await call({ ...draft, api_key: undefined })).json();
  expect(response.data.results[0].status).toBe('ready');
  expect(upstream.mock.calls[0][1].headers['x-api-key']).toBe('stored-provider-key');
  expect(JSON.stringify(response)).not.toContain('stored-provider-key');
  upstream.mockClear();
  expect((await call({ ...draft, api_key: undefined, base_url: 'https://other.example/v1' })).status).toBe(200);
  upstream.mockClear();
  expect((await call({ ...draft, api_key: undefined, agent_source: 'codex' })).status).toBe(400);
  expect(upstream).not.toHaveBeenCalled();
});
it('does not read stored keys for non-admin users', async () => {
  invoke.mockResolvedValue({ code: 0, data: { valid: true, user: { user_type: 'member' } } });
  expect((await call({ ...draft, api_key: undefined })).status).toBe(403);
  expect(internal).not.toHaveBeenCalled();
});
it('Core retains an omitted key when editing the URL and accepts explicit replacement', async () => {
  const { MetadataService } = await import('../../MemoryCore/src/metadata/service/metadata-service.js');
  const row = { agent_source: 'claude-code', type: 'conversation', base_url: draft.base_url, api_key: 'saved-secret' };
  const store = { getInstanceUpstreamConfig: vi.fn().mockResolvedValue(row), upsertInstanceUpstreamConfig: vi.fn(async (value) => value) };
  const service = new MetadataService(store as any);
  await service.setInstanceUpstreamConfig({ ...draft, mode: 'custom_unified', api_key: undefined });
  expect(store.upsertInstanceUpstreamConfig.mock.calls[0][0].api_key).toBe('saved-secret');
  await service.setInstanceUpstreamConfig({ ...draft, mode: 'custom_unified', api_key: undefined, base_url: 'https://other.example' });
  expect(store.upsertInstanceUpstreamConfig.mock.calls[1][0].api_key).toBe('saved-secret');
  await service.setInstanceUpstreamConfig({ ...draft, mode: 'custom_unified', api_key: 'replacement' });
  expect(store.upsertInstanceUpstreamConfig.mock.calls[2][0].api_key).toBe('replacement');
});

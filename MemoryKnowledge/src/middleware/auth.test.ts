import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServiceAuthMiddleware } from './auth.js';

function app(strict = true) {
  const api = new Hono();
  api.use('*', createServiceAuthMiddleware({ serviceKey: 'internal-fixture',
    ...(strict ? { readAuthBaseUrl: 'http://panel-fixture' } : {}) }, '/v3'));
  api.post('*', async c => c.json({ received: await c.req.json() }));
  api.get('*', c => c.json({ ok: true }));
  return api;
}

function request(body: unknown = { knowledge_id: 'wiki-fixture', tool_name: 'search', params: {} },
  headers: Record<string, string> = { 'x-tdai-user-key': 'project-fixture' }) {
  return { method: 'POST', headers: { 'content-type': 'application/json',
    'x-tdai-service-id': 'default', ...headers }, body: JSON.stringify(body) };
}

afterEach(() => vi.unstubAllGlobals());

describe('project read authorization', () => {
  it('requires a user key before looking up a known asset', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    expect((await app().request('/v3/tools/call', request(undefined, {}))).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('authorizes the resource with the caller key and preserves the downstream body', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ code: 0, data: { wiki_id: 'wiki-fixture' } }));
    vi.stubGlobal('fetch', fetcher);
    const response = await app().request('/v3/tools/call', request({
      knowledge_id: 'wiki-fixture', tool_name: 'search', params: { query: 'needle' },
      team_id: 'forged-team', user_id: 'forged-user',
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).received.params.query).toBe('needle');
    expect(fetcher).toHaveBeenCalledWith('http://panel-fixture/api/v1/knowledge/wiki/get',
      expect.objectContaining({ headers: expect.objectContaining({ 'x-tdai-user-key': 'project-fixture' }),
        body: JSON.stringify({ wiki_id: 'wiki-fixture' }), redirect: 'error' }));
  });

  it.each([403, 404])('rejects inaccessible resources (%i)', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ code: status, data: null }, { status })));
    expect((await app().request('/v3/tools/call', request())).status).toBe(403);
  });

  it('rejects application errors even with HTTP 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ code: 403, data: null })));
    expect((await app().request('/v3/tools/list', request())).status).toBe(403);
  });

  it('fails closed on authorization service failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect((await app().request('/v3/tools/call', request())).status).toBe(503);
  });

  it('protects direct page reads and code graphs as well as tool calls', async () => {
    const fetcher = vi.fn().mockImplementation(async () => Response.json({ code: 0, data: {} }));
    vi.stubGlobal('fetch', fetcher);
    expect((await app().request('/v3/wiki/page/read', request({ wiki_id: 'wiki-fixture', refs: ['a'] }))).status).toBe(200);
    expect((await app().request('/v3/tools/call', request({ knowledge_id: 'cg-fixture' }))).status).toBe(200);
    expect(fetcher).toHaveBeenLastCalledWith('http://panel-fixture/api/v1/knowledge/code-graph/get',
      expect.objectContaining({ body: JSON.stringify({ code_graph_id: 'cg-fixture' }) }));
  });

  it('does not authorize general lists, metadata endpoints, or untrusted IDs', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    for (const path of ['/v3/wiki/list', '/v3/code-graph/list']) {
      expect((await app().request(path, request({ team_id: 'forged-team',
        wiki_id: 'wiki-fixture', code_graph_id: 'cg-fixture' }))).status).toBe(403);
    }
    expect((await app().request('/v3/source-credential/status', {
      headers: { 'x-tdai-user-key': 'project-fixture' },
    })).status).toBe(403);
    expect((await app().request('/v3/tools/call', request({ knowledge_id: '../wiki-secret' }))).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps service-to-service calls and explicit trusted-network mode working', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    expect((await app().request('/v3/wiki/list', request({}, { authorization: 'Bearer internal-fixture' }))).status).toBe(200);
    expect((await app(false).request('/v3/tools/call', request(undefined, {}))).status).toBe(200);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses strict mode without a service key or a trusted HTTP URL', () => {
    for (const config of [{ serviceKey: '', readAuthBaseUrl: 'http://panel-fixture' },
      { serviceKey: 'fixture', readAuthBaseUrl: 'file:///tmp/a' }]) {
      expect(() => createServiceAuthMiddleware(config, '/v3')).toThrow();
    }
  });
});

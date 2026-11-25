import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { registerKnowledgeWikiRoutes } from '../../src/panel/http/routes/knowledge/wiki-routes.js';
import type { PanelDeps } from '../../src/panel/panel-deps.js';
import { HttpKnowledgeClient } from '../../src/panel/kernel/adapters/http-knowledge-client.js';

function setup(options: { allowed?: boolean; owner?: string; type?: string; metaFailure?: boolean; metaThrow?: boolean } = {}) {
  const wiki = { wiki_id: 'wiki-1', name: 'Original', status: 'ready', page_count: 3 };
  const wikiGet = vi.fn(async () => ({ ...wiki }));
  const wikiUpdateMeta = vi.fn(async (_id: string, patch: { name: string }) => ({ ...wiki, name: patch.name }));
  const invoke = vi.fn(async (action: string) => {
    const data: Record<string, unknown> = {
      'auth/verify': { valid: true, user: { user_id: 'owner' } },
      'asset/get': { asset_id: wiki.wiki_id, name: wiki.name, asset_type: options.type ?? 'llm_wiki', owner_user_id: options.owner ?? 'owner', team_id: 'team-1' },
      'acl/check': { allowed: options.allowed ?? true },
      'team-member/get': { user_id: 'owner' },
      'asset/update': { name: 'Renamed' },
    };
    if (action === 'asset/update' && options.metaThrow) throw new Error('connection failed');
    if (action === 'asset/update' && options.metaFailure) return { code: 503, message: 'unavailable', data: null, request_id: '' };
    if (!(action in data)) throw new Error(`Unexpected mutation: ${action}`);
    return { code: 0, message: 'ok', data: data[action], request_id: '' };
  });
  const deps = {
    instanceRegistry: { resolve: () => ({ instance_id: 'test', gateway_endpoint: 'http://localhost', api_key: 'key' }) },
    metaKernel: { invoke },
    knowledgeClientFactory: () => ({ wikiGet, wikiUpdateMeta }),
  } as unknown as PanelDeps;
  const app = new Hono();
  registerKnowledgeWikiRoutes(app, deps);
  const request = (body: unknown = { wiki_id: 'wiki-1', name: '  Renamed  ' }) => app.request('/knowledge/wiki/update-meta', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-tdai-service-id': 'test', 'x-tdai-user-key': 'user-key' }, body: JSON.stringify(body),
  });
  return { request, invoke, wikiGet, wikiUpdateMeta };
}

describe('Wiki rename', () => {
  it('trims the name and updates both metadata stores without changing identity or content', async () => {
    const { request, invoke, wikiUpdateMeta } = setup();
    const res = await request();
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ wiki_id: 'wiki-1', name: 'Renamed', status: 'ready', page_count: 3 });
    expect(wikiUpdateMeta).toHaveBeenCalledTimes(1);
    expect(wikiUpdateMeta).toHaveBeenCalledWith('wiki-1', { name: 'Renamed' });
    expect(invoke).toHaveBeenCalledWith('asset/update', { asset_id: 'wiki-1', name: 'Renamed' }, expect.anything());
    expect(invoke.mock.calls.map(([action]) => action)).toEqual(['auth/verify', 'asset/get', 'acl/check', 'team-member/get', 'asset/update']);
  });

  it.each(['', '   ', null, 123])('rejects invalid name %s without writes', async (name) => {
    const { request, wikiUpdateMeta, invoke } = setup();
    expect((await request({ wiki_id: 'wiki-1', name })).status).toBe(400);
    expect(wikiUpdateMeta).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([{ allowed: false }, { owner: 'other' }])('rejects unauthorized callers before changing KS: %j', async (options) => {
    const { request, wikiUpdateMeta } = setup(options);
    expect((await request()).status).toBe(403);
    expect(wikiUpdateMeta).not.toHaveBeenCalled();
  });

  it('rejects non-Wiki assets', async () => {
    const { request, wikiUpdateMeta } = setup({ type: 'code_graph' });
    expect((await request()).status).toBe(400);
    expect(wikiUpdateMeta).not.toHaveBeenCalled();
  });

  it('does not change Hub metadata when KS fails', async () => {
    const { request, wikiUpdateMeta, invoke } = setup();
    wikiUpdateMeta.mockRejectedValueOnce(new Error('KS down'));
    expect((await request()).status).toBe(502);
    expect(invoke.mock.calls.some(([action]) => action === 'asset/update')).toBe(false);
  });

  it.each([{ metaFailure: true }, { metaThrow: true }])('restores the prior KS name on Hub failure: %j', async (options) => {
    const { request, wikiUpdateMeta } = setup(options);
    expect((await request()).status).toBeGreaterThanOrEqual(500);
    expect(wikiUpdateMeta.mock.calls).toEqual([['wiki-1', { name: 'Renamed' }], ['wiki-1', { name: 'Original' }]]);
  });

  it('reports compensation failure instead of success', async () => {
    const { request, wikiUpdateMeta } = setup({ metaFailure: true });
    wikiUpdateMeta.mockResolvedValueOnce({ wiki_id: 'wiki-1', name: 'Renamed', status: 'ready', page_count: 3 }).mockRejectedValueOnce(new Error('KS down'));
    const res = await request();
    expect(res.status).toBe(502);
    expect((await res.json()).message).toBe('WIKI_RENAME_SYNC_FAILED');
  });

  it('forwards the rename to the existing KS metadata endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { wiki_id: 'wiki-1', name: '名称' } })));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const client = new HttpKnowledgeClient({ baseUrl: 'http://ks', authToken: 'token', serviceId: 'test' });
      await expect(client.wikiUpdateMeta('wiki-1', { name: '名称' })).resolves.toEqual({ wiki_id: 'wiki-1', name: '名称' });
      expect(fetchMock).toHaveBeenCalledWith('http://ks/v3/wiki/update-meta', expect.objectContaining({ method: 'POST', body: JSON.stringify({ wiki_id: 'wiki-1', name: '名称' }) }));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

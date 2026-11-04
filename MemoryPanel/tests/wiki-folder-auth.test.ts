import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { registerKnowledgeWikiRoutes } from '../src/panel/http/routes/knowledge/wiki-routes.js';
import type { PanelDeps } from '../src/panel/panel-deps.js';

// Configuration only; the real header middleware and membership gate run below.
vi.mock('../src/panel/config/panel-config.js', () => ({
  loadPanelConfig: () => ({ wiki: { textFileMaxBytes: 524288, binaryFileMaxBytes: 10485760 } }),
}));

function fixture() {
  const wikiRawWrite = vi.fn(async () => ({ items: [] }));
  const invoke = vi.fn(async (action: string, args: Record<string, string>) => {
    if (action === 'auth/verify')
      return {
        code: 0,
        data: { valid: args.user_key === 'alice-key', user: { user_id: 'alice' } },
      };
    if (action === 'team-member/get')
      return {
        code: 0,
        data: args.team_id === 'team-a' && args.user_id === 'alice' ? { role: 'member' } : null,
      };
    throw new Error(`Unexpected kernel call: ${action}`);
  });
  const clientFactory = vi.fn(() => ({ wikiRawWrite, wikiFormats: async () => ({ items: [] }) }));
  const deps = {
    instanceRegistry: {
      resolve: (instance: string) => ({
        instance_id: instance,
        gateway_endpoint: 'http://unused',
        api_key: 'test',
      }),
    },
    metaKernel: { invoke },
    knowledgeClientFactory: clientFactory,
  } as unknown as PanelDeps;
  const app = new Hono();
  registerKnowledgeWikiRoutes(app, deps);
  const post = (team: string, key = 'alice-key') =>
    app.request('/knowledge/wiki/raw/write', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tdai-Service-Id': 'service-a',
        'X-Tdai-User-Key': key,
      },
      body: JSON.stringify({
        team_id: team,
        wiki_id: 'wiki-a',
        files: [{ filename: 'handbook/nested/README.md', content: 'YWxwaGE=', encoding: 'base64' }],
      }),
    });
  return { post, wikiRawWrite, invoke, clientFactory };
}

describe('folder upload team authorization', () => {
  it('passes the authenticated service, team, user and relative source path to Knowledge', async () => {
    const f = fixture();
    expect((await f.post('team-a')).status).toBe(200);
    expect(f.clientFactory).toHaveBeenCalledWith('service-a');
    expect(f.wikiRawWrite).toHaveBeenCalledTimes(1);
    expect(f.wikiRawWrite).toHaveBeenCalledWith(
      'team-a',
      'wiki-a',
      [{ filename: 'handbook/nested/README.md', content: 'YWxwaGE=', encoding: 'base64' }],
      'alice',
    );
  });
  it('rejects a forged team before any source write', async () => {
    const f = fixture();
    const response = await f.post('team-b');
    expect(response.status).toBe(403);
    expect((await response.json()).message).toContain('NOT_TEAM_MEMBER');
    expect(f.wikiRawWrite).not.toHaveBeenCalled();
  });
  it('rejects an invalid user key before any source write', async () => {
    const f = fixture();
    expect((await f.post('team-a', 'invalid')).status).toBe(401);
    expect(f.wikiRawWrite).not.toHaveBeenCalled();
    expect(f.invoke.mock.calls.some(([action]) => action === 'team-member/get')).toBe(false);
  });
});

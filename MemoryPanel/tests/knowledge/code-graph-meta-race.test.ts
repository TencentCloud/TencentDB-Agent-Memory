import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { CoreUpstreamError } from '../../src/panel/domain/errors.js';
import { registerKnowledgeCodeGraphRoutes } from '../../src/panel/http/routes/knowledge/code-graph-routes.js';
import { KnowledgeTaskRegistry } from '../../src/panel/state/knowledge-task-registry.js';
import type { PanelDeps } from '../../src/panel/panel-deps.js';

function fixture() {
  const app = new Hono();
  let ksGone = false;
  let metaExists = false;
  const detail = {
    code_graph_id: 'cg-1', team_id: 'team-1', owner_user_id: 'owner-1', status: 'ready',
    repo_name: 'repo', repo_url: 'https://example.com/repo', branch: 'main', service_url: 'https://example.com/knowledge',
  };
  const ksGet = vi.fn(async () => {
    if (ksGone) throw new CoreUpstreamError('CORE_UPSTREAM_ERROR', 404, 'not found');
    return detail;
  });
  const metaInvoke = vi.fn(async (action: string, body?: { asset_id?: string; asset_ids?: string[] }) => {
    if (action === 'auth/verify') return { code: 0, data: { valid: true, user: { user_id: 'owner-1' } } };
    if (action === 'team-member/get') return { code: 0, data: { user_id: 'owner-1' } };
    if (action === 'asset/get') return metaExists
      ? { code: 0, data: { asset_id: 'cg-1', asset_type: 'code_graph', team_id: 'team-1', owner_user_id: 'owner-1' } }
      : { code: 404, data: null };
    if (action === 'asset/create') {
      // The remote write commits, a different Panel process deletes KS, and
      // the response to this process is lost.
      metaExists = true;
      ksGone = true;
      return { code: 502, data: null };
    }
    if (action === 'asset/delete') {
      metaExists = false;
      return { code: 0, data: { deleted_ids: body?.asset_ids ?? [], failed: [] } };
    }
    throw new Error(`unexpected meta action ${action}`);
  });
  const deps = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    config: { metadataRemoteTimeoutMs: 5000 },
    instanceRegistry: { resolve: () => ({ instance_id: 'svc-1', gateway_endpoint: 'http://meta.test', api_key: 'key' }) },
    metaKernel: { invoke: metaInvoke },
    knowledgeTaskRegistry: new KnowledgeTaskRegistry(),
    knowledgeClientFactory: () => ({ codeGraphGet: ksGet, codeGraphCreate: async () => detail }),
  } as unknown as PanelDeps;
  registerKnowledgeCodeGraphRoutes(app, deps);
  const headers = { 'content-type': 'application/json', 'x-tdai-service-id': 'svc-1', 'x-tdai-user-key': 'owner-key' };
  return { app, headers, metaInvoke, ksGet, metaExists: () => metaExists };
}

describe('CodeGraph meta registration and concurrent delete', () => {
  it('cleans an uncertain meta create from the ready-on-create path', async () => {
    const f = fixture();
    const response = await f.app.request('/knowledge/code-graph/create', {
      method: 'POST', headers: f.headers,
      body: JSON.stringify({ team_id: 'team-1', repo_url: 'https://example.com/repo' }),
    });
    expect(response.status).toBe(409);
    expect(f.metaExists()).toBe(false);
    expect(f.metaInvoke).toHaveBeenCalledWith('asset/delete', { asset_ids: ['cg-1'] }, expect.anything());
  });

  it('cleans an uncertain meta create from the explicit register path', async () => {
    const f = fixture();
    const response = await f.app.request('/knowledge/code-graph/register-meta', {
      method: 'POST', headers: f.headers,
      body: JSON.stringify({ team_id: 'team-1', code_graph_id: 'cg-1' }),
    });
    expect(response.status).toBe(409);
    expect(f.metaExists()).toBe(false);
    expect(f.metaInvoke).toHaveBeenCalledWith('asset/delete', { asset_ids: ['cg-1'] }, expect.anything());
  });
});

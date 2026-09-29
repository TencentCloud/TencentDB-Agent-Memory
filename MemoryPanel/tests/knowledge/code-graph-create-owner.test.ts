import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { registerKnowledgeCodeGraphRoutes } from '../../src/panel/http/routes/knowledge/code-graph-routes.js';
import { registerKnowledgeCallbackRoutes } from '../../src/panel/http/routes/knowledge/callback-routes.js';
import { KnowledgeTaskRegistry } from '../../src/panel/state/knowledge-task-registry.js';
import { ensureKnowledgeAsset } from '../../src/panel/http/routes/knowledge/common.js';
import type { PanelDeps } from '../../src/panel/panel-deps.js';

function fixture(ksOwner: string, options: { readyOnRecheck?: boolean; callbackBeforeCreateReturns?: boolean } = {}) {
  const app = new Hono();
  const taskRegistry = new KnowledgeTaskRegistry();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const metaInvoke = vi.fn(async (action: string) => {
    if (action === 'auth/verify') {
      return { code: 0, message: 'ok', data: { valid: true, user: { user_id: 'user-b' } } };
    }
    if (action === 'team-member/get') {
      return { code: 0, message: 'ok', data: { user_id: 'user-b' } };
    }
    if (action === 'asset/get') return { code: 404, message: 'not found', data: null };
    if (action === 'asset/create') return { code: 0, message: 'ok', data: { asset_id: 'cg-1' } };
    throw new Error(`unexpected meta action ${action}`);
  });
  const detail = {
    code_graph_id: 'cg-1', team_id: 'team-1', repo_name: 'repo',
    repo_url: 'https://example.com/repo', branch: 'main',
    owner_user_id: ksOwner, status: 'pending', service_url: 'https://example.com/knowledge',
  };
  const codeGraphGet = vi.fn(async () => ({
    ...detail, status: options.readyOnRecheck ? 'ready' : 'pending',
  }));
  const codeGraphCreate = vi.fn(async () => {
    if (options.callbackBeforeCreateReturns) {
      const response = await app.request('/knowledge/status-callback', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          knowledge_id: 'cg-1', service_id: 'svc-1', type: 'code-graph',
          status: 'ready', summary: 'summary',
        }),
      });
      expect(response.status).toBe(200);
    }
    return detail;
  });
  const deps = {
    logger,
    config: { metadataRemoteTimeoutMs: 5000 },
    instanceRegistry: {
      resolve: vi.fn(() => ({ instance_id: 'svc-1', gateway_endpoint: 'https://example.com', api_key: 'key' })),
    },
    metaKernel: { invoke: metaInvoke },
    knowledgeClientFactory: () => ({ codeGraphCreate, codeGraphGet }),
    kernelHttp: { postEnvelope: vi.fn(async (path: string) => path === '/v3/knowledge/get'
      ? { code: 404, message: 'not found', data: null }
      : { code: 0, message: 'ok', data: null }) },
    knowledgeTaskRegistry: taskRegistry,
  } as unknown as PanelDeps;
  registerKnowledgeCodeGraphRoutes(app, deps);
  registerKnowledgeCallbackRoutes(app, deps);
  const post = () => app.request('/knowledge/code-graph/create', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tdai-service-id': 'svc-1',
      'x-tdai-user-key': 'key-b',
    },
    body: JSON.stringify({ team_id: 'team-1', repo_url: 'https://example.com/repo' }),
  });
  return { post, taskRegistry, codeGraphCreate, codeGraphGet, metaInvoke, logger };
}

describe('CodeGraph idempotent create owner credential', () => {
  it('refuses to treat a conflicting existing meta asset as an idempotent registration', async () => {
    const metaInvoke = vi.fn(async () => ({
      code: 0, message: 'ok', data: {
        asset_id: 'cg-1', asset_type: 'code_graph', team_id: 'other-team', owner_user_id: 'other-user',
      },
    }));
    const deps = { metaKernel: { invoke: metaInvoke }, logger: { info: vi.fn(), error: vi.fn() } } as unknown as PanelDeps;
    const result = await ensureKnowledgeAsset(deps, {
      instanceId: 'svc-1', gatewayEndpoint: 'http://meta.test', gatewayApiKey: 'key', userKey: 'owner-key',
    }, {
      assetId: 'cg-1', assetType: 'code_graph', teamId: 'team-1', ownerUserId: 'owner-1', name: 'repo',
    });
    expect(result).toMatchObject({ ok: false, env: { code: 409 } });
    expect(metaInvoke).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite A’s credential when B receives A’s existing asset', async () => {
    const f = fixture('user-a', { readyOnRecheck: true });
    f.taskRegistry.record({
      knowledge_id: 'cg-1', type: 'code-graph', team_id: 'team-1',
      owner_user_id: 'user-a', owner_user_key: 'key-a', service_id: 'svc-1',
      created_at: Date.now(),
    });

    const response = await f.post();

    expect(response.status).toBe(200);
    expect(f.codeGraphCreate).toHaveBeenCalledWith('team-1', 'https://example.com/repo', undefined, 'user-b', undefined);
    expect(f.codeGraphGet).not.toHaveBeenCalled();
    expect(f.metaInvoke).not.toHaveBeenCalledWith('asset/create', expect.anything(), expect.anything());
    expect(f.taskRegistry.peek('cg-1')).toMatchObject({ owner_user_id: 'user-a', owner_user_key: 'key-a' });
  });

  it('stashes the key when the verified caller is the KS owner', async () => {
    const f = fixture('user-b');

    const response = await f.post();

    expect(response.status).toBe(200);
    expect(f.taskRegistry.peek('cg-1')).toMatchObject({
      owner_user_id: 'user-b', owner_user_key: 'key-b', team_id: 'team-1', service_id: 'svc-1',
    });
  });

  it('registers with the real owner when ready callback beats the create response', async () => {
    const f = fixture('user-b', { readyOnRecheck: true, callbackBeforeCreateReturns: true });

    const response = await f.post();

    expect(response.status).toBe(200);
    expect(f.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('no in-memory task stash'),
      expect.objectContaining({ knowledge_id: 'cg-1' }),
    );
    // Both callback and create re-read KS after registering meta so a delete
    // that raced their writes cannot leave a stale binding behind.
    expect(f.codeGraphGet).toHaveBeenCalledTimes(4);
    expect(f.metaInvoke).toHaveBeenCalledWith(
      'asset/create',
      expect.objectContaining({ asset_id: 'cg-1', owner_user_id: 'user-b' }),
      expect.objectContaining({ userKey: 'key-b', instanceId: 'svc-1' }),
    );
    expect(f.taskRegistry.peek('cg-1')).toBeUndefined();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { registerKnowledgeCallbackRoutes } from '../../src/panel/http/routes/knowledge/callback-routes.js';
import type { PanelDeps } from '../../src/panel/panel-deps.js';
import { KnowledgeTaskRegistry, type KnowledgeTask } from '../../src/panel/state/knowledge-task-registry.js';

function fixture(opts: { summary?: string } = {}) {
  const app = new Hono();
  const taskRegistry = new KnowledgeTaskRegistry();
  const kernelCreate = vi.fn(async (path: string) => path === '/v3/knowledge/get'
    ? { code: 404, message: 'not found', data: null }
    : { code: 0, message: 'ok', data: null });
  let assetCreated = false;
  const metaInvoke = vi.fn(async (action: string) => {
    if (action === 'asset/get') return assetCreated
      ? { code: 0, message: 'ok', data: { asset_id: 'cg-1', asset_type: 'code_graph', team_id: 'team-1', owner_user_id: 'user-1' } }
      : { code: 404, message: 'not found', data: null };
    if (action === 'asset/create') assetCreated = true;
    return { code: 0, message: 'ok', data: { asset_id: 'cg-1' } };
  });
  const codeGraphGet = vi.fn(async () => ({
    code_graph_id: 'cg-1', team_id: 'team-1', repo_name: 'repo', repo_url: 'https://example.com/repo',
    branch: 'main', owner_user_id: 'user-1', service_url: 'https://example.com/knowledge', status: 'ready',
    summary: opts.summary ?? null,
  }));
  const resolve = vi.fn(() => ({ instance_id: 'svc-1', gateway_endpoint: 'https://example.com', api_key: 'key' }));
  const deps = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    config: { metadataRemoteTimeoutMs: 5000 },
    instanceRegistry: { resolve },
    knowledgeClientFactory: () => ({ codeGraphGet }),
    kernelHttp: { postEnvelope: kernelCreate },
    metaKernel: { invoke: metaInvoke },
    knowledgeTaskRegistry: taskRegistry,
  } as unknown as PanelDeps;
  registerKnowledgeCallbackRoutes(app, deps);
  const post = (body: Record<string, unknown>) => app.request('/knowledge/status-callback', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { post, kernelCreate, codeGraphGet, resolve, metaInvoke, taskRegistry };
}

function task(patch: Partial<KnowledgeTask> = {}): KnowledgeTask {
  return {
    knowledge_id: 'cg-1', type: 'code-graph', team_id: 'team-1',
    owner_user_id: 'user-1', owner_user_key: 'owner-key', service_id: 'svc-1',
    created_at: Date.now(), ...patch,
  };
}

describe('CodeGraph status callback', () => {
  it('records a preserved refresh failure without rewriting the previous entity', async () => {
    const f = fixture();
    const response = await f.post({
      knowledge_id: 'cg-1', service_id: 'svc-1', type: 'code-graph', status: 'ready',
      event: 'refresh_failed', summary: 'old summary', sync_error: 'Git unavailable',
    });

    expect(response.status).toBe(200);
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.codeGraphGet).not.toHaveBeenCalled();
    expect(f.kernelCreate).not.toHaveBeenCalled();
  });

  it('still writes the entity for a later successful refresh', async () => {
    const f = fixture();
    const response = await f.post({
      knowledge_id: 'cg-1', service_id: 'svc-1', type: 'code-graph', status: 'ready',
      summary: 'new summary', sync_error: null,
    });

    expect(response.status).toBe(200);
    expect(f.codeGraphGet).toHaveBeenCalledTimes(2);
    expect(f.kernelCreate).toHaveBeenCalledWith('/v3/knowledge/create', expect.anything(), expect.anything());
  });

  it.each([
    ['service', { service_id: 'svc-2' }],
    ['team', { team_id: 'team-2' }],
    ['owner', { owner_user_id: 'user-2' }],
    ['type', { type: 'wiki' as const }],
  ])('does not register meta with a mismatched %s credential', async (_name, patch) => {
    const f = fixture();
    f.taskRegistry.record(task(patch));
    const response = await f.post({
      knowledge_id: 'cg-1', service_id: 'svc-1', type: 'code-graph', status: 'ready',
      summary: 'summary',
    });

    expect(response.status).toBe(200);
    expect(f.kernelCreate).toHaveBeenCalledWith('/v3/knowledge/create', expect.anything(), expect.anything());
    expect(f.metaInvoke).not.toHaveBeenCalled();
    expect(f.taskRegistry.peek('cg-1')).toBeUndefined();
  });

  it('registers meta only with the matching KS owner credential', async () => {
    const f = fixture();
    f.taskRegistry.record(task());
    const response = await f.post({
      knowledge_id: 'cg-1', service_id: 'svc-1', type: 'code-graph', status: 'ready',
      summary: 'summary',
    });

    expect(response.status).toBe(200);
    expect(f.metaInvoke).toHaveBeenCalledWith(
      'asset/create',
      expect.objectContaining({ asset_id: 'cg-1', owner_user_id: 'user-1', team_id: 'team-1' }),
      expect.objectContaining({ userKey: 'owner-key', instanceId: 'svc-1' }),
    );
    expect(f.taskRegistry.peek('cg-1')).toBeUndefined();
  });

  it('does not register meta after Core rejects the entity write', async () => {
    const f = fixture();
    f.taskRegistry.record(task());
    f.kernelCreate.mockImplementation(async (path: string) => path === '/v3/knowledge/get'
      ? { code: 404, message: 'not found', data: null }
      : { code: 503, message: 'unavailable', data: null });
    const response = await f.post({
      knowledge_id: 'cg-1', service_id: 'svc-1', type: 'code-graph', status: 'ready', summary: 'summary',
    });

    expect(response.status).toBe(200);
    expect(f.metaInvoke).not.toHaveBeenCalled();
    expect(f.taskRegistry.peek('cg-1')).toBeDefined();
  });

  it('uses the current Knowledge summary when an older ready callback arrives late', async () => {
    const f = fixture({ summary: 'newer summary' });
    const response = await f.post({
      knowledge_id: 'cg-1', service_id: 'svc-1', type: 'code-graph', status: 'ready', summary: 'older summary',
    });

    expect(response.status).toBe(200);
    expect(f.kernelCreate).toHaveBeenCalledWith(
      '/v3/knowledge/create', expect.objectContaining({ summary: 'newer summary' }), expect.anything(),
    );
  });
});

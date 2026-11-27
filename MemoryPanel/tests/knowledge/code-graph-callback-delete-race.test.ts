import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { CoreUpstreamError } from '../../src/panel/domain/errors.js';
import { registerKnowledgeCallbackRoutes } from '../../src/panel/http/routes/knowledge/callback-routes.js';
import { registerKnowledgeCodeGraphRoutes } from '../../src/panel/http/routes/knowledge/code-graph-routes.js';
import type { PanelDeps } from '../../src/panel/panel-deps.js';
import { KnowledgeTaskRegistry } from '../../src/panel/state/knowledge-task-registry.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

type LostWriteResponse = 'nonzero' | 'throw';

function fixture(opts: {
  blockCreate?: boolean; blockDelete?: boolean; initialMeta?: boolean;
  conflictingMeta?: boolean; failFirstPostRegistrationGet?: boolean;
  conflictingCore?: 'type' | 'team' | 'owner';
  coreCreateResponse?: LostWriteResponse;
  blockMetaCreate?: boolean; metaCreateResponse?: LostWriteResponse;
} = {}) {
  const app = new Hono();
  const knowledgeRows = new Set(['cg-1']);
  const coreRows = new Set<string>(opts.conflictingCore ? ['cg-1'] : []);
  const metaRows = new Set(opts.initialMeta || opts.conflictingMeta ? ['cg-1'] : []);
  let assetCreated = false;
  let failedPostRegistrationGet = false;
  const events: string[] = [];
  const createEntered = deferred();
  const releaseCreate = deferred();
  const deleteEntered = deferred();
  const releaseDelete = deferred();
  const metaCreateEntered = deferred();
  const releaseMetaCreate = deferred();
  const taskRegistry = new KnowledgeTaskRegistry();
  taskRegistry.record({
    knowledge_id: 'cg-1', type: 'code-graph', team_id: 'team-1', owner_user_id: 'user-1',
    owner_user_key: 'owner-key', service_id: 'svc-1', created_at: Date.now(),
  });
  const detail = {
    code_graph_id: 'cg-1', team_id: 'team-1', repo_name: 'repo',
    repo_url: 'https://example.com/repo', branch: 'main', owner_user_id: 'user-1',
    service_url: 'https://example.com/knowledge', status: 'ready',
  } as const;
  const codeGraphGet = vi.fn(async () => {
    events.push('ks.get');
    if (!knowledgeRows.has('cg-1')) {
      throw new CoreUpstreamError('CORE_UPSTREAM_ERROR', 404, 'code graph not found', 40401, 'CODE_GRAPH_NOT_FOUND');
    }
    return detail;
  });
  const codeGraphDelete = vi.fn(async (ids: string[]) => {
    events.push('ks.delete.start');
    deleteEntered.resolve();
    if (opts.blockDelete) await releaseDelete.promise;
    const deleted_ids = ids.filter((id) => knowledgeRows.delete(id));
    events.push('ks.delete.done');
    return { deleted_ids, failed: ids.filter((id) => !deleted_ids.includes(id)).map((id) => ({ id, reason: 'not found' })) };
  });
  const kernelPost = vi.fn(async (path: string, body: { knowledge_id?: string; knowledge_ids?: string[] }) => {
    if (path === '/v3/knowledge/create') {
      events.push('core.create.start');
      createEntered.resolve();
      if (opts.blockCreate) await releaseCreate.promise;
      coreRows.add(body.knowledge_id!);
      events.push('core.create.done');
      if (opts.coreCreateResponse === 'nonzero') return { code: 503, data: null };
      if (opts.coreCreateResponse === 'throw') throw new Error('Core response lost');
      return { code: 0, data: null };
    }
    if (path === '/v3/knowledge/get') {
      return coreRows.has(body.knowledge_id!)
        ? { code: 0, data: {
          knowledge_id: body.knowledge_id, type: opts.conflictingCore === 'type' ? 'wiki' : 'code-graph',
          team_id: opts.conflictingCore === 'team' ? 'team-2' : 'team-1',
          user_id: opts.conflictingCore === 'owner' ? 'user-2' : 'user-1',
        } }
        : { code: 404, data: null };
    }
    if (path === '/v3/knowledge/delete') {
      events.push('core.delete');
      for (const id of body.knowledge_ids ?? []) coreRows.delete(id);
      return { code: 0, data: { deleted_ids: body.knowledge_ids ?? [], failed: [] } };
    }
    throw new Error(`unexpected Core path ${path}`);
  });
  const metaInvoke = vi.fn(async (action: string, body: { asset_id?: string; asset_ids?: string[] } = {}) => {
    if (action === 'auth/verify') return { code: 0, data: { valid: true, user: { user_id: 'user-1' } } };
    if (action === 'team-member/get') return { code: 0, data: { user_id: 'user-1' } };
    if (action === 'acl/check') return { code: 0, data: { allowed: true } };
    if (action === 'asset/get') {
      if (opts.failFirstPostRegistrationGet && assetCreated && !failedPostRegistrationGet) {
        failedPostRegistrationGet = true;
        return { code: 503, data: null };
      }
      return metaRows.has(body.asset_id ?? '')
        ? { code: 0, data: {
          asset_id: body.asset_id,
          team_id: opts.conflictingMeta ? 'other-team' : 'team-1',
          owner_user_id: 'user-1',
          asset_type: opts.conflictingMeta ? 'llm_wiki' : 'code_graph',
        } }
        : { code: 404, data: null };
    }
    if (action === 'asset/create') {
      events.push('meta.create.start');
      metaCreateEntered.resolve();
      if (opts.blockMetaCreate) await releaseMetaCreate.promise;
      assetCreated = true;
      metaRows.add(body.asset_id!);
      events.push('meta.create');
      if (opts.metaCreateResponse === 'nonzero') return { code: 503, data: null };
      if (opts.metaCreateResponse === 'throw') throw new Error('meta response lost');
      return { code: 0, data: { asset_id: body.asset_id } };
    }
    if (action === 'asset/delete') {
      events.push('meta.delete');
      for (const id of body.asset_ids ?? []) metaRows.delete(id);
      return { code: 0, data: { deleted_ids: body.asset_ids ?? [], failed: [] } };
    }
    throw new Error(`unexpected meta action ${action}`);
  });
  const deps = {
    config: { metadataRemoteTimeoutMs: 5000 },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    instanceRegistry: { resolve: () => ({ instance_id: 'svc-1', gateway_endpoint: 'https://meta.test', api_key: 'key' }) },
    knowledgeClientFactory: () => ({ codeGraphGet, codeGraphDelete }),
    kernelHttp: { postEnvelope: kernelPost },
    metaKernel: { invoke: metaInvoke },
    knowledgeTaskRegistry: taskRegistry,
  } as unknown as PanelDeps;
  registerKnowledgeCallbackRoutes(app, deps);
  registerKnowledgeCodeGraphRoutes(app, deps);
  const callback = () => app.request('/knowledge/status-callback', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ knowledge_id: 'cg-1', service_id: 'svc-1', type: 'code-graph', status: 'ready', summary: 'summary' }),
  });
  const remove = () => app.request('/knowledge/code-graph/delete', {
    method: 'POST', headers: {
      'content-type': 'application/json', 'x-tdai-service-id': 'svc-1', 'x-tdai-user-key': 'owner-key',
    },
    body: JSON.stringify({ code_graph_ids: ['cg-1'] }),
  });
  return {
    callback, remove, knowledgeRows, coreRows, metaRows, events, codeGraphGet,
    codeGraphDelete, kernelPost, createEntered, releaseCreate, deleteEntered, releaseDelete,
    metaCreateEntered, releaseMetaCreate,
  };
}

describe('CodeGraph ready callback and delete', () => {
  it('returns busy while callback owns the ID, then deletes all writes on retry', async () => {
    const f = fixture({ blockCreate: true });
    const callback = f.callback();
    await f.createEntered.promise;
    const busy = f.remove();
    await vi.waitFor(() => expect(f.codeGraphGet.mock.calls.length).toBeGreaterThan(1));
    expect(f.codeGraphDelete).not.toHaveBeenCalled();
    expect(await (await busy).json()).toMatchObject({
      data: { deleted_ids: [], failed: [{ id: 'cg-1', reason: 'busy' }] },
    });
    f.releaseCreate.resolve();

    expect((await callback).status).toBe(200);
    expect((await f.remove()).status).toBe(200);
    expect(f.events.indexOf('meta.create')).toBeLessThan(f.events.indexOf('ks.delete.start'));
    expect(f.knowledgeRows.size).toBe(0);
    expect(f.coreRows.size).toBe(0);
    expect(f.metaRows.size).toBe(0);
  });

  it('skips all callback writes when delete starts first', async () => {
    const f = fixture({ blockDelete: true, initialMeta: true });
    const remove = f.remove();
    await f.deleteEntered.promise;
    const readsAtDelete = f.codeGraphGet.mock.calls.length;
    const callback = f.callback();
    await Promise.resolve();
    expect(f.codeGraphGet).toHaveBeenCalledTimes(readsAtDelete);
    f.releaseDelete.resolve();

    expect((await remove).status).toBe(200);
    expect((await callback).status).toBe(200);
    expect(f.kernelPost).not.toHaveBeenCalledWith('/v3/knowledge/create', expect.anything(), expect.anything());
    expect(f.knowledgeRows.size).toBe(0);
    expect(f.coreRows.size).toBe(0);
    expect(f.metaRows.size).toBe(0);
  });

  it('compensates writes when a different Panel process deletes Knowledge during the callback', async () => {
    const f = fixture({ blockCreate: true });
    const callback = f.callback();
    await f.createEntered.promise;
    // Simulate a different Panel process completing its delete cascade while
    // this process's Core create request remains in flight.
    f.knowledgeRows.delete('cg-1');
    f.coreRows.delete('cg-1');
    f.metaRows.delete('cg-1');
    f.releaseCreate.resolve();

    expect((await callback).status).toBe(200);
    expect(f.events).toContain('core.create.done');
    expect(f.events).toContain('meta.create');
    expect(f.events).toContain('core.delete');
    expect(f.events).toContain('meta.delete');
    expect(f.kernelPost).toHaveBeenCalledWith(
      '/v3/knowledge/delete', { knowledge_ids: ['cg-1'], team_id: 'team-1' }, expect.anything(),
    );
    expect(f.knowledgeRows.size).toBe(0);
    expect(f.coreRows.size).toBe(0);
    expect(f.metaRows.size).toBe(0);
  });

  it('does not delete a conflicting meta asset during stale callback compensation', async () => {
    const f = fixture({ blockCreate: true, conflictingMeta: true });
    const callback = f.callback();
    await f.createEntered.promise;
    f.knowledgeRows.delete('cg-1');
    f.releaseCreate.resolve();

    expect((await callback).status).toBe(200);
    expect(f.events).toContain('core.delete');
    expect(f.events).not.toContain('meta.delete');
    expect(f.metaRows.has('cg-1')).toBe(true);
  });

  it('cleans meta after a transient post-registration read failure', async () => {
    const f = fixture({ blockCreate: true, failFirstPostRegistrationGet: true });
    const callback = f.callback();
    await f.createEntered.promise;
    f.knowledgeRows.delete('cg-1');
    f.releaseCreate.resolve();

    expect((await callback).status).toBe(200);
    expect(f.events).toContain('meta.create');
    expect(f.events).toContain('meta.delete');
    expect(f.coreRows.size).toBe(0);
    expect(f.metaRows.size).toBe(0);
  });

  it.each(['nonzero', 'throw'] as const)(
    'compensates a committed Core write after its %s result is lost', async (result) => {
      const f = fixture({ blockCreate: true, initialMeta: true, coreCreateResponse: result });
      const callback = f.callback();
      await f.createEntered.promise;
      f.knowledgeRows.delete('cg-1');
      f.releaseCreate.resolve();

      expect((await callback).status).toBe(200);
      expect(f.events).toContain('core.create.done');
      expect(f.events).toContain('core.delete');
      expect(f.events).toContain('meta.delete');
      expect(f.events).not.toContain('meta.create');
      expect(f.coreRows.size).toBe(0);
      expect(f.metaRows.size).toBe(0);
    },
  );

  it.each(['type', 'team', 'owner'] as const)(
    'preserves a conflicting Core %s identity before the ready upsert', async (identity) => {
      const f = fixture({ conflictingCore: identity });

      expect((await f.callback()).status).toBe(200);
      expect(f.kernelPost).toHaveBeenCalledWith(
        '/v3/knowledge/get', { knowledge_id: 'cg-1' }, expect.anything(),
      );
      expect(f.events).not.toContain('core.create.start');
      expect(f.events).not.toContain('meta.create');
      expect(f.events).not.toContain('core.delete');
      expect(f.coreRows.has('cg-1')).toBe(true);
    },
  );

  it.each(['nonzero', 'throw'] as const)(
    'compensates a committed meta write after its %s result is lost', async (result) => {
      const f = fixture({ blockMetaCreate: true, metaCreateResponse: result });
      const callback = f.callback();
      await f.metaCreateEntered.promise;
      f.knowledgeRows.delete('cg-1');
      f.releaseMetaCreate.resolve();

      expect((await callback).status).toBe(200);
      expect(f.events).toContain('meta.create');
      expect(f.events).toContain('core.delete');
      expect(f.events).toContain('meta.delete');
      expect(f.coreRows.size).toBe(0);
      expect(f.metaRows.size).toBe(0);
    },
  );
});

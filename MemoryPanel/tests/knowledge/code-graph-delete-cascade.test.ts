import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { registerKnowledgeCodeGraphRoutes } from '../../src/panel/http/routes/knowledge/code-graph-routes.js';
import { CoreUpstreamError } from '../../src/panel/domain/errors.js';
import type { PanelDeps } from '../../src/panel/panel-deps.js';

describe('CodeGraph delete cascade', () => {
  it('removes Core and meta records only for IDs confirmed deleted by Knowledge', async () => {
    const app = new Hono();
    const missingMeta = new Set<string>();
    const missingKs = new Set<string>();
    const missingCore = new Set<string>();
    const metaInvoke = vi.fn(async (action: string, body?: { asset_id?: string; asset_ids?: string[] }) => {
      if (action === 'auth/verify') return { code: 0, data: { valid: true, user: { user_id: 'user-1' } } };
      if (action === 'asset/get') return missingMeta.has(body?.asset_id ?? '')
        ? { code: 404, data: null }
        : { code: 0, data: { team_id: 'team-1', owner_user_id: 'user-1', asset_type: body?.asset_id === 'wiki-1' ? 'llm_wiki' : 'code_graph' } };
      if (action === 'acl/check') return { code: 0, data: { allowed: true } };
      if (action === 'team-member/get') return { code: 0, data: { user_id: 'user-1' } };
      if (action === 'asset/delete') return { code: 0, data: { deleted_ids: body?.asset_ids ?? [], failed: [] } };
      throw new Error(`unexpected meta action ${action}`);
    });
    const kernelDelete = vi.fn(async (_path: string, body: { knowledge_ids: string[] }) => {
      body.knowledge_ids.forEach((id) => missingCore.add(id));
      return { code: 0, data: { deleted_ids: body.knowledge_ids, failed: [] } };
    });
    const kernelRequest = vi.fn(async (path: string, body: { knowledge_id?: string; knowledge_ids?: string[] }, cred: unknown) => {
      if (path === '/v3/knowledge/get') return missingCore.has(body.knowledge_id ?? '')
        ? { code: 404, data: null }
        : { code: 0, data: { knowledge_id: body.knowledge_id, type: 'code-graph', team_id: 'team-1', user_id: 'user-1' } };
      return kernelDelete(path, body as { knowledge_ids: string[] }, cred);
    });
    const ksGet = vi.fn(async (id: string) => {
      if (missingKs.has(id)) throw new CoreUpstreamError('CORE_UPSTREAM_ERROR', 404, 'not found');
      return { code_graph_id: id, team_id: 'team-1', owner_user_id: 'user-1', status: 'ready' };
    });
    const ksDelete = vi.fn(async (ids: string[]) => {
      if (ids[0] === 'cg-deleted') {
        missingKs.add('cg-deleted');
        return { deleted_ids: ['cg-deleted'], failed: [] };
      }
      return { deleted_ids: [], failed: [{ id: 'cg-live', reason: 'index close failed' }] };
    });
    const deps = {
      config: { metadataRemoteTimeoutMs: 5000 },
      instanceRegistry: { resolve: () => ({ instance_id: 'svc-1', gateway_endpoint: 'http://meta.test', api_key: 'key' }) },
      metaKernel: { invoke: metaInvoke },
      kernelHttp: { postEnvelope: kernelRequest },
      knowledgeClientFactory: () => ({ codeGraphDelete: ksDelete, codeGraphGet: ksGet }),
    } as unknown as PanelDeps;
    registerKnowledgeCodeGraphRoutes(app, deps);

    const response = await app.request('/knowledge/code-graph/delete', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tdai-service-id': 'svc-1',
        'x-tdai-user-key': 'user-key',
      },
      body: JSON.stringify({ code_graph_ids: ['cg-deleted', 'cg-live'] }),
    });

    expect(response.status).toBe(200);
    expect(ksDelete).toHaveBeenNthCalledWith(1, ['cg-deleted']);
    expect(ksDelete).toHaveBeenNthCalledWith(2, ['cg-live']);
    expect(kernelDelete).toHaveBeenCalledWith(
      '/v3/knowledge/delete', { knowledge_ids: ['cg-deleted'], team_id: 'team-1' }, expect.anything(),
    );
    expect(metaInvoke).toHaveBeenCalledWith(
      'asset/delete', { asset_ids: ['cg-deleted'] }, expect.anything(),
    );

    // The first KS delete can commit and its HTTP response can be lost. A
    // retry sees "not found" and must finish the Core/meta side of the saga.
    missingMeta.add('cg-deleted');
    ksDelete.mockResolvedValueOnce({ deleted_ids: [], failed: [{ id: 'cg-live', reason: 'not found' }] });
    const retry = await app.request('/knowledge/code-graph/delete', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tdai-service-id': 'svc-1',
        'x-tdai-user-key': 'user-key',
      },
      body: JSON.stringify({ code_graph_ids: ['cg-deleted', 'cg-live'] }),
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      data: { deleted_ids: ['cg-live'], failed: [{ id: 'cg-deleted', reason: 'not found' }] },
    });
    expect(kernelDelete).toHaveBeenNthCalledWith(
      2, '/v3/knowledge/delete', { knowledge_ids: ['cg-live'], team_id: 'team-1' }, expect.anything(),
    );

    // A writable wiki is not a missing CodeGraph. Cross-type not-found
    // compensation must never remove its Core entity or meta binding.
    const wikiAttempt = await app.request('/knowledge/code-graph/delete', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tdai-service-id': 'svc-1',
        'x-tdai-user-key': 'user-key',
      },
      body: JSON.stringify({ code_graph_ids: ['wiki-1'] }),
    });
    expect(wikiAttempt.status).toBe(404);
    expect(ksDelete).toHaveBeenCalledTimes(3);
    expect(kernelDelete).toHaveBeenCalledTimes(2);

    ksDelete.mockResolvedValueOnce({ deleted_ids: ['cg-core-fail'], failed: [] });
    kernelDelete.mockResolvedValueOnce({ code: 503, data: { deleted_ids: [], failed: [] } });
    const failedCascade = await app.request('/knowledge/code-graph/delete', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tdai-service-id': 'svc-1',
        'x-tdai-user-key': 'user-key',
      },
      body: JSON.stringify({ code_graph_ids: ['cg-core-fail'] }),
    });
    expect(await failedCascade.json()).toMatchObject({
      data: { deleted_ids: [], failed: [{ id: 'cg-core-fail', reason: 'remote cleanup failed; retry' }] },
    });
    expect(metaInvoke).not.toHaveBeenCalledWith('asset/delete', { asset_ids: ['cg-core-fail'] }, expect.anything());

    // Meta remains as the authorization anchor, so the caller can retry
    // after the Core outage even though KS now reports the row absent.
    ksDelete.mockResolvedValueOnce({ deleted_ids: [], failed: [{ id: 'cg-core-fail', reason: 'not found' }] });
    missingKs.add('cg-core-fail');
    const recovered = await app.request('/knowledge/code-graph/delete', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tdai-service-id': 'svc-1',
        'x-tdai-user-key': 'user-key',
      },
      body: JSON.stringify({ code_graph_ids: ['cg-core-fail'] }),
    });
    expect(await recovered.json()).toMatchObject({ data: { deleted_ids: ['cg-core-fail'], failed: [] } });
    expect(metaInvoke).toHaveBeenCalledWith('asset/delete', { asset_ids: ['cg-core-fail'] }, expect.anything());
  });

  it('rejects a write-authorized non-owner before deleting anything in Knowledge', async () => {
    const app = new Hono();
    const metaInvoke = vi.fn(async (action: string) => {
      if (action === 'auth/verify') return { code: 0, data: { valid: true, user: { user_id: 'writer-1' } } };
      if (action === 'asset/get') return { code: 0, data: { team_id: 'team-1', owner_user_id: 'owner-1', asset_type: 'code_graph' } };
      if (action === 'acl/check') return { code: 0, data: { allowed: true } };
      if (action === 'team-member/get') return { code: 0, data: { user_id: 'writer-1' } };
      throw new Error(`unexpected meta action ${action}`);
    });
    const ksDelete = vi.fn();
    const ksGet = vi.fn(async () => ({ code_graph_id: 'cg-1', team_id: 'team-1', owner_user_id: 'owner-1' }));
    const coreDelete = vi.fn();
    registerKnowledgeCodeGraphRoutes(app, {
      config: { metadataRemoteTimeoutMs: 5000 },
      instanceRegistry: { resolve: () => ({ instance_id: 'svc-1', gateway_endpoint: 'http://meta.test', api_key: 'key' }) },
      metaKernel: { invoke: metaInvoke },
      kernelHttp: { postEnvelope: coreDelete },
      knowledgeClientFactory: () => ({ codeGraphDelete: ksDelete, codeGraphGet: ksGet }),
    } as unknown as PanelDeps);

    const response = await app.request('/knowledge/code-graph/delete', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tdai-service-id': 'svc-1',
        'x-tdai-user-key': 'writer-key',
      },
      body: JSON.stringify({ code_graph_ids: ['cg-1'] }),
    });
    expect(response.status).toBe(403);
    expect(ksDelete).not.toHaveBeenCalled();
    expect(coreDelete).not.toHaveBeenCalled();
    expect(metaInvoke).not.toHaveBeenCalledWith('asset/delete', expect.anything(), expect.anything());
  });

  it('rejects a forged meta binding for another team before reads or deletion', async () => {
    const app = new Hono();
    const metaInvoke = vi.fn(async (action: string) => {
      if (action === 'auth/verify') return { code: 0, data: { valid: true, user: { user_id: 'attacker' } } };
      if (action === 'asset/get') return { code: 0, data: { asset_id: 'cg-victim', team_id: 'team-b', owner_user_id: 'attacker', asset_type: 'code_graph' } };
      if (action === 'acl/check') return { code: 0, data: { allowed: true } };
      if (action === 'team-member/get') return { code: 0, data: { user_id: 'attacker' } };
      throw new Error(`unexpected meta action ${action}`);
    });
    const ksGet = vi.fn(async () => ({ code_graph_id: 'cg-victim', team_id: 'team-a', owner_user_id: 'victim' }));
    const ksDelete = vi.fn();
    registerKnowledgeCodeGraphRoutes(app, {
      config: { metadataRemoteTimeoutMs: 5000 },
      instanceRegistry: { resolve: () => ({ instance_id: 'svc-1', gateway_endpoint: 'http://meta.test', api_key: 'key' }) },
      metaKernel: { invoke: metaInvoke },
      knowledgeClientFactory: () => ({ codeGraphGet: ksGet, codeGraphDelete: ksDelete }),
    } as unknown as PanelDeps);
    const headers = { 'content-type': 'application/json', 'x-tdai-service-id': 'svc-1', 'x-tdai-user-key': 'attacker-key' };

    const read = await app.request('/knowledge/code-graph/get', {
      method: 'POST', headers, body: JSON.stringify({ code_graph_id: 'cg-victim' }),
    });
    const deletion = await app.request('/knowledge/code-graph/delete', {
      method: 'POST', headers, body: JSON.stringify({ code_graph_ids: ['cg-victim'] }),
    });
    expect(read.status).toBe(403);
    expect(deletion.status).toBe(403);
    expect(ksDelete).not.toHaveBeenCalled();
  });

  it('lets the owner finish Core cleanup when a graph never had a meta asset', async () => {
    const app = new Hono();
    let ksGone = false;
    let coreGone = false;
    let coreDeleteAttempts = 0;
    const metaInvoke = vi.fn(async (action: string, body?: { asset_ids?: string[] }) => {
      if (action === 'auth/verify') return { code: 0, data: { valid: true, user: { user_id: 'owner-1' } } };
      if (action === 'asset/get') return { code: 404, data: null };
      if (action === 'team-member/get') return { code: 0, data: { user_id: 'owner-1' } };
      if (action === 'asset/delete') return { code: 0, data: { deleted_ids: body?.asset_ids ?? [], failed: [] } };
      throw new Error(`unexpected meta action ${action}`);
    });
    const ksGet = vi.fn(async () => {
      if (ksGone) throw new CoreUpstreamError('CORE_UPSTREAM_ERROR', 404, 'not found');
      return { code_graph_id: 'cg-1', team_id: 'team-1', owner_user_id: 'owner-1' };
    });
    const ksDelete = vi.fn(async () => {
      if (ksGone) return { deleted_ids: [], failed: [{ id: 'cg-1', reason: 'not found' }] };
      ksGone = true;
      return { deleted_ids: ['cg-1'], failed: [] };
    });
    const coreRequest = vi.fn(async (path: string, body: { knowledge_id?: string; knowledge_ids?: string[] }) => {
      if (path === '/v3/knowledge/get') return coreGone
        ? { code: 404, data: null }
        : { code: 0, data: { knowledge_id: 'cg-1', type: 'code-graph', team_id: 'team-1', user_id: 'owner-1' } };
      expect(path).toBe('/v3/knowledge/delete');
      coreDeleteAttempts++;
      if (coreDeleteAttempts === 1) return { code: 503, data: { deleted_ids: [], failed: [] } };
      coreGone = true;
      return { code: 0, data: { deleted_ids: body.knowledge_ids, failed: [] } };
    });
    registerKnowledgeCodeGraphRoutes(app, {
      config: { metadataRemoteTimeoutMs: 5000 },
      instanceRegistry: { resolve: () => ({ instance_id: 'svc-1', gateway_endpoint: 'http://meta.test', api_key: 'key' }) },
      metaKernel: { invoke: metaInvoke },
      kernelHttp: { postEnvelope: coreRequest },
      knowledgeClientFactory: () => ({ codeGraphGet: ksGet, codeGraphDelete: ksDelete }),
    } as unknown as PanelDeps);
    const request = () => app.request('/knowledge/code-graph/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tdai-service-id': 'svc-1', 'x-tdai-user-key': 'owner-key' },
      body: JSON.stringify({ code_graph_ids: ['cg-1'] }),
    });

    expect(await (await request()).json()).toMatchObject({ data: { deleted_ids: [], failed: [{ id: 'cg-1' }] } });
    expect(await (await request()).json()).toMatchObject({ data: { deleted_ids: ['cg-1'], failed: [] } });
    expect(coreDeleteAttempts).toBe(2);
    expect(metaInvoke).toHaveBeenCalledWith('asset/delete', { asset_ids: ['cg-1'] }, expect.anything());
  });
});

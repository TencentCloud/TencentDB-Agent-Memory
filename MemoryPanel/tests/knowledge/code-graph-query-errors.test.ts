import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { HttpKnowledgeClient } from '../../src/panel/kernel/adapters/http-knowledge-client.js';
import { runKs } from '../../src/panel/http/routes/knowledge/common.js';
import { registerKnowledgeCodeGraphRoutes } from '../../src/panel/http/routes/knowledge/code-graph-routes.js';
import type { PanelDeps } from '../../src/panel/panel-deps.js';
import { codeGraphQueryFailureMessage } from '../../web/src/pages/CodePage/hooks/code-query-error.js';

afterEach(() => vi.unstubAllGlobals());

describe('CodeGraph query error propagation', () => {
  const queryStates = [
    { status: 503, errorCode: 'CODE_GRAPH_INDEX_BUILDING', key: 'code.notify.queryBuilding' },
    { status: 503, errorCode: 'CODE_GRAPH_INDEX_SWITCHING', key: 'code.notify.querySwitching' },
    { status: 503, errorCode: 'CODE_GRAPH_INDEX_UNAVAILABLE', key: 'code.notify.queryUnavailable' },
    { status: 409, errorCode: 'CODE_GRAPH_INDEX_FAILED', key: 'code.notify.queryFailed' },
  ] as const;

  it.each(queryStates)('keeps $errorCode through the Panel bridge', async ({ status, errorCode, key }) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      code: status,
      message: 'upstream index state',
      error_code: errorCode,
      data: null,
    }, { status })));
    const client = new HttpKnowledgeClient({ baseUrl: 'http://knowledge.test', authToken: '' });
    const app = new Hono();
    app.post('/query', (c) => runKs(c, () => client.codeGraphQuery('cg-1', 'search', { query: 'foo' })));

    const response = await app.request('/query', { method: 'POST' });
    expect(response.status).toBe(status);
    const body = await response.json() as { code: number; error_code: string; message: string };
    expect(body).toMatchObject({ code: status, error_code: errorCode, message: 'upstream index state' });
    expect(codeGraphQueryFailureMessage({ errorCode: body.error_code }, (name) => name)).toBe(key);
  });

  it('does not turn an unrelated 503 into a building or switching notice', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      code: 503, message: 'service unavailable', data: null,
    }, { status: 503 })));
    const client = new HttpKnowledgeClient({ baseUrl: 'http://knowledge.test', authToken: '' });
    const app = new Hono();
    app.post('/query', (c) => runKs(c, () => client.codeGraphQuery('cg-1', 'explore', { query: 'foo' })));

    const response = await app.request('/query', { method: 'POST' });
    expect(response.status).toBe(503);
    const body = await response.json() as { error_code?: string };
    expect(body.error_code).toBeUndefined();
    expect(codeGraphQueryFailureMessage({ code: 503 }, (name) => name)).toBeNull();
    expect(codeGraphQueryFailureMessage({ errorCode: 'SOME_OTHER_ERROR' }, (name) => name)).toBeNull();
  });
});

function queryRouteFixture(opts: {
  callerId?: string;
  ownerId?: string;
  isTeamMember?: boolean;
  metaCode?: number;
  aclAllowed?: boolean;
  queryStatus?: number;
  errorCode?: string;
} = {}) {
  const callerId = opts.callerId ?? 'owner-1';
  const ownerId = opts.ownerId ?? 'owner-1';
  const metaCode = opts.metaCode ?? 404;
  const queryStatus = opts.queryStatus ?? 503;
  const errorCode = opts.errorCode ?? 'CODE_GRAPH_INDEX_BUILDING';
  const invoke = vi.fn(async (action: string) => {
    switch (action) {
      case 'auth/verify':
        return { code: 0, message: 'ok', data: { valid: true, user: { user_id: callerId } } };
      case 'asset/get':
        return metaCode === 0
          ? { code: 0, message: 'ok', data: { asset_id: 'cg-1', team_id: 'team-1' } }
          : { code: metaCode, message: 'asset_not_found', data: null };
      case 'acl/check':
        return { code: 0, message: 'ok', data: { allowed: opts.aclAllowed ?? false } };
      case 'team-member/get':
        return opts.isTeamMember === false
          ? { code: 404, message: 'team_member_not_found', data: null }
          : { code: 0, message: 'ok', data: { team_id: 'team-1', user_id: callerId } };
      default:
        throw new Error(`Unexpected meta action: ${action}`);
    }
  });
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/v3/code-graph/get')) {
      return Response.json({
        code: 0, message: 'ok', data: {
          code_graph_id: 'cg-1', team_id: 'team-1', owner_user_id: ownerId,
          status: queryStatus === 409 ? 'failed' : 'pending', last_sync_at: null,
        },
      });
    }
    if (url.endsWith('/v3/code-graph/search') || url.endsWith('/v3/code-graph/explore')) {
      return Response.json({
        code: queryStatus, message: 'index state', error_code: errorCode, data: null,
      }, { status: queryStatus });
    }
    throw new Error(`Unexpected KS URL: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const client = new HttpKnowledgeClient({ baseUrl: 'http://knowledge.test', authToken: '' });
  const deps = {
    instanceRegistry: {
      resolve: () => ({ instance_id: 'svc-1', gateway_endpoint: 'http://meta.test', api_key: 'key' }),
    },
    metaKernel: { invoke },
    knowledgeClientFactory: () => client,
  } as unknown as PanelDeps;
  const app = new Hono();
  registerKnowledgeCodeGraphRoutes(app, deps);
  const post = (tool: 'search' | 'explore') => app.request(`/knowledge/code-graph/${tool}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tdai-service-id': 'svc-1',
      'x-tdai-user-key': 'user-key',
    },
    body: JSON.stringify({ code_graph_id: 'cg-1', query: 'foo' }),
  });
  return { post, invoke, fetchMock };
}

describe('CodeGraph Panel query routes before meta registration', () => {
  it.each([
    { tool: 'search', queryStatus: 503, errorCode: 'CODE_GRAPH_INDEX_BUILDING' },
    { tool: 'explore', queryStatus: 409, errorCode: 'CODE_GRAPH_INDEX_FAILED' },
  ] as const)('lets the owner reach $tool index state', async ({ tool, queryStatus, errorCode }) => {
    const f = queryRouteFixture({ queryStatus, errorCode });

    const response = await f.post(tool);
    expect(response.status).toBe(queryStatus);
    expect(await response.json()).toMatchObject({ code: queryStatus, error_code: errorCode });
    expect(f.fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['search', 'explore'] as const)('hides %s from a different team member', async (tool) => {
    const f = queryRouteFixture({ callerId: 'other-member' });

    const response = await f.post(tool);
    expect(response.status).toBe(404);
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects the owner after team membership is lost', async () => {
    const f = queryRouteFixture({ isTeamMember: false });

    const response = await f.post('search');
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ message: 'NOT_TEAM_MEMBER' });
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses meta ACL when the asset exists, even for the KS owner', async () => {
    const f = queryRouteFixture({ metaCode: 0, aclAllowed: false });

    const response = await f.post('explore');
    expect(response.status).toBe(403);
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it('does not use the owner fallback when meta is unavailable', async () => {
    const f = queryRouteFixture({ metaCode: 503 });

    const response = await f.post('search');
    expect(response.status).toBe(404);
    expect(f.fetchMock).not.toHaveBeenCalled();
  });
});

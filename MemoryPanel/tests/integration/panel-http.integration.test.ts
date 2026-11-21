import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InstanceRegistry } from '../../src/panel/config/instance-registry.js';
import { requestLogger } from '../../src/panel/http/middleware/request-logger.js';
import { registerMetaProxyRoutes } from '../../src/panel/http/routes/meta/proxy.js';
import { registerChatMemoryRoutes } from '../../src/panel/http/routes/chat-memory.js';
import { registerKnowledgeWikiRoutes } from '../../src/panel/http/routes/knowledge/wiki-routes.js';
import { registerKnowledgeCallbackRoutes } from '../../src/panel/http/routes/knowledge/callback-routes.js';
import { FetchKernelHttpAdapter } from '../../src/panel/kernel/adapters/fetch-kernel-http-adapter.js';
import { FetchMetaKernelAdapter } from '../../src/panel/kernel/adapters/fetch-meta-kernel-adapter.js';
import { HttpKnowledgeClient } from '../../src/panel/kernel/adapters/http-knowledge-client.js';
import { IngestProgressStore } from '../../src/panel/state/ingest-progress-store.js';
import { KnowledgeTaskRegistry } from '../../src/panel/state/knowledge-task-registry.js';
import type { Logger } from '../../src/panel/infra/logger.js';
import type { PanelDeps } from '../../src/panel/panel-deps.js';

/**
 * Component integration: a real Panel HTTP listener, its production routes and
 * adapters, and local HTTP fixtures for Core/Knowledge. No fetch or adapter
 * methods are mocked. Fixture authorization is a controlled input, not proof of
 * Core's production authorization or an ingress deployment's trust policy.
 */
interface RecordedRequest {
  path: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

type UpstreamMode = 'ok' | 'business-error' | 'invalid-json' | 'timeout' | 'disconnect';
type Binding = { asset_id: string; asset_type: string; injection_mode: string; priority: number; created_by: string };
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
const envelope = (data: unknown, code = 0, message = 'ok') => ({ code, message, request_id: 'upstream-request', data });

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await closed;
}

function respond(response: ServerResponse, data: unknown, status = 200): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(data));
}

function applyFault(mode: UpstreamMode, response: ServerResponse): boolean {
  if (mode === 'ok') return false;
  if (mode === 'business-error') respond(response, envelope(null, 403, 'fixture_permission_denied'));
  if (mode === 'invalid-json') { response.writeHead(502); response.end('<html>gateway unavailable</html>'); }
  if (mode === 'disconnect') response.destroy();
  // A timeout deliberately leaves the real TCP response open until fetch aborts.
  return true;
}

function httpFixture(handler: (request: RecordedRequest, response: ServerResponse) => void) {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString('utf8');
      const recorded = { path: request.url ?? '/', headers: request.headers, body: text ? JSON.parse(text) : {} };
      requests.push(recorded);
      handler(recorded, response);
    } catch (error) {
      if (!response.destroyed) respond(response, envelope(null, 500, String(error)), 500);
    }
  });
  return { server, requests };
}

async function fixture(timeoutMs = 1000) {
  const startedServers: Server[] = [];
  const state = {
    coreMode: 'ok' as UpstreamMode,
    knowledgeMode: 'ok' as UpstreamMode,
    teamAllowed: true,
    aclAllowed: true,
    wikiStatus: 'processing',
    assetRegistered: true,
    registrationFailures: 0,
    bindings: [] as Binding[],
    failBindingOffset: -1,
  };
  const core = httpFixture((request, response) => {
    const instance = request.path.split('/')[1];
    if (!['a', 'b'].includes(instance ?? '') || request.headers.authorization !== `Bearer core-secret-${instance}` || request.headers['x-tdai-service-id'] !== instance) {
      respond(response, envelope(null, 401, 'fixture_invalid_instance_credentials'), 401);
      return;
    }
    const action = request.path.replace(/^\/[ab]\/v3\/meta\//, '');
    if (action === 'auth/verify') {
      const valid = request.body.user_key === `user-key-${instance}`;
      respond(response, envelope({ valid, ...(valid ? { user: { user_id: `user-${instance}` } } : {}) }));
      return;
    }
    if (request.path.endsWith('/v3/knowledge/create')) { respond(response, envelope({ registered: true })); return; }
    if (request.headers['x-tdai-user-key'] !== `user-key-${instance}`) {
      respond(response, envelope(null, 401, 'fixture_invalid_user'), 401);
      return;
    }
    if (action === 'agent/list') {
      if (!applyFault(state.coreMode, response)) respond(response, envelope({ items: [{ agent_id: `agent-${instance}` }], total: 1 }));
    } else if (action === 'team-member/get') {
      respond(response, state.teamAllowed ? envelope({ user_id: `user-${instance}`, team_id: `team-${instance}` }) : envelope(null, 404, 'not_member'));
    } else if (action === 'acl/check') {
      respond(response, envelope({ allowed: state.aclAllowed }));
    } else if (action === 'asset/get') {
      if (request.body.asset_id === 'memory-peer') {
        respond(response, envelope({ asset_id: 'memory-peer', team_id: `team-${instance}`, asset_type: 'chat_memory', visibility: 'team', owner_user_id: 'peer-user' }));
      } else {
        respond(response, state.assetRegistered ? envelope({ asset_id: `wiki-${instance}`, team_id: `team-${instance}`, owner_user_id: `user-${instance}`, visibility: 'team', asset_type: 'llm_wiki' }) : envelope(null, 404, 'not_found'));
      }
    } else if (action === 'asset/create') {
      if (state.registrationFailures > 0) {
        state.registrationFailures -= 1;
        respond(response, envelope(null, 503, 'metadata_temporarily_unavailable'), 503);
      } else {
        state.assetRegistered = true;
        respond(response, envelope({ asset_id: request.body.asset_id }));
      }
    } else if (action === 'agent/get') {
      respond(response, envelope({ agent_id: `agent-${instance}`, team_id: `team-${instance}`, owner_user_id: `user-${instance}` }));
    } else if (action === 'agent-fixed-asset/list') {
      const offset = Number(request.body.offset);
      if (offset === state.failBindingOffset) respond(response, envelope(null, 503, 'page_unavailable'), 503);
      else respond(response, envelope({ items: state.bindings.slice(offset, offset + Number(request.body.limit)), total: state.bindings.length }));
    } else if (action === 'agent-fixed-asset/set') {
      state.bindings = request.body.bindings as Binding[];
      respond(response, envelope({ updated: true }));
    } else {
      respond(response, envelope(null, 404, `unexpected_core_path:${request.path}`), 404);
    }
  });
  const knowledge = httpFixture((request, response) => {
    const instance = request.headers['x-tdai-service-id'];
    if (!['a', 'b'].includes(String(instance)) || request.headers.authorization !== 'Bearer knowledge-secret') {
      respond(response, envelope(null, 401, 'fixture_invalid_knowledge_credentials'), 401);
      return;
    }
    if (state.knowledgeMode === 'business-error') {
      respond(response, envelope(null, 503, 'knowledge_temporarily_unavailable'), 503);
      return;
    }
    if (applyFault(state.knowledgeMode, response)) return;
    if (request.path === '/v3/wiki/list') {
      respond(response, envelope({ items: [{ wiki_id: `wiki-${instance}` }], total: 1 }));
    } else if (request.path === '/v3/wiki/get' || request.path === '/v3/wiki/create') {
      respond(response, envelope({ wiki_id: `wiki-${instance}`, team_id: `team-${instance}`, owner_user_id: `user-${instance}`, name: 'Fixture wiki', service_url: 'http://knowledge.internal/wiki', status: state.wikiStatus }));
    } else {
      respond(response, envelope(null, 404, `unexpected_knowledge_path:${request.path}`), 404);
    }
  });
  try {
    const coreUrl = await listen(core.server);
    startedServers.push(core.server);
    const knowledgeUrl = await listen(knowledge.server);
    startedServers.push(knowledge.server);
    const kernelHttp = new FetchKernelHttpAdapter();
    const deps = {
      logger,
      config: { metadataRemoteTimeoutMs: timeoutMs, auth: { sessionCookieName: 'panel-session' } },
      instanceRegistry: new InstanceRegistry(['a', 'b'].map((instance_id) => ({ instance_id, name: instance_id, gateway_endpoint: `${coreUrl}/${instance_id}`, api_key: `core-secret-${instance_id}` }))),
      kernelHttp,
      metaKernel: new FetchMetaKernelAdapter(kernelHttp, timeoutMs),
      knowledgeClientFactory: (instanceId: string) => new HttpKnowledgeClient({ baseUrl: knowledgeUrl, authToken: 'knowledge-secret', serviceId: instanceId, timeoutMs }),
      ingestProgressStore: new IngestProgressStore(),
      knowledgeTaskRegistry: new KnowledgeTaskRegistry(),
    } as unknown as PanelDeps;
    const app = new Hono();
    app.use('*', requestLogger(logger));
    const api = new Hono();
    registerMetaProxyRoutes(api, deps);
    registerChatMemoryRoutes(api, deps);
    registerKnowledgeWikiRoutes(api, deps);
    registerKnowledgeCallbackRoutes(api, deps);
    app.route('/api/v1', api);
    const panel = createServer(getRequestListener(app.fetch));
    const panelUrl = await listen(panel);
    startedServers.push(panel);
    return {
      state, core, knowledge,
      async request(path: string, body: unknown, instance = 'a', userKey = `user-key-${instance}`) {
        return fetch(`${panelUrl}/api/v1${path}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-tdai-service-id': instance, 'x-tdai-user-key': userKey, 'x-request-id': 'integration-request', Authorization: 'Bearer fixture-caller' }, body: JSON.stringify(body),
        });
      },
      async dispose() { await Promise.all(startedServers.splice(0).reverse().map(close)); },
    };
  } catch (error) {
    // Startup can fail after one or more listeners have opened. Close every
    // acquired listener while retaining the original setup error for diagnosis.
    await Promise.allSettled(startedServers.splice(0).reverse().map(close));
    throw error;
  }
}

describe('Panel routes and adapters over real loopback HTTP', () => {
  let activeContext: Awaited<ReturnType<typeof fixture>> | undefined;
  async function resetContext(timeoutMs = 1000) {
    const previous = activeContext;
    activeContext = undefined;
    await previous?.dispose();
    activeContext = await fixture(timeoutMs);
    return activeContext;
  }
  function currentContext() {
    if (!activeContext) throw new Error('Integration fixture has not started');
    return activeContext;
  }
  beforeEach(async () => { await resetContext(); });
  afterEach(async () => {
    const previous = activeContext;
    activeContext = undefined;
    await previous?.dispose();
  });

  it('routes concurrent instances independently and propagates server credentials and correlation IDs', async () => {
    const context = currentContext();
    const responses = await Promise.all(['a', 'b'].map((id) => context.request('/meta/agent/list', { team_id: `team-${id}`, limit: 7, offset: 0 }, id)));
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual(['a', 'b'].map((id) => envelope({ items: [{ agent_id: `agent-${id}` }], total: 1 })));
    expect(context.core.requests).toHaveLength(2);
    for (const id of ['a', 'b']) {
      const request = context.core.requests.find((item) => item.path === `/${id}/v3/meta/agent/list`)!;
      expect(request.headers).toMatchObject({ authorization: `Bearer core-secret-${id}`, 'x-tdai-service-id': id, 'x-tdai-user-key': `user-key-${id}`, 'x-request-id': 'integration-request' });
      expect(request.body).toEqual({ team_id: `team-${id}`, limit: 7, offset: 0 });
    }
    expect(responses[0]!.headers.get('x-request-id')).toBe('integration-request');
  });

  it('rejects unknown instances locally and relays a controlled upstream rejection of another instance user key', async () => {
    const context = currentContext();
    expect((await context.request('/meta/agent/list', {}, 'unknown')).status).toBe(400);
    expect(context.core.requests).toHaveLength(0);
    const denied = await context.request('/meta/agent/list', {}, 'b', 'user-key-a');
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ message: 'fixture_invalid_user' });
    expect(context.core.requests[0]!.path).toBe('/b/v3/meta/agent/list');
  });

  it('uses the body key for auth/verify without leaking a conflicting caller header upstream', async () => {
    const context = currentContext();
    const response = await context.request('/meta/auth/verify', { user_key: 'user-key-a' }, 'a', 'not-the-target-key');
    expect(await response.json()).toMatchObject({ code: 0, data: { valid: true, user: { user_id: 'user-a' } } });
    expect(context.core.requests[0]!.headers).not.toHaveProperty('x-tdai-user-key');
  });

  it.each([
    { mode: 'business-error', status: 403, message: 'fixture_permission_denied' },
    { mode: 'invalid-json', status: 502, message: 'KERNEL_UNAVAILABLE' },
    { mode: 'disconnect', status: 502, message: 'KERNEL_UNAVAILABLE' },
    { mode: 'timeout', status: 504, message: 'KERNEL_TIMEOUT' },
  ] as const)('maps Core $mode through real fetch and adapter into HTTP $status', async ({ mode, status, message }) => {
    const context = mode === 'timeout' ? await resetContext(200) : currentContext();
    context.state.coreMode = mode;
    const response = await context.request('/meta/agent/list', {});
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code: status, message });
    expect(context.core.requests).toHaveLength(1);
  });

  it('checks team membership at Core before forwarding a wiki list to Knowledge', async () => {
    const context = currentContext();
    context.state.teamAllowed = false;
    const denied = await context.request('/knowledge/wiki/list', { team_id: 'team-b' });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ message: 'NOT_TEAM_MEMBER' });
    expect(context.knowledge.requests).toHaveLength(0);
    context.state.teamAllowed = true;
    const allowed = await context.request('/knowledge/wiki/list', { team_id: 'team-a', limit: 3 });
    expect(allowed.status).toBe(200);
    expect(context.knowledge.requests[0]).toMatchObject({ path: '/v3/wiki/list', headers: { authorization: 'Bearer knowledge-secret', 'x-tdai-service-id': 'a' }, body: { team_id: 'team-a', limit: 3 } });
    expect(context.knowledge.requests[0]!.headers).not.toHaveProperty('x-tdai-user-key');
  });

  it('does not fetch Knowledge details when Core denies the asset ACL', async () => {
    const context = currentContext();
    context.state.aclAllowed = false;
    const response = await context.request('/knowledge/wiki/get', { wiki_id: 'wiki-a' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ message: 'FORBIDDEN' });
    expect(context.knowledge.requests).toHaveLength(0);
  });

  it.each([
    { mode: 'business-error', status: 503, message: 'knowledge_temporarily_unavailable' },
    { mode: 'invalid-json', status: 502, message: 'UPSTREAM_ERROR' },
    { mode: 'timeout', status: 502, message: 'UPSTREAM_ERROR' },
  ] as const)('contains Knowledge $mode at the wiki HTTP route', async ({ mode, status, message }) => {
    const context = mode === 'timeout' ? await resetContext(200) : currentContext();
    context.state.knowledgeMode = mode;
    const response = await context.request('/knowledge/wiki/list', { team_id: 'team-a' });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code: status, message });
  });

  it('allows retry after Knowledge creation succeeds but metadata registration fails', async () => {
    const context = currentContext();
    context.state.assetRegistered = false;
    context.state.registrationFailures = 1;
    const first = await context.request('/knowledge/wiki/create', { team_id: 'team-a', name: 'Fixture wiki' });
    expect(first.status).toBe(503);
    expect(context.state.assetRegistered).toBe(false);
    // The controlled Knowledge service returns the same id on retry; this tests
    // Panel's compensation path, not Knowledge's production idempotency store.
    const retry = await context.request('/knowledge/wiki/create', { team_id: 'team-a', name: 'Fixture wiki' });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ data: { wiki_id: 'wiki-a' } });
    expect(context.state.assetRegistered).toBe(true);
    expect(context.core.requests.filter((request) => request.path.endsWith('/asset/create')).map((request) => request.body.asset_id)).toEqual(['wiki-a', 'wiki-a']);
  });

  it('keeps every page of existing bindings when adding memory to an Agent', async () => {
    const context = currentContext();
    const originals = Array.from({ length: 101 }, (_, n) => ({ asset_id: `skill-${n}`, asset_type: 'skill', injection_mode: 'full', priority: n, created_by: 'user-a' }));
    context.state.bindings = originals;
    const response = await context.request('/chat-memory/allocate', { block_id: 'memory-peer', agent_id: 'agent-a', team_id: 'team-a' });
    expect(response.status).toBe(200);
    expect(context.core.requests.filter((request) => request.path.endsWith('/agent-fixed-asset/list')).map((request) => request.body.offset)).toEqual([0, 100]);
    expect(context.state.bindings).toHaveLength(102);
    expect(context.state.bindings.slice(0, 101)).toEqual(originals);
    expect(context.state.bindings[101]).toMatchObject({ asset_id: 'memory-peer', asset_type: 'chat_memory' });
  });

  it('does not write a partial replacement when the second bindings page fails', async () => {
    const context = currentContext();
    context.state.bindings = Array.from({ length: 101 }, (_, n) => ({ asset_id: `skill-${n}`, asset_type: 'skill', injection_mode: 'full', priority: n, created_by: 'user-a' }));
    context.state.failBindingOffset = 100;
    const response = await context.request('/chat-memory/allocate', { block_id: 'memory-peer', agent_id: 'agent-a', team_id: 'team-a' });
    expect(response.status).toBe(503);
    expect(context.state.bindings).toHaveLength(101);
    expect(context.core.requests.some((request) => request.path.endsWith('/agent-fixed-asset/set'))).toBe(false);
  });

  it('carries trusted callback run ordering through progress storage and the guarded wiki read route', async () => {
    const context = currentContext();
    const progress = (run_id: string, percent: number) => context.request('/knowledge/status-callback', {
      event: 'ingest_progress', service_id: 'a', wiki_id: 'wiki-a', run_id,
      progress: { phase: 'extracting', total: 100, completed: percent, failed: 0, skipped: 0, percent },
    });
    // Callback requests model a trusted service caller. Ingress authentication
    // and deployment access controls are outside this component test.
    for (const [run, percent] of [['run-1', 98], ['run-2', 20]] as const) expect((await progress(run, percent)).status).toBe(200);
    expect((await context.request('/knowledge/status-callback', { knowledge_id: 'wiki-a', type: 'wiki', status: 'failed', service_id: 'a', run_id: 'run-1' })).status).toBe(200);
    expect((await progress('run-1', 99)).status).toBe(200);
    const active = await context.request('/knowledge/wiki/get', { wiki_id: 'wiki-a' });
    expect(await active.json()).toMatchObject({ data: { status: 'processing', progress: { completed: 20, percent: 20 } } });
    context.state.wikiStatus = 'ready';
    expect((await context.request('/knowledge/status-callback', { knowledge_id: 'wiki-a', type: 'wiki', status: 'ready', summary: 'Ready summary', service_id: 'a', run_id: 'run-2' })).status).toBe(200);
    const ready = await context.request('/knowledge/wiki/get', { wiki_id: 'wiki-a' });
    expect(await ready.json()).toMatchObject({ data: { status: 'ready', progress: null } });
    const synced = context.core.requests.find((request) => request.path.endsWith('/v3/knowledge/create'))!;
    expect(synced.body).toMatchObject({ knowledge_id: 'wiki-a', team_id: 'team-a', user_id: 'user-a', summary: 'Ready summary' });
    expect(synced.headers).toMatchObject({ authorization: 'Bearer core-secret-a', 'x-tdai-service-id': 'a' });
  });
});

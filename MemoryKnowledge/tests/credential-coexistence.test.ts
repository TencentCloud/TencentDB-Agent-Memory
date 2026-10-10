import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createDb } from '../src/db/client.js';
import { createGitCredentialRoutes } from '../src/routes/git-credential.js';
import { createSourceCredentialRoutes } from '../src/routes/source-credential.js';
import { createCodeGraphRoutes } from '../src/routes/code-graph.js';
import { createCredentialStore } from '../src/source-auth/credential-store.js';
import { GitCredentialStore } from '../src/store/git-credential-store.js';
import { SqliteKnowledgeStore } from '../src/store/sqlite-store.js';
import { CodeGraphService } from '../src/store/code-graph-service.js';
import { CodeGraphAuthService } from '../src/source-auth/code-graph-auth.js';
import { CodeSourceRegistry } from '../src/code-source/registry.js';

const closers: (() => void)[] = [];
afterEach(() => closers.splice(0).forEach(close => close()));

const repo = 'https://github.com/owner/private.git';
function setup(serviceKey = '') {
  const { db, raw } = createDb({ path: ':memory:' });
  closers.push(() => raw.close());
  const store = new SqliteKnowledgeStore(db);
  const gitCredentials = new GitCredentialStore(db, 'ab'.repeat(32));
  const sourceCredentials = createCredentialStore({ db });
  const authService = new CodeGraphAuthService({ db, store, gitCredentialStore: gitCredentials,
    credentialStore: sourceCredentials, codeSourceRegistry: new CodeSourceRegistry(['gongfeng']) });
  const worker = vi.fn(async () => ({ commitHash: '123456' }));
  const graphs = new CodeGraphService({ store, worker, authService, dataRoot: '/unused' });
  const app = new Hono();
  // Match server.ts registration order: both APIs share the same prefix.
  app.route('/source-credential', createGitCredentialRoutes(gitCredentials, serviceKey));
  app.route('/source-credential', createSourceCredentialRoutes({ credentialStore: sourceCredentials, store,
    codeGraphAuth: authService, serviceKey }));
  app.route('/code-graph', createCodeGraphRoutes({
    cgService: graphs, authService, serviceKey,
    instancePool: { get: () => undefined, set() {}, delete() {} }, publicBaseUrl: '',
  }));
  const request = (method: string, path: string, body?: object, overrides: Record<string, string | null> = {}) => {
    const headers = new Headers({
      'content-type': 'application/json', 'x-tdai-service-id': 'svc',
      'x-tdai-team-id': 'team', 'x-tdai-user-id': 'alice',
      ...(serviceKey ? { authorization: `Bearer ${serviceKey}` } : {}),
    });
    for (const [name, value] of Object.entries(overrides)) {
      if (value === null) headers.delete(name); else headers.set(name, value);
    }
    return app.request(path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  };
  const createGitCredential = () => gitCredentials.put('svc', 'team', 'alice', {
    name: 'Saved Git credential', hostname: 'github.com',
    secret: { kind: 'https', username: 'reader', token: 'saved-token' },
  });
  const createReadyGraph = (credentialId?: string) => {
    const { row } = store.createCodeGraph({ service_id: 'svc', team_id: 'team', owner_user_id: 'alice',
      repo_url: repo, branch: 'main', credential_id: credentialId });
    store.updateCodeGraphStatus('svc', row.code_graph_id, { status: 'ready' });
    return row;
  };
  return { request, store, graphs, worker, sourceCredentials, gitCredentials, createGitCredential, createReadyGraph };
}

describe('reusable Git and resource credentials coexistence', () => {
  it.each([null, 42, {}, 'unknown'])('rejects an invalid explicit CodeGraph credential kind (%j)', async (cred_kind) => {
    const f = setup(); const row = f.createReadyGraph();
    const response = await f.request('PUT', '/source-credential/put', {
      resource_type: 'code-graph', resource_id: row.code_graph_id,
      provider_id: 'gongfeng', cred_kind, secret: 'replacement',
    });
    expect(response.status).toBe(400);
    expect(f.sourceCredentials.status({ type: 'code-graph', serviceId: 'svc', resourceId: row.code_graph_id })).toBeNull();
  });

  it('rejects a provider credential kind mismatch without replacing a saved binding', async () => {
    const f = setup('service-secret'); const saved = f.createGitCredential();
    const row = f.createReadyGraph(saved.credential_id);
    const response = await f.request('PUT', '/source-credential/put', {
      resource_type: 'code-graph', resource_id: row.code_graph_id,
      provider_id: 'gongfeng', cred_kind: 'basic', username: 'reader', secret: 'replacement',
    });
    expect(response.status).toBe(400);
    expect((await response.json()).message).toMatch(/cred_kind.*provider/i);
    expect(f.store.getCodeGraphById('svc', row.code_graph_id)?.credential_id).toBe(saved.credential_id);
    expect(f.sourceCredentials.status({ type: 'code-graph', serviceId: 'svc', resourceId: row.code_graph_id })).toBeNull();
  });

  it('preserves provider credential extras across PUT replacements without returning them', async () => {
    const f = setup(); const row = f.createReadyGraph();
    const ref = { type: 'code-graph' as const, serviceId: 'svc', resourceId: row.code_graph_id };
    for (const extra of [{ scope: 'read_repository', nested: { revision: 1 } }, { scope: 'read_api' }]) {
      const response = await f.request('PUT', '/source-credential/put', {
        resource_type: 'code-graph', resource_id: row.code_graph_id,
        provider_id: 'gongfeng', cred_kind: 'bearer', secret: 'resource-token', extra,
      });
      expect(response.status).toBe(200);
      expect(f.sourceCredentials.get(ref)?.extra).toEqual(extra);
      const body = await response.json();
      expect(body.data.credential).not.toHaveProperty('extra');
      expect(JSON.stringify(body)).not.toContain('resource-token');
    }
  });

  it.each(['code-graph', 'wiki'] as const)('keeps resource %s CRUD usable in legacy open mode', async (type) => {
    const { request, store, sourceCredentials, createReadyGraph } = setup();
    const id = type === 'code-graph'
      ? createReadyGraph().code_graph_id
      : store.createWiki({ service_id: 'svc', team_id: 'team', name: 'External wiki' }).row.wiki_id;
    const ref = { type, serviceId: 'svc', resourceId: id };
    const query = new URLSearchParams({ resource_type: type, resource_id: id });
    const statusPath = `/source-credential/status?${query}`;
    const before = await request('GET', statusPath);
    expect(before.status).toBe(200);
    expect((await before.json()).data).toEqual({ configured: false, credential: null });

    const saved = await request('PUT', '/source-credential/put', {
      resource_type: type, resource_id: id, provider_id: type === 'wiki' ? 'iwiki' : 'gongfeng',
      cred_kind: 'bearer', secret: 'resource-secret',
    });
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain('resource-secret');
    expect(sourceCredentials.get(ref)?.secret).toBe('resource-secret');
    const configured = await request('GET', statusPath);
    expect(configured.status).toBe(200);
    expect((await configured.json()).data.configured).toBe(true);

    const removed = await request('DELETE', `/source-credential/delete?${query}`);
    expect(removed.status).toBe(200);
    expect((await removed.json()).data).toEqual({ deleted: true });
    expect(sourceCredentials.get(ref)).toBeNull();

    for (const action of ['list', 'put', 'delete', 'test', 'host-key', 'trust-host']) {
      expect((await request('POST', `/source-credential/${action}`, {})).status).toBe(503);
    }
  });

  it('atomically replaces a saved binding through the legacy provider route for its owner', async () => {
    const { request, store, sourceCredentials, gitCredentials, createGitCredential, createReadyGraph } = setup('service-key');
    const credential = createGitCredential();
    const row = createReadyGraph(credential.credential_id);
    const rejected = await request('PUT', '/source-credential/put', {
      resource_type: 'code-graph', resource_id: row.code_graph_id,
      provider_id: 'disabled-provider', cred_kind: 'bearer', secret: 'invalid-target',
    });
    expect(rejected.status).toBe(400);
    expect(store.getCodeGraphById('svc', row.code_graph_id)?.credential_id).toBe(credential.credential_id);
    expect(sourceCredentials.get({ type: 'code-graph', serviceId: 'svc', resourceId: row.code_graph_id })).toBeNull();
    const response = await request('PUT', '/source-credential/put', {
      resource_type: 'code-graph', resource_id: row.code_graph_id,
      provider_id: 'gongfeng', cred_kind: 'bearer', secret: 'competing-token',
    });
    expect(response.status).toBe(200);
    expect(sourceCredentials.get({ type: 'code-graph', serviceId: 'svc', resourceId: row.code_graph_id })?.secret).toBe('competing-token');
    expect(store.getCodeGraphById('svc', row.code_graph_id)?.credential_id).toBeNull();
    expect(gitCredentials.resolve('svc', 'team', 'alice', credential.credential_id, repo)).toMatchObject({ token: 'saved-token' });
  });

  it('rejects mixed credential creation before persisting or queueing a graph', async () => {
    const { request, store, graphs, worker, sourceCredentials, createGitCredential } = setup('service-key');
    const credential = createGitCredential();
    const response = await request('POST', '/code-graph/create', {
      team_id: 'team', user_id: 'alice', repo_url: repo, branch: 'main',
      credential_id: credential.credential_id, share_with_team: true,
      provider_id: 'gongfeng', secret: 'competing-token',
    });
    await graphs.onIdle();
    expect(response.status).toBe(400);
    expect(store.listCodeGraphs('svc', 'team')).toEqual([]);
    expect(sourceCredentials.listAllByType('code-graph')).toEqual([]);
    expect(worker).not.toHaveBeenCalled();
  });

  it('keeps a provider credential when saved replacement fails and atomically replaces it when valid', async () => {
    const { request, store, sourceCredentials, createGitCredential } = setup('service-key');
    const credential = createGitCredential();
    const { row } = store.createCodeGraph({
      service_id: 'svc', team_id: 'team', owner_user_id: 'alice', repo_url: repo, branch: 'main',
    });
    store.updateCodeGraphStatus('svc', row.code_graph_id, { status: 'ready' });
    const ref = { type: 'code-graph' as const, serviceId: 'svc', resourceId: row.code_graph_id };
    sourceCredentials.put(ref, { kind: 'bearer', secret: 'provider-token' }, 'gongfeng', 'alice');
    const binding = {
      code_graph_id: row.code_graph_id, user_id: 'alice',
      credential_id: credential.credential_id, share_with_team: true,
    };

    const rejected = await request('POST', '/code-graph/set-credential', { ...binding, credential_id: 'gitcred-missing' });
    expect(rejected.status).toBe(404);
    expect(store.getCodeGraphById('svc', row.code_graph_id)?.credential_id).toBeNull();
    expect(sourceCredentials.get(ref)?.secret).toBe('provider-token');

    expect((await request('POST', '/code-graph/set-credential', binding)).status).toBe(200);
    expect(store.getCodeGraphById('svc', row.code_graph_id)?.credential_id).toBe(credential.credential_id);
    expect(sourceCredentials.get(ref)).toBeNull();
  });

  it('does not let legacy provider or saved routes bypass ownership of a saved binding', async () => {
    const { request, createReadyGraph, createGitCredential, store, sourceCredentials } = setup('service-key');
    const credential = createGitCredential();
    const graph = createReadyGraph(credential.credential_id);
    const provider = {
      resource_type: 'code-graph', resource_id: graph.code_graph_id,
      provider_id: 'gongfeng', secret: 'replacement-token', user_id: 'alice',
    };
    expect((await request('PUT', '/source-credential/put', provider, { 'x-tdai-user-id': 'bob' })).status).toBe(403);
    const query = new URLSearchParams({ resource_type: 'code-graph', resource_id: graph.code_graph_id });
    expect((await request('DELETE', `/source-credential/delete?${query}`, undefined, { 'x-tdai-user-id': 'bob' })).status).toBe(404);
    expect((await request('POST', '/code-graph/set-credential', {
      code_graph_id: graph.code_graph_id, credential_id: null, user_id: 'bob',
    })).status).toBe(403);
    expect(store.getCodeGraphById('svc', graph.code_graph_id)?.credential_id).toBe(credential.credential_id);
    expect(sourceCredentials.get({ type: 'code-graph', serviceId: 'svc', resourceId: graph.code_graph_id })).toBeNull();
  });

  it('rejects incomplete legacy authentication before persisting or queueing a graph', async () => {
    const { request, store, graphs, worker } = setup('service-key');
    for (const fields of [
      { provider_id: 'gongfeng' }, { secret: 'token' }, { username: 'reader' },
      { provider_id: 'gongfeng', secret: '' }, { provider_id: 123, secret: 'token' },
      { credential_id: '' }, { credential_id: 123 }, { credential_id: null },
      { credential_id: 'cred', secret: 'token' },
    ]) {
      const response = await request('POST', '/code-graph/create', {
        team_id: 'team', user_id: 'alice', repo_url: repo, ...fields,
      });
      expect(response.status).toBe(400);
    }
    await graphs.onIdle();
    expect(store.listCodeGraphs('svc', 'team')).toEqual([]);
    expect(worker).not.toHaveBeenCalled();
  });

  it('requires trusted resource identity headers and rejects a different team or service', async () => {
    const { request, createReadyGraph, sourceCredentials } = setup('service-key');
    const graph = createReadyGraph();
    const body = {
      resource_type: 'code-graph', resource_id: graph.code_graph_id,
      provider_id: 'gongfeng', secret: 'token',
      user_id: 'alice', team_id: 'team', service_id: 'svc',
    };
    for (const header of ['x-tdai-service-id', 'x-tdai-team-id', 'x-tdai-user-id']) {
      expect((await request('PUT', '/source-credential/put', body, { [header]: null })).status).toBe(400);
    }
    for (const header of ['x-tdai-service-id', 'x-tdai-team-id']) {
      expect((await request('PUT', '/source-credential/put', body, { [header]: 'other' })).status).toBe(404);
    }
    expect(sourceCredentials.get({ type: 'code-graph', serviceId: 'svc', resourceId: graph.code_graph_id })).toBeNull();
  });

  it('keeps resource rotation available to team members while saved changes require service authentication', async () => {
    const { request, createReadyGraph, createGitCredential, sourceCredentials } = setup('service-key');
    const graph = createReadyGraph();
    const provider = { resource_type: 'code-graph', resource_id: graph.code_graph_id, provider_id: 'gongfeng', secret: 'first-token' };
    expect((await request('PUT', '/source-credential/put', provider)).status).toBe(200);
    expect((await request('PUT', '/source-credential/put', {
      ...provider, secret: 'rotated-token', user_id: 'alice',
    }, { 'x-tdai-user-id': 'bob' })).status).toBe(200);
    const ref = { type: 'code-graph' as const, serviceId: 'svc', resourceId: graph.code_graph_id };
    expect(sourceCredentials.get(ref)?.secret).toBe('rotated-token');

    const credential = createGitCredential();
    expect((await request('POST', '/code-graph/set-credential', {
      code_graph_id: graph.code_graph_id, user_id: 'alice',
      credential_id: credential.credential_id, share_with_team: true,
    }, { authorization: null })).status).toBe(401);
    expect(sourceCredentials.get(ref)?.secret).toBe('rotated-token');

    const savedFixture = setup('service-key');
    const saved = savedFixture.createReadyGraph(savedFixture.createGitCredential().credential_id);
    expect((await savedFixture.request('PUT', '/source-credential/put', {
      ...provider, resource_id: saved.code_graph_id,
    }, { authorization: null })).status).toBe(401);
  });
});

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

const closers: (() => void)[] = [];
afterEach(() => closers.splice(0).forEach(close => close()));

const repo = 'https://github.com/owner/private.git';
function setup(serviceKey = '') {
  const { db, raw } = createDb({ path: ':memory:' });
  closers.push(() => raw.close());
  const store = new SqliteKnowledgeStore(db);
  const gitCredentials = new GitCredentialStore(db, 'ab'.repeat(32));
  const sourceCredentials = createCredentialStore({ db });
  const worker = vi.fn(async () => ({ commitHash: '123456' }));
  const graphs = new CodeGraphService({ store, worker, dataRoot: '/unused', credentialStore: sourceCredentials });
  const app = new Hono();
  // Match server.ts registration order: both APIs share the same prefix.
  app.route('/source-credential', createGitCredentialRoutes(gitCredentials, serviceKey));
  app.route('/source-credential', createSourceCredentialRoutes({ credentialStore: sourceCredentials, store }));
  app.route('/code-graph', createCodeGraphRoutes({
    cgService: graphs, credentialStore: gitCredentials, sourceCredentialStore: sourceCredentials, serviceKey,
    instancePool: { get: () => undefined, set() {}, delete() {} }, publicBaseUrl: '',
  }));
  const request = (method: string, path: string, body?: object) => app.request(path, {
    method,
    headers: {
      'content-type': 'application/json', 'x-tdai-service-id': 'svc',
      'x-tdai-team-id': 'team', 'x-tdai-user-id': 'alice',
      ...(serviceKey ? { authorization: `Bearer ${serviceKey}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const createGitCredential = () => gitCredentials.put('svc', 'team', 'alice', {
    name: 'Saved Git credential', hostname: 'github.com',
    secret: { kind: 'https', username: 'reader', token: 'saved-token' },
  });
  return { request, store, graphs, worker, sourceCredentials, gitCredentials, createGitCredential };
}

describe('reusable Git and resource credentials coexistence', () => {
  it.each(['code-graph', 'wiki'] as const)('keeps resource %s CRUD usable in legacy open mode', async (type) => {
    const { request, store, sourceCredentials } = setup();
    const id = type === 'code-graph'
      ? store.createCodeGraph({ service_id: 'svc', team_id: 'team', repo_url: repo, branch: 'main' }).row.code_graph_id
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

  it('rejects provider writes to a graph already using an owner-managed Git credential', async () => {
    const { request, store, sourceCredentials, gitCredentials, createGitCredential } = setup('service-key');
    const credential = createGitCredential();
    const { row } = store.createCodeGraph({
      service_id: 'svc', team_id: 'team', owner_user_id: 'alice',
      repo_url: repo, branch: 'main', credential_id: credential.credential_id,
    });
    const response = await request('PUT', '/source-credential/put', {
      resource_type: 'code-graph', resource_id: row.code_graph_id,
      provider_id: 'gongfeng', cred_kind: 'bearer', secret: 'competing-token',
    });
    expect(response.status).toBe(409);
    expect(sourceCredentials.get({ type: 'code-graph', serviceId: 'svc', resourceId: row.code_graph_id })).toBeNull();
    expect(store.getCodeGraphById('svc', row.code_graph_id)?.credential_id).toBe(credential.credential_id);
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

  it('requires removal of a provider credential before binding a saved Git credential', async () => {
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

    const rejected = await request('POST', '/code-graph/set-credential', binding);
    expect(rejected.status).toBe(409);
    expect(store.getCodeGraphById('svc', row.code_graph_id)?.credential_id).toBeNull();
    expect(sourceCredentials.get(ref)?.secret).toBe('provider-token');

    const query = new URLSearchParams({ resource_type: 'code-graph', resource_id: row.code_graph_id });
    expect((await request('DELETE', `/source-credential/delete?${query}`)).status).toBe(200);
    expect((await request('POST', '/code-graph/set-credential', binding)).status).toBe(200);
    expect(store.getCodeGraphById('svc', row.code_graph_id)?.credential_id).toBe(credential.credential_id);
  });
});

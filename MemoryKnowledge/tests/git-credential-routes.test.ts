import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { GitSourceFetcher } from '../src/source-fetcher/git-fetcher.js';
import { createDb } from '../src/db/client.js';
import { GitCredentialStore } from '../src/store/git-credential-store.js';
import { SqliteKnowledgeStore } from '../src/store/sqlite-store.js';
import { CodeGraphService } from '../src/store/code-graph-service.js';
import { createGitCredentialRoutes } from '../src/routes/git-credential.js';
import { createCodeGraphRoutes } from '../src/routes/code-graph.js';

const closers: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); closers.splice(0).forEach((close) => close()); });
const repo = 'https://github.com/owner/private.git';
function setup(serviceKey = 'service-test-key') {
  const { db, raw } = createDb({ path: ':memory:' }); closers.push(() => raw.close());
  const credentials = new GitCredentialStore(db, 'ab'.repeat(32));
  const store = new SqliteKnowledgeStore(db);
  const worker = vi.fn(async () => ({ commitHash: '123456', stats: { files: 1, nodes: 1, edges: 0 } }));
  const graphs = new CodeGraphService({ store, worker, dataRoot: '/unused' });
  const app = new Hono();
  app.route('/credentials', createGitCredentialRoutes(credentials, serviceKey));
  app.route('/graphs', createCodeGraphRoutes({ cgService: graphs, credentialStore: credentials, serviceKey,
    instancePool: { get: () => undefined, set() {}, delete() {} }, publicBaseUrl: '' }));
  const request = (path: string, body: unknown, authorization = 'Bearer service-test-key') => app.request(path, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-tdai-service-id': 'svc', authorization }, body: JSON.stringify(body),
  });
  const createCredential = (user = 'alice') => credentials.put('svc', 'team', user, { name: 'private', hostname: 'github.com', secret: { kind: 'https', username: 'reader', token: 'top-secret-token' } });
  return { request, createCredential, graphs, store, worker, credentials };
}

describe('private Git API contract', () => {
  it('requires hostname rather than accepting development-only URL aliases', async () => {
    const { request } = setup();
    const body = { team_id: 'team', user_id: 'alice', name: 'private', secret: { kind: 'https', username: 'reader', token: 'synthetic' } };
    for (const oldInput of [{ server_url: 'https://github.com' }, { repo_url: repo }]) {
      expect((await request('/credentials/put', { ...body, ...oldInput })).status).toBe(400);
    }
    const response = await request('/credentials/put', { ...body, hostname: 'github.com' });
    expect(response.status).toBe(200);
    expect((await response.json()).data).not.toHaveProperty('server_url');
  });
  it('creates hostname-only HTTPS credentials and tests other paths and ports on that hostname', async () => {
    const { request } = setup();
    const response = await request('/credentials/put', { team_id: 'team', user_id: 'alice', name: 'CNB', hostname: 'CNB.COOL', secret: { kind: 'https', username: 'reader', token: 'synthetic-token' } });
    expect(response.status).toBe(200);
    const info = (await response.json()).data;
    expect(info.hostname).toBe('cnb.cool');
    const test = vi.spyOn(GitSourceFetcher.prototype, 'test').mockResolvedValue(undefined);
    const scope = { team_id: 'team', user_id: 'alice', credential_id: info.credential_id };
    for (const repo_url of ['https://cnb.cool/one/repo', 'https://cnb.cool:8443/two/repo']) {
      expect((await request('/credentials/test', { ...scope, repo_url })).status).toBe(200);
    }
    expect((await request('/credentials/test', { ...scope, repo_url: 'https://cnb.cool.evil.example/repo' })).status).toBe(403);
    expect(test).toHaveBeenCalledTimes(2);
  });
  it('requires service authentication for every credential endpoint, even in legacy open mode', async () => {
    for (const configured of [true, false]) {
      const { request } = setup(configured ? 'service-test-key' : '');
      for (const action of ['list', 'put', 'delete', 'test', 'host-key', 'trust-host']) {
        expect((await request(`/credentials/${action}`, {}, '')).status).toBe(configured ? 401 : 503);
      }
    }
  });
  it('does not disclose other owners’ credentials or echo malformed secrets', async () => {
    const { request, createCredential } = setup();
    const info = createCredential();
    const list = await request('/credentials/list', { team_id: 'team', user_id: 'bob' });
    expect((await list.json()).data.items).toEqual([]);
    expect((await request('/credentials/delete', { team_id: 'team', user_id: 'bob', credential_id: info.credential_id })).status).toBe(404);
    const invalid = await request('/credentials/put', { team_id: 'team', user_id: 'alice', name: 'test', repo_url: 'https://reader:top-secret-token@host/repo', secret: 'top-secret-token' });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain('top-secret-token');
  });
  it('checks credential owner, server scope and explicit sharing before queueing a build', async () => {
    const { request, createCredential, graphs, worker } = setup();
    const info = createCredential();
    const body = { team_id: 'team', user_id: 'alice', repo_url: repo, branch: 'main', credential_id: info.credential_id };
    expect((await request('/graphs/create', body)).status).toBe(400);
    expect((await request('/graphs/create', { ...body, share_with_team: true }, '')).status).toBe(401);
    expect((await request('/graphs/create', { ...body, user_id: 'bob', share_with_team: true })).status).toBe(404);
    expect((await request('/graphs/create', { ...body, repo_url: 'https://evil.example/repo.git', share_with_team: true })).status).toBe(403);
    expect(worker).not.toHaveBeenCalled();
    const result = await request('/graphs/create', { ...body, share_with_team: true });
    expect(result.status).toBe(201);
    const created = (await result.json()).data;
    await graphs.onIdle();
    expect(worker.mock.calls[0][0]).toMatchObject({ credentialId: info.credential_id, ownerUserId: 'alice', serviceId: 'svc', teamId: 'team' });
    expect(JSON.stringify(created)).not.toContain('top-secret-token');
    const second = await request('/graphs/create', { ...body, repo_url: 'https://github.com/other/another.git', share_with_team: true });
    expect(second.status).toBe(201);
    await graphs.onIdle();
    expect(worker.mock.calls[1][0]).toMatchObject({ credentialId: info.credential_id, repoUrl: 'https://github.com/other/another.git' });
  });
  it('requires a separate test repository and checks its server before attempting Git access', async () => {
    const { request, createCredential } = setup();
    const info = createCredential();
    const test = vi.spyOn(GitSourceFetcher.prototype, 'test').mockResolvedValue(undefined);
    const scope = { team_id: 'team', user_id: 'alice', credential_id: info.credential_id };
    expect((await request('/credentials/test', scope)).status).toBe(400);
    expect((await request('/credentials/test', { ...scope, repo_url: 'https://evil.example/repo.git' })).status).toBe(403);
    expect(test).not.toHaveBeenCalled();
    for (const repo_url of [repo, 'https://github.com/other/another.git']) {
      expect((await request('/credentials/test', { ...scope, repo_url })).status).toBe(200);
      expect(test).toHaveBeenLastCalledWith(repo_url, expect.objectContaining({ token: 'top-secret-token' }));
    }
  });

  it('rejects unsafe URLs and branches before storing anything', async () => {
    const { request, worker } = setup();
    for (const body of [{ repo_url: 'https://token:secret@github.com/repo.git' }, { repo_url: repo, branch: '--upload-pack=evil' }, { repo_url: 'git@github.com:repo.git' }]) {
      expect((await request('/graphs/create', { team_id: 'team', ...body })).status).toBe(400);
    }
    expect(worker).not.toHaveBeenCalled();
  });
  it('preserves public create and permits owner-only credential rebinding after completion', async () => {
    const { request, createCredential, graphs } = setup();
    const created = await request('/graphs/create', { team_id: 'team', user_id: 'alice', repo_url: repo });
    const graph = (await created.json()).data;
    await graphs.onIdle();
    expect(graph.credential_id).toBeNull();
    const cred = createCredential();
    const binding = { code_graph_id: graph.code_graph_id, user_id: 'alice', credential_id: cred.credential_id, share_with_team: true };
    expect((await request('/graphs/set-credential', { ...binding, user_id: 'bob' })).status).toBe(403);
    expect((await request('/graphs/set-credential', binding)).status).toBe(200);
    expect(graphs.getById('svc', graph.code_graph_id)?.credential_id).toBe(cred.credential_id);
    await request('/graphs/sync', { code_graph_id: graph.code_graph_id });
    await graphs.onIdle();
    expect(graphs.getById('svc', graph.code_graph_id)?.status).toBe('ready');
  });
});

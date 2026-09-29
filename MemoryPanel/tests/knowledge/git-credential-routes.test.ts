import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { registerGitCredentialRoutes } from '../../src/panel/http/routes/knowledge/git-credential-routes.js';
import { registerKnowledgeCodeGraphRoutes } from '../../src/panel/http/routes/knowledge/code-graph-routes.js';
import type { PanelDeps } from '../../src/panel/panel-deps.js';

vi.mock('../../src/panel/http/middleware/validate-panel-headers.js', () => ({
  validatePanelMetaHeaders: () => async (c: any, next: () => Promise<void>) => {
    c.set('panelMeta', { instanceId: 'svc', userKey: 'alice-key' }); await next();
  },
}));
function setup(member = true, owner = 'alice') {
  const client = {
    gitCredentialList: vi.fn(async () => ({ items: [] })), gitCredentialPut: vi.fn(async () => ({ credential_id: 'cred' })),
    gitCredentialDelete: vi.fn(async () => ({ deleted: true })), gitCredentialTest: vi.fn(async () => ({ accessible: true })),
    gitCredentialHostKey: vi.fn(async () => ({ trusted: false })), gitCredentialTrustHost: vi.fn(async () => ({ trusted: true })),
    codeGraphGet: vi.fn(async () => ({ owner_user_id: owner })), codeGraphSetCredential: vi.fn(async () => ({})),
  };
  const deps = {
    knowledgeClientFactory: vi.fn(() => client),
    metaKernel: { invoke: vi.fn(async (action: string) => {
      if (action === 'auth/verify') return { code: 0, data: { valid: true, user: { user_id: 'alice' } } };
      if (action === 'team-member/get') return { code: member ? 0 : 403, data: member ? {} : null };
      if (action === 'asset/get') return { code: 0, data: { team_id: 'team' } };
      if (action === 'acl/check') return { code: 0, data: { allowed: true } };
      throw new Error(action);
    }) },
  } as unknown as PanelDeps;
  const app = new Hono(); registerGitCredentialRoutes(app, deps); registerKnowledgeCodeGraphRoutes(app, deps);
  const request = (path: string, body: object) => app.request('/knowledge/' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { request, client };
}

describe('Panel Git credential authorization', () => {
  it('uses authenticated identity instead of body user/team spoofing', async () => {
    const { request, client } = setup();
    const secret = { kind: 'https', username: 'reader', token: 'secret' };
    expect((await request('source-credential/put', { team_id: 'team', user_id: 'victim', owner_user_id: 'victim', service_id: 'other', name: 'repo', hostname: 'host', secret })).status).toBe(200);
    expect(client.gitCredentialPut).toHaveBeenCalledWith('team', 'alice', { credential_id: undefined, name: 'repo', hostname: 'host', secret });
  });
  it('forwards hostname-only credential input without adding a protocol', async () => {
    const { request, client } = setup();
    const secret = { kind: 'https', username: 'reader', token: 'synthetic' };
    expect((await request('source-credential/put', { team_id: 'team', name: 'Hostname credential', hostname: 'cnb.cool', secret })).status).toBe(200);
    expect(client.gitCredentialPut).toHaveBeenCalledWith('team', 'alice', {
      credential_id: undefined, name: 'Hostname credential', hostname: 'cnb.cool', secret,
    });
  });
  it('forwards the selected test repository with the authenticated caller', async () => {
    const { request, client } = setup();
    expect((await request('source-credential/test', { team_id: 'team', credential_id: 'cred', repo_url: 'https://host/another.git', user_id: 'victim' })).status).toBe(200);
    expect(client.gitCredentialTest).toHaveBeenCalledWith('team', 'alice', 'cred', 'https://host/another.git');
  });
  it('derives the caller identity for SSH host discovery and trust confirmation', async () => {
    const { request, client } = setup();
    const scope = { team_id: 'team', credential_id: 'cred', repo_url: 'git@host:repo.git', user_id: 'victim' };
    expect((await request('source-credential/host-key', { ...scope, refresh: true })).status).toBe(200);
    expect(client.gitCredentialHostKey).toHaveBeenCalledWith('team', 'alice', 'cred', scope.repo_url, true);
    expect((await request('source-credential/trust-host', { ...scope, known_hosts: 'public key', previous_known_hosts: null })).status).toBe(200);
    expect(client.gitCredentialTrustHost).toHaveBeenCalledWith('team', 'alice', 'cred', scope.repo_url, 'public key', null);
    expect((await request('source-credential/trust-host', { ...scope, known_hosts: 'public key' })).status).toBe(400);
  });
  it('blocks every management action for non-members', async () => {
    const { request, client } = setup(false);
    for (const action of ['list', 'put', 'test', 'delete', 'host-key', 'trust-host']) {
      expect((await request('source-credential/' + action, { team_id: 'team', credential_id: 'id' })).status).toBe(403);
    }
    for (const fn of Object.values(client)) expect(fn).not.toHaveBeenCalled();
  });
  it('does not let a team admin replace another owner’s credential', async () => {
    const { request, client } = setup(true, 'bob');
    expect((await request('code-graph/set-credential', { code_graph_id: 'cg-test', credential_id: 'cred', share_with_team: true })).status).toBe(403);
    expect(client.codeGraphSetCredential).not.toHaveBeenCalled();
  });
});

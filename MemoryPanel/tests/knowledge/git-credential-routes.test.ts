import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { registerGitCredentialRoutes } from '../../src/panel/http/routes/knowledge/git-credential-routes.js';
import { registerKnowledgeCodeGraphRoutes } from '../../src/panel/http/routes/knowledge/code-graph-routes.js';
import { registerKnowledgeSourceRoutes } from '../../src/panel/http/routes/knowledge/source-routes.js';
import { HttpKnowledgeClient } from '../../src/panel/kernel/adapters/http-knowledge-client.js';
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
    codeGraphCreate: vi.fn(async () => ({ code_graph_id: 'cg-test' })),
    codeGraphGet: vi.fn(async () => ({ owner_user_id: owner })), codeGraphSetCredential: vi.fn(async () => ({})),
    sourceCredentialPut: vi.fn(async () => ({ provider_id: 'custom', cred_kind: 'bearer' })),
  };
  const deps = {
    knowledgeClientFactory: vi.fn(() => client),
    knowledgeTaskRegistry: { record: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn() },
    metaKernel: { invoke: vi.fn(async (action: string) => {
      if (action === 'auth/verify') return { code: 0, data: { valid: true, user: { user_id: 'alice' } } };
      if (action === 'team-member/get') return { code: member ? 0 : 403, data: member ? {} : null };
      if (action === 'asset/get') return { code: 0, data: { team_id: 'team' } };
      if (action === 'acl/check') return { code: 0, data: { allowed: true } };
      throw new Error(action);
    }) },
  } as unknown as PanelDeps;
  const app = new Hono(); registerGitCredentialRoutes(app, deps); registerKnowledgeCodeGraphRoutes(app, deps);
  registerKnowledgeSourceRoutes(app, deps);
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
  it('rejects incomplete legacy credentials rather than creating a public repository', async () => {
    const { request, client } = setup();
    for (const fields of [
      { provider_id: 'gongfeng' }, { secret: 'token' }, { username: 'reader' },
      { provider_id: 'gongfeng', secret: '' }, { provider_id: 123, secret: 'token' },
      { credential_id: '' }, { credential_id: 123 }, { credential_id: null },
      { credential_id: 'cred', secret: 'token' }, { share_with_team: 'true' },
    ]) {
      expect((await request('code-graph/create', { team_id: 'team', repo_url: 'https://host/repo', ...fields })).status).toBe(400);
    }
    expect(client.codeGraphCreate).not.toHaveBeenCalled();
  });
  it('preserves the exact username and secret in legacy creation', async () => {
    const { request, client } = setup();
    expect((await request('code-graph/create', {
      team_id: 'team', repo_url: 'https://host/repo', provider_id: 'custom-basic',
      username: ' reader ', secret: ' password ',
    })).status).toBe(200);
    expect(client.codeGraphCreate).toHaveBeenCalledWith('team', 'https://host/repo', undefined, 'alice', undefined,
      expect.objectContaining({ providerId: 'custom-basic', username: ' reader ', secret: ' password ' }));
  });
  it.each([
    { kind: 'bearer', username: undefined, secret: ' synthetic @:/?#% token ' },
    { kind: 'basic', username: ' reader @:/?#% ', secret: ' synthetic password ' },
  ])('preserves identical credential bytes when creating and rotating a $kind CodeGraph source', async ({ kind, username, secret }) => {
    const { request, client } = setup();
    const fields = { provider_id: 'custom', secret, username };
    expect((await request('code-graph/create', {
      team_id: 'team', repo_url: 'https://host/repo', ...fields,
    })).status).toBe(200);
    expect((await request('source/credential', {
      team_id: 'team', resource_type: 'code-graph', resource_id: 'cg-test', cred_kind: kind, ...fields,
    })).status).toBe(200);
    expect(client.codeGraphCreate).toHaveBeenCalledWith('team', 'https://host/repo', undefined, 'alice', undefined,
      expect.objectContaining({ providerId: 'custom', secret, username }));
    expect(client.sourceCredentialPut).toHaveBeenCalledWith('code-graph', 'cg-test', { teamId: 'team', userId: 'alice' }, {
      provider_id: 'custom', cred_kind: kind, secret, username,
    });
  });
  it('rejects missing, empty and non-string CodeGraph credentials before forwarding', async () => {
    const { request, client } = setup();
    const input = {
      team_id: 'team', resource_type: 'code-graph', resource_id: 'cg-test', provider_id: 'custom',
      cred_kind: 'basic', secret: 'synthetic', username: 'reader',
    };
    for (const invalid of [undefined, null, '', 123, false, {}]) {
      expect((await request('source/credential', { ...input, secret: invalid })).status).toBe(400);
      expect((await request('source/credential', { ...input, username: invalid })).status).toBe(400);
    }
    expect((await request('source/credential', { ...input, cred_kind: 'bearer', username: 123 })).status).toBe(400);
    expect(client.sourceCredentialPut).not.toHaveBeenCalled();
  });
  it('keeps the existing Wiki credential normalization', async () => {
    const { request, client } = setup();
    expect((await request('source/credential', {
      team_id: 'team', resource_type: 'wiki', resource_id: 'wiki-test', provider_id: 'custom',
      cred_kind: 'basic', secret: ' synthetic password ', username: ' reader ',
    })).status).toBe(200);
    expect(client.sourceCredentialPut).toHaveBeenCalledWith('wiki', 'wiki-test', { teamId: 'team', userId: 'alice' }, {
      provider_id: 'custom', cred_kind: 'basic', secret: 'synthetic password', username: 'reader',
    });
  });
});

describe('Knowledge HTTP credential forwarding', () => {
  it('preserves an incomplete legacy auth request so Knowledge can reject it', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      code: 400, message: 'secret is required',
    }), { status: 400, headers: { 'content-type': 'application/json' } }));
    globalThis.fetch = fetchMock;
    try {
      const client = new HttpKnowledgeClient({ baseUrl: 'http://knowledge.test', authToken: 'service-key', serviceId: 'svc' });
      await expect(client.codeGraphCreate('team', 'https://host/repo', undefined, 'alice', undefined, {
        providerId: 'gongfeng',
      })).rejects.toThrow('secret is required');
      expect(fetchMock).toHaveBeenCalledOnce();
      const [, request] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(JSON.parse(request.body as string)).toMatchObject({
        team_id: 'team', user_id: 'alice', provider_id: 'gongfeng',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

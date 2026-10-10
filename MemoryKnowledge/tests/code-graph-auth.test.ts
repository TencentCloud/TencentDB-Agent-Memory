import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '../src/db/client.js';
import { SqliteKnowledgeStore } from '../src/store/sqlite-store.js';
import { GitCredentialStore } from '../src/store/git-credential-store.js';
import { CodeGraphService } from '../src/store/code-graph-service.js';
import { CodeSourceRegistry } from '../src/code-source/registry.js';
import { basicAuthMethod } from '../src/code-source/auth-methods/basic.js';
import { createCredentialStore } from '../src/source-auth/credential-store.js';
import { CodeGraphAuthService, type CodeGraphAuthInput } from '../src/source-auth/code-graph-auth.js';

const repo = 'https://git.example.com/owner/repo.git';
const actor = { serviceId: 'svc', teamId: 'team', userId: 'alice', serviceAuthenticated: true };
const member = { ...actor, userId: 'bob' };
const resource = { mode: 'resource', provider_id: 'gongfeng', secret: 'resource-token' } as const;
const params = { service_id: 'svc', team_id: 'team', repo_url: repo, branch: 'main', authActor: actor };
const close: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); close.splice(0).reverse().forEach(fn => fn()); });

function setup(path = ':memory:') {
  const { db, raw } = createDb({ path });
  close.push(() => raw.close());
  const store = new SqliteKnowledgeStore(db);
  const gitCredentialStore = new GitCredentialStore(db, 'ab'.repeat(32));
  const credentialStore = createCredentialStore({ db });
  const codeSourceRegistry = new CodeSourceRegistry(['gongfeng']);
  codeSourceRegistry.register({ id: 'basic', authMethod: basicAuthMethod, sitePaths: {} });
  const service = new CodeGraphAuthService({ db, store, gitCredentialStore, credentialStore, codeSourceRegistry });
  const saved = (userId = actor.userId) => gitCredentialStore.put('svc', 'team', userId, {
    name: 'Reusable', hostname: 'git.example.com', secret: { kind: 'https', username: 'reader', token: 'saved-token' },
  });
  const create = (input: CodeGraphAuthInput = { mode: 'none' }) => {
    const credential = input.mode === 'resource' ? { provider_id: input.provider_id, secret: input.secret, username: input.username } : undefined;
    const result = service.create({ ...params, credential,
      ...(input.mode === 'saved' ? { credential_id: input.credential_id, share_with_team: input.share_with_team } : {}) });
    store.updateCodeGraphStatus('svc', result.row.code_graph_id, { status: 'ready' });
    return result.row.code_graph_id;
  };
  const ref = (id: string) => ({ type: 'code-graph' as const, serviceId: 'svc', resourceId: id });
  return { raw, store, gitCredentialStore, credentialStore, codeSourceRegistry, service, saved, create, ref };
}

describe('shared CodeGraph authentication rules', () => {
  it('atomically replaces public, resource and reusable credentials without copying or deleting vault secrets', () => {
    const f = setup(); const id = f.create();
    expect(f.service.resolve('svc', id)).toEqual({ url: repo });
    f.service.replace('svc', id, resource, actor);
    expect(f.service.resolve('svc', id).auth).toMatchObject({ kind: 'https', username: 'private', token: resource.secret });
    const credential = f.saved();
    f.service.replace('svc', id, { mode: 'saved', credential_id: credential.credential_id, share_with_team: true }, actor);
    expect(f.credentialStore.status(f.ref(id))).toBeNull();
    expect(f.service.resolve('svc', id).auth).toMatchObject({ token: 'saved-token' });
    f.service.replace('svc', id, resource, actor);
    expect(f.store.getCodeGraphById('svc', id)?.credential_id).toBeNull();
    expect(f.gitCredentialStore.list('svc', 'team', 'alice')).toHaveLength(1);
  });

  it('preserves team maintenance of resource credentials, including provider changes and deletion', () => {
    const f = setup(); const id = f.create(resource);
    f.service.replace('svc', id, { mode: 'resource', provider_id: 'basic', username: 'team-reader', secret: 'new' }, member);
    expect(f.service.resolve('svc', id).auth).toMatchObject({ username: 'team-reader', token: 'new' });
    expect(f.service.deleteResource('svc', id, member)).toEqual({ deleted: true });
    expect(f.service.resolve('svc', id)).toEqual({ url: repo });
    f.service.replace('svc', id, resource, member);
    const other = f.saved('bob');
    expect(() => f.service.replace('svc', id, { mode: 'saved', credential_id: other.credential_id, share_with_team: true }, member)).toThrow(/graph owner/);
  });

  it('checks both graph ownership and ownership of the target reusable credential', () => {
    const f = setup(); const id = f.create(resource); const other = f.saved('bob');
    expect(() => f.service.replace('svc', id, { mode: 'saved', credential_id: other.credential_id, share_with_team: true }, actor)).toThrow(/not found/);
    expect(f.credentialStore.get(f.ref(id))?.secret).toBe(resource.secret);
    const own = f.saved();
    f.service.replace('svc', id, { mode: 'saved', credential_id: own.credential_id, share_with_team: true }, actor);
    expect(() => f.service.replace('svc', id, resource, member)).toThrow(/graph owner/);
    expect(() => f.service.replace('svc', id, { mode: 'none' }, member)).toThrow(/graph owner/);
    expect(() => f.service.deleteResource('svc', id, actor)).toThrow(/not found/);
    expect(f.service.resolve('svc', id).auth).toMatchObject({ token: 'saved-token' });
  });

  it('requires service authentication, sharing consent and a matching host for reusable credentials', () => {
    const f = setup(); const id = f.create(resource); const own = f.saved();
    const untrusted = { ...actor, serviceAuthenticated: false };
    const input = { mode: 'saved', credential_id: own.credential_id, share_with_team: true } as const;
    expect(() => f.service.replace('svc', id, input, untrusted)).toThrow(/service authentication/);
    expect(() => f.service.create({ ...params, credential_id: own.credential_id, share_with_team: true, authActor: untrusted })).toThrow(/service authentication/);
    expect(() => f.service.replace('svc', id, { ...input, share_with_team: false }, actor)).toThrow(/sharing/);
    const otherHost = f.gitCredentialStore.put('svc', 'team', 'alice', { name: 'other', hostname: 'other.example.com', secret: { kind: 'https', username: 'git', token: 'other' } });
    expect(() => f.service.replace('svc', id, { ...input, credential_id: otherHost.credential_id }, actor)).toThrow(/different Git hostname/);
    f.service.replace('svc', id, input, actor);
    expect(() => f.service.resourceStatus('svc', id, untrusted)).toThrow(/service authentication/);
    expect(() => f.service.replace('svc', id, resource, untrusted)).toThrow(/service authentication/);
  });

  it('reads one snapshot while a second connection commits a replacement', () => {
    const dir = mkdtempSync(join(tmpdir(), 'code-auth-snapshot-'));
    close.push(() => rmSync(dir, { recursive: true, force: true }));
    const f = setup(join(dir, 'db.sqlite')); const id = f.create(resource);
    const concurrent = setup(join(dir, 'db.sqlite')); const own = concurrent.saved();
    const original = f.store.getCodeGraphById.bind(f.store);
    vi.spyOn(f.store, 'getCodeGraphById').mockImplementationOnce((svc, graph) => {
      const row = original(svc, graph);
      concurrent.service.replace('svc', id, { mode: 'saved', credential_id: own.credential_id, share_with_team: true }, actor);
      return row;
    });
    expect(f.service.resourceStatus('svc', id, actor)?.provider_id).toBe('gongfeng');
    expect(f.service.resourceStatus('svc', id, actor)).toBeNull();
  });

  it('rolls back an existing resource secret when replacement persistence fails', () => {
    const f = setup(); const id = f.create(resource);
    vi.spyOn(f.credentialStore, 'put').mockImplementationOnce(() => { throw new Error('synthetic write failure'); });
    expect(() => f.service.replace('svc', id, { ...resource, secret: 'replacement' }, actor)).toThrow(/write failure/);
    expect(f.credentialStore.get(f.ref(id))?.secret).toBe(resource.secret);
  });

  it('rolls back failed creation and enqueues successful work only after committing credentials', async () => {
    const f = setup();
    const worker = vi.fn(async (ctx) => {
      expect(f.raw.inTransaction).toBe(false);
      expect(f.service.resolve(ctx.serviceId, ctx.codeGraphId).auth).toMatchObject({ token: resource.secret });
      return {};
    });
    const graphs = new CodeGraphService({ store: f.store, authService: f.service, worker, dataRoot: tmpdir() });
    const createParams = { ...params, credential: { provider_id: resource.provider_id, secret: resource.secret } };
    vi.spyOn(f.credentialStore, 'put').mockImplementationOnce(() => { throw new Error('synthetic write failure'); });
    expect(() => graphs.create(createParams)).toThrow(/write failure/);
    await graphs.onIdle();
    expect(f.store.listCodeGraphs('svc', 'team')).toEqual([]);
    expect(f.credentialStore.listAllByType('code-graph')).toEqual([]);
    expect(worker).not.toHaveBeenCalled();
    const { row } = graphs.create(createParams);
    await graphs.onIdle();
    expect(graphs.create(params).existed).toBe(true);
    expect(f.service.resourceStatus('svc', row.code_graph_id, actor)?.provider_id).toBe('gongfeng');
    expect(worker).toHaveBeenCalledTimes(1);
  });

  it('validates duplicate create input while allowing a member to retrieve the existing graph without changing its binding', () => {
    const f = setup(); const id = f.create(resource);
    for (const invalid of [
      { ...params, credential_id: '' },
      { ...params, credential_id: 'does-not-exist' },
      { ...params, credential: { provider_id: 'gongfeng', secret: undefined as unknown as string } },
    ]) {
      expect(() => f.service.create(invalid)).toThrow();
      try { f.service.create(invalid); } catch (error) { expect(error).toMatchObject({ status: 400 }); }
    }
    const own = f.saved('bob');
    const duplicate = f.service.create({ ...params, authActor: member, credential_id: own.credential_id, share_with_team: true });
    expect(duplicate.existed).toBe(true);
    expect(duplicate.row.code_graph_id).toBe(id);
    expect(duplicate.row.owner_user_id).toBe('alice');
    expect(duplicate.row.credential_id).toBeNull();
    expect(f.credentialStore.get(f.ref(id))?.secret).toBe(resource.secret);
    expect(f.store.listCodeGraphs('svc', 'team')).toHaveLength(1);
  });

  it('exposes conflict metadata for repair while refusing runtime fallback and unsafe resource deletion', () => {
    const f = setup(); const id = f.create(resource); const own = f.saved();
    f.store.updateCodeGraphMeta('svc', id, { credential_id: own.credential_id });
    expect(f.service.resourceStatus('svc', id, actor)?.provider_id).toBe('gongfeng');
    expect(() => f.service.resolve('svc', id)).toThrow(/Multiple authentication/);
    expect(() => f.service.deleteResource('svc', id, actor)).toThrow(/Multiple authentication/);
    expect(() => f.service.replace('svc', id, resource, member)).toThrow(/graph owner/);
    f.service.replace('svc', id, resource, actor);
    expect(f.store.getCodeGraphById('svc', id)?.credential_id).toBeNull();
  });

  it.each(['!!!', Buffer.from('bad\u0000token').toString('base64')])('never treats malformed resource data as public access (%s)', (encoded) => {
    const f = setup(); const id = f.create(resource);
    f.raw.prepare('UPDATE knowledge_source_credential SET cred_secret = ? WHERE resource_id = ?').run(encoded, id);
    expect(() => f.service.resolve('svc', id)).toThrow(/invalid or unavailable/);
    f.service.replace('svc', id, resource, member);
    expect(f.service.resolve('svc', id).auth).toBeDefined();
  });

  it.each(['missing', ''])('never treats a missing or malformed saved credential ID as public access (%s)', (credentialId) => {
    const f = setup(); const id = f.create();
    f.raw.prepare('UPDATE knowledge_code_graph SET credential_id = ? WHERE code_graph_id = ?').run(credentialId, id);
    expect(() => f.service.resolve('svc', id)).toThrow(/invalid or unavailable/);
    expect(() => f.service.replace('svc', id, { mode: 'none' }, member)).toThrow(/graph owner/);
    f.service.replace('svc', id, { mode: 'none' }, actor);
    expect(f.service.resolve('svc', id)).toEqual({ url: repo });
  });

  it('rejects busy writes and foreign callers without changing credentials', () => {
    const f = setup(); const id = f.create(resource);
    expect(() => f.service.resourceStatus('svc', id, { ...actor, teamId: 'other' })).toThrow(/not found/);
    expect(() => f.service.replace('svc', id, { mode: 'none' }, { ...actor, serviceId: 'other' })).toThrow(/not found/);
    f.store.updateCodeGraphStatus('svc', id, { status: 'processing' });
    expect(() => f.service.deleteResource('svc', id, actor)).toThrow(/busy/);
    expect(f.credentialStore.get(f.ref(id))?.secret).toBe(resource.secret);
  });

  it.each(['gongfeng', 'basic'])('converts %s credentials structurally, preserving special characters without URL builders', (providerId) => {
    const f = setup(); const provider = f.codeSourceRegistry.get(providerId)!;
    const builder = vi.spyOn(provider.authMethod, 'buildCloneUrl').mockImplementation(() => { throw new Error('URL builder must not run'); });
    const secret = 's:e@c/% ret+字'; const username = 'u+ser@example.com';
    const id = f.create({ mode: 'resource', provider_id: providerId, secret, username });
    expect(f.service.resolve('svc', id)).toEqual({ url: repo, auth: { kind: 'https', username: providerId === 'basic' ? username : 'private', token: secret } });
    expect(builder).not.toHaveBeenCalled();
  });

  it('rejects incomplete or unavailable providers and unsafe URLs before persistence', () => {
    const f = setup();
    const createParams = { ...params, credential: { provider_id: 'gongfeng', secret: 'token' } };
    expect(() => f.service.create({ ...createParams, authActor: undefined })).toThrow(/identity/);
    expect(() => f.service.create({ ...createParams, credential: { provider_id: 'basic', secret: 'token' } })).toThrow(/Invalid credentials/);
    expect(() => f.service.create({ ...createParams, credential: { provider_id: 'gongfeng', secret: '' } })).toThrow(/valid credentials/);
    expect(() => f.service.create({ ...createParams, credential: { provider_id: 'disabled', secret: 'token' } })).toThrow(/not enabled/);
    for (const repo_url of ['http://git.example.com/repo.git', 'https://user:secret@git.example.com/repo.git', 'git@git.example.com:owner/repo.git']) {
      expect(() => f.service.create({ ...createParams, repo_url })).toThrow();
    }
    expect(() => f.service.create({ ...createParams, credential_id: 'mixed' })).toThrow(/either/);
    expect(() => f.service.create({ ...params, branch: '--bad' })).toThrow(/branch/);
    expect(f.store.listCodeGraphs('svc', 'team')).toEqual([]);
    const id = f.create(resource);
    expect(() => f.service.replace('svc', id, { mode: 'saved', credential_id: 42, share_with_team: true } as unknown as CodeGraphAuthInput, actor)).toThrow(/ID/);
    expect(() => f.service.replace('svc', id, { ...resource, username: 123 } as unknown as CodeGraphAuthInput, actor)).toThrow(/valid credentials/);
    expect(f.credentialStore.get(f.ref(id))?.secret).toBe(resource.secret);
  });

  it('deletes graph and resource secret atomically while retaining reusable credentials', () => {
    const f = setup(); const id = f.create(resource); const own = f.saved();
    vi.spyOn(f.store, 'deleteCodeGraph').mockImplementationOnce(() => { throw new Error('synthetic delete failure'); });
    expect(() => f.service.cleanup('svc', id)).toThrow(/delete failure/);
    expect(f.store.getCodeGraphById('svc', id)).not.toBeNull();
    expect(f.credentialStore.get(f.ref(id))?.secret).toBe(resource.secret);
    const dir = mkdtempSync(join(tmpdir(), 'code-auth-delete-')); close.push(() => rmSync(dir, { recursive: true, force: true }));
    const graphs = new CodeGraphService({ store: f.store, authService: f.service, worker: async () => ({}), dataRoot: dir });
    expect(() => graphs.updateMeta('svc', id, { credential_id: 'unverified' })).toThrow(/CodeGraphAuthService/);
    expect(graphs.delete('svc', 'team', id)).toBe(true);
    expect(f.credentialStore.status(f.ref(id))).toBeNull();
    expect(f.store.getCodeGraphById('svc', id)).toBeNull();
    expect(f.gitCredentialStore.list('svc', 'team', 'alice').map(item => item.credential_id)).toContain(own.credential_id);
  });
});

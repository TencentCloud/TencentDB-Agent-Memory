import { hostEntry } from './git-host-fixture.js';
import { createCipheriv, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb, migrate } from '../src/db/client.js';
import { GitCredentialStore, type GitSecret } from '../src/store/git-credential-store.js';
import { SqliteKnowledgeStore } from '../src/store/sqlite-store.js';

const databases: ReturnType<typeof createDb>[] = [];
const key = 'ab'.repeat(32);
const repo = 'https://github.com/example/private.git';
const secret: GitSecret = { kind: 'https', username: 'reader', token: 'secret-never-returned' };
function setup() {
  const db = createDb({ path: ':memory:' }); databases.push(db);
  return { ...db, credentials: new GitCredentialStore(db.db, key), graphs: new SqliteKnowledgeStore(db.db) };
}
afterEach(() => databases.splice(0).forEach(({ raw }) => raw.close()));

describe('Git credential ownership and persistence', () => {
  it('accepts hostname-only input and matches hostnames across repositories and HTTPS ports', () => {
    const { credentials } = setup();
    const info = credentials.put('svc', 'team', 'alice', { name: 'CNB', hostname: 'CNB.COOL', secret });
    expect(info.hostname).toBe('cnb.cool');
    for (const target of ['https://cnb.cool/one/repo.git', 'https://CNB.COOL:8443/two/repo.git', 'https://cnb.cool./three/repo']) {
      expect(credentials.resolve('svc', 'team', 'alice', info.credential_id, target)).toEqual(secret);
    }
    for (const target of ['https://cnb.cool.evil.example/repo', 'https://other.cnb.cool/repo', 'git@cnb.cool:repo']) {
      expect(() => credentials.resolve('svc', 'team', 'alice', info.credential_id, target)).toThrow('different Git hostname');
    }
    expect(() => credentials.resolve('svc', 'team', 'alice', info.credential_id, 'http://cnb.cool/repo')).toThrow();
  });

  it('rejects URLs, ports and credentials in the hostname field and normalizes IDN hostnames', () => {
    const { credentials } = setup();
    for (const hostname of ['', 'https://cnb.cool', 'cnb.cool:443', 'cnb.cool:8443', 'cnb.cool/path', 'user@cnb.cool', 'cnb.cool?x=y', 'cnb.cool#x', '*.cnb.cool', 'cnb.cool\\repo', 'cnb.cool%2fevil', 'cnb.cool\n']) {
      expect(() => credentials.put('svc', 'team', 'alice', { name: 'invalid', hostname, secret })).toThrow();
    }
    const info = credentials.put('svc', 'team', 'alice', { name: 'IDN', hostname: '例子.测试', secret });
    expect(info.hostname).toBe('xn--fsqu00a.xn--0zwm56d');
    expect(credentials.resolve('svc', 'team', 'alice', info.credential_id, 'https://例子.测试/repo')).toEqual(secret);
  });
  it('encrypts secrets, survives restart and never includes them in metadata', () => {
    const { credentials, raw, db } = setup();
    const info = credentials.put('svc', 'team', 'alice', { name: 'Private repo', hostname: 'github.com', secret });
    expect(JSON.stringify(info)).not.toContain(secret.token);
    expect(JSON.stringify(credentials.list('svc', 'team', 'alice'))).not.toContain(secret.token);
    const persisted = raw.prepare('SELECT * FROM git_credential').get() as Record<string, unknown>;
    expect(JSON.stringify(persisted)).not.toContain(secret.token);
    expect(new GitCredentialStore(db, key).resolve('svc', 'team', 'alice', info.credential_id, repo)).toEqual(secret);
    expect(() => new GitCredentialStore(db, 'cd'.repeat(32)).resolve('svc', 'team', 'alice', info.credential_id, repo)).toThrow('Cannot decrypt');
  });

  it('enforces service, team, owner and Git server isolation', () => {
    const { credentials } = setup();
    const { credential_id: id } = credentials.put('svc', 'team', 'alice', { name: 'Private repo', hostname: 'github.com', secret });
    for (const scope of [['other', 'team', 'alice'], ['svc', 'other', 'alice'], ['svc', 'team', 'bob']]) {
      const [s, t, u] = scope;
      expect(credentials.list(s, t, u)).toEqual([]);
      expect(() => credentials.resolve(s, t, u, id, repo)).toThrow('not found');
      expect(() => credentials.delete(s, t, u, id)).toThrow('not found');
      expect(() => credentials.put(s, t, u, { credential_id: id, name: 'hijack', hostname: 'github.com', secret })).toThrow('not found');
    }
    expect(credentials.resolve('svc', 'team', 'alice', id, 'https://github.com/example/another.git')).toEqual(secret);
    expect(credentials.resolve('svc', 'team', 'alice', id, 'https://github.com:8443/example/another.git')).toEqual(secret);
    expect(() => credentials.resolve('svc', 'team', 'alice', id, 'git@github.com:example/another.git')).toThrow('different Git hostname');
    expect(() => credentials.resolve('svc', 'team', 'alice', id, 'https://evil.example/private.git')).toThrow('different Git hostname');
  });

  it('rotates in place, blocks deletion while bound and allows it after unbinding', () => {
    const { credentials, graphs } = setup();
    const info = credentials.put('svc', 'team', 'alice', { name: 'repo', hostname: 'github.com', secret });
    const { row } = graphs.createCodeGraph({ service_id: 'svc', team_id: 'team', owner_user_id: 'alice', repo_url: repo, branch: 'main', credential_id: info.credential_id });
    const { row: second } = graphs.createCodeGraph({ service_id: 'svc', team_id: 'team', owner_user_id: 'alice', repo_url: 'https://github.com/example/another.git', branch: 'main', credential_id: info.credential_id });
    const rotated = { ...secret, token: 'rotated-token' };
    credentials.put('svc', 'team', 'alice', { ...info, secret: rotated });
    expect(credentials.resolve('svc', 'team', 'alice', info.credential_id, repo)).toEqual(rotated);
    expect(() => credentials.delete('svc', 'team', 'alice', info.credential_id)).toThrow('in use');
    graphs.updateCodeGraphMeta('svc', row.code_graph_id, { credential_id: null });
    expect(() => credentials.delete('svc', 'team', 'alice', info.credential_id)).toThrow('in use');
    graphs.updateCodeGraphMeta('svc', second.code_graph_id, { credential_id: null });
    credentials.delete('svc', 'team', 'alice', info.credential_id);
    expect(credentials.list('svc', 'team', 'alice')).toEqual([]);
  });

  it('does not allow moving a bound credential to a different Git server', () => {
    const { credentials } = setup();
    const info = credentials.put('svc', 'team', 'alice', { name: 'repo', hostname: 'github.com', secret });
    expect(() => credentials.put('svc', 'team', 'alice', { ...info, hostname: 'other.example', secret })).toThrow('cannot change');
  });

  it('fails closed without an encryption key and rejects URL credentials and malformed secrets', () => {
    const { db, credentials } = setup();
    expect(() => new GitCredentialStore(db, '').put('svc', 'team', 'alice', { name: 'repo', hostname: 'github.com', secret })).toThrow('KNOWLEDGE_GIT_CREDENTIAL_KEY');
    expect(() => credentials.put('svc', 'team', 'alice', { name: 'repo', hostname: 'https://user:password@github.com/owner/repo.git', secret })).toThrow('Enter a hostname');
    expect(() => credentials.put('svc', 'team', 'alice', { name: 'repo', hostname: 'github.com', secret: { ...secret, token: 'header\ninjection' } })).toThrow('username and token');
  });

  it('preserves legacy ciphertext and bindings while exposing a reusable server scope', () => {
    const { credentials, raw, db, graphs } = setup();
    const info = credentials.put('svc', 'team', 'alice', { name: 'Legacy', hostname: 'github.com', secret });
    const { row: graph } = graphs.createCodeGraph({ service_id: 'svc', team_id: 'team', owner_user_id: 'alice', repo_url: repo, branch: 'main', credential_id: info.credential_id });
    // Reproduce the original repository-scoped encryption format exactly.
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
    cipher.setAAD(Buffer.from(JSON.stringify(['svc', 'team', 'alice', info.credential_id, repo])));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(secret)), cipher.final()]);
    const ciphertext = [iv, cipher.getAuthTag(), encrypted].map(b => b.toString('base64')).join('.');
    raw.prepare('UPDATE git_credential SET repo_url = ?, encrypted_secret = ?').run(repo, ciphertext);
    migrate(db, raw); migrate(db, raw);
    const restarted = new GitCredentialStore(db, key);
    expect(restarted.list('svc', 'team', 'alice')[0]).not.toHaveProperty('server_url');
    expect(restarted.list('svc', 'team', 'alice')[0].hostname).toBe('github.com');
    expect(restarted.resolve('svc', 'team', 'alice', info.credential_id, 'https://github.com/another/repo.git')).toEqual(secret);
    expect(graphs.getCodeGraphById('svc', graph.code_graph_id)?.credential_id).toBe(info.credential_id);
    expect(raw.prepare('SELECT encrypted_secret FROM git_credential').get()).toEqual({ encrypted_secret: ciphertext });
    restarted.put('svc', 'team', 'alice', { ...info, secret: { ...secret, token: 'rotated' } });
    expect(restarted.resolve('svc', 'team', 'alice', info.credential_id, repo).token).toBe('rotated');
  });

  it('keeps legacy server-origin ciphertext readable while matching only its hostname', () => {
    const { credentials, raw, db } = setup();
    const info = credentials.put('svc', 'team', 'alice', { name: 'Legacy origin', hostname: 'github.com', secret });
    const origin = 'https://github.com:8443';
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
    cipher.setAAD(Buffer.from(JSON.stringify(['svc', 'team', 'alice', info.credential_id, origin])));
    const data = Buffer.concat([cipher.update(JSON.stringify(secret)), cipher.final()]);
    const ciphertext = [iv, cipher.getAuthTag(), data].map(part => part.toString('base64')).join('.');
    raw.prepare('UPDATE git_credential SET repo_url = ?, encrypted_secret = ? WHERE credential_id = ?').run(origin, ciphertext, info.credential_id);
    const restarted = new GitCredentialStore(db, key);
    expect(restarted.list('svc', 'team', 'alice')[0].hostname).toBe('github.com');
    expect(restarted.resolve('svc', 'team', 'alice', info.credential_id, repo)).toEqual(secret);
    expect(raw.prepare('SELECT encrypted_secret FROM git_credential').get()).toEqual({ encrypted_secret: ciphertext });
    restarted.put('svc', 'team', 'alice', { credential_id: info.credential_id, name: info.name, hostname: 'github.com', secret: { ...secret, token: 'rotated' } });
    expect(restarted.resolve('svc', 'team', 'alice', info.credential_id, 'https://github.com:9443/other/repo')).toHaveProperty('token', 'rotated');
  });

  it('saves SSH identities without a server and manages trust separately', () => {
    const { credentials } = setup();
    const ssh = { kind: 'ssh' as const, private_key: '-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic' };
    const info = credentials.put('svc', 'team', 'alice', { name: 'SSH account', secret: ssh });
    expect(info.hostname).toBeNull();
    expect(info).not.toHaveProperty('server_url');
    credentials.trustHost('svc', 'team', 'alice', info.credential_id, 'git@git.example:one/repo.git', hostEntry('git.example'), null);
    for (const target of ['git@git.example:one/repo.git', 'ssh://git@git.example:22/two/repo.git']) {
      expect(credentials.resolve('svc', 'team', 'alice', info.credential_id, target)).toEqual({ ...ssh, known_hosts: hostEntry('git.example') });
    }
    expect(credentials.resolve('svc', 'team', 'alice', info.credential_id, 'ssh://git@git.example:2222/two/repo.git')).toEqual(ssh);
    expect(() => credentials.put('svc', 'team', 'alice', { name: 'bad', secret: { ...ssh, known_hosts: hostEntry('git.example') } })).toThrow('separately');
  });

  it('rejects URL parser ambiguity before releasing a hostname-scoped token', () => {
    const { credentials } = setup();
    const info = credentials.put('svc', 'team', 'alice', { name: 'private', hostname: 'github.com', secret });
    expect(() => credentials.resolve('svc', 'team', 'alice', info.credential_id, String.raw`https://github.com\@other.example/repo.git`)).toThrow('Invalid Git repository URL');
  });

  it('migrates old CodeGraph rows without changing public repository behavior', () => {
    const { db, raw, graphs } = setup();
    const { row } = graphs.createCodeGraph({ service_id: 'svc', team_id: 'team', repo_url: repo, branch: 'main' });
    raw.exec('ALTER TABLE knowledge_code_graph DROP COLUMN credential_id');
    migrate(db, raw); migrate(db, raw);
    expect(graphs.getCodeGraphById('svc', row.code_graph_id)?.credential_id).toBeNull();
  });
});

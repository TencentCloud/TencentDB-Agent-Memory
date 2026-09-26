import { afterEach, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client.js';
import { GitCredentialStore } from '../src/store/git-credential-store.js';
import { createGitCredentialRoutes } from '../src/routes/git-credential.js';
import { GitSourceFetcher } from '../src/source-fetcher/git-fetcher.js';
import { hostEntry } from './git-host-fixture.js';
import { createCipheriv, randomBytes } from 'node:crypto';

const databases: ReturnType<typeof createDb>[] = [];
afterEach(() => { vi.restoreAllMocks(); databases.splice(0).forEach(x => x.raw.close()); });
const key = 'ab'.repeat(32);
const ssh = { kind: 'ssh' as const, private_key: '-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic' };
function setup() {
  const db = createDb({ path: ':memory:' }); databases.push(db);
  const store = new GitCredentialStore(db.db, key);
  const info = store.put('svc', 'team', 'alice', { name: 'Multi-server SSH key', secret: ssh });
  const app = createGitCredentialRoutes(store, 'test-key');
  const request = (action: string, body: object) => app.request('/' + action, { method: 'POST', headers: {
    'content-type': 'application/json', authorization: 'Bearer test-key', 'x-tdai-service-id': 'svc',
  }, body: JSON.stringify({ team_id: 'team', user_id: 'alice', credential_id: info.credential_id, ...body }) });
  return { db: db.db, raw: db.raw, store, info, request };
}

it('reuses an SSH identity across servers but isolates persistent trust by host, port and owner', () => {
  const { db, store, info } = setup();
  expect(info.hostname).toBeNull();
  const first = 'git@one.example:org/repo.git';
  const second = 'ssh://git@two.example:2222/other/repo.git';
  for (const url of [first, second]) expect(store.resolve('svc', 'team', 'alice', info.credential_id, url)).toEqual(ssh);
  store.trustHost('svc', 'team', 'alice', info.credential_id, first, hostEntry('one.example'), null);
  const restarted = new GitCredentialStore(db, key);
  expect(restarted.resolve('svc', 'team', 'alice', info.credential_id, first)).toEqual({ ...ssh, known_hosts: hostEntry('one.example') });
  expect(restarted.resolve('svc', 'team', 'alice', info.credential_id, second)).toEqual(ssh);
  store.trustHost('svc', 'team', 'alice', info.credential_id, second, hostEntry('[two.example]:2222'), null);
  expect(restarted.resolve('svc', 'team', 'alice', info.credential_id, second)).toHaveProperty('known_hosts', hostEntry('[two.example]:2222'));
  expect(restarted.resolve('svc', 'team', 'alice', info.credential_id, 'git@two.example:repo.git')).not.toHaveProperty('known_hosts');
  for (const [s, t, u] of [['svc', 'team', 'bob'], ['svc', 'other', 'alice'], ['other', 'team', 'alice']]) {
    const other = store.put(s, t, u, { name: 'Other owner', secret: ssh });
    expect(store.resolve(s, t, u, other.credential_id, first)).not.toHaveProperty('known_hosts');
    expect(() => store.trustHost(s, t, u, info.credential_id, first, hostEntry('one.example'), null)).toThrow('not found');
  }
  expect(() => store.resolve('svc', 'team', 'alice', info.credential_id, 'https://one.example/repo.git')).toThrow('different Git hostname');
});

it('rejects stale confirmations and retains trust through private key rotation', () => {
  const { store, info } = setup();
  const target = 'git@git.example:repo.git';
  const first = hostEntry('git.example'); const replacement = hostEntry('git.example', 2);
  expect(() => store.trustHost('svc', 'team', 'alice', info.credential_id, target, hostEntry('evil.example'), null)).toThrow('exact host');
  store.trustHost('svc', 'team', 'alice', info.credential_id, target, first, null);
  expect(() => store.trustHost('svc', 'team', 'alice', info.credential_id, target, replacement, null)).toThrow('trust changed');
  expect(store.resolve('svc', 'team', 'alice', info.credential_id, target)).toHaveProperty('known_hosts', first);
  store.trustHost('svc', 'team', 'alice', info.credential_id, target, replacement, first);
  store.put('svc', 'team', 'alice', { ...info, secret: { ...ssh, private_key: ssh.private_key + '-rotated' } });
  expect(store.resolve('svc', 'team', 'alice', info.credential_id, target)).toHaveProperty('known_hosts', replacement);
});

it('preserves legacy SSH ciphertext and verified hosts when rotating to the simplified form', () => {
  const { store, info, raw, db } = setup();
  const repo = 'git@legacy.example:org/repo.git';
  const previous = { ...ssh, known_hosts: hostEntry('legacy.example') };
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  cipher.setAAD(Buffer.from(JSON.stringify(['svc', 'team', 'alice', info.credential_id, repo])));
  const data = Buffer.concat([cipher.update(JSON.stringify(previous)), cipher.final()]);
  const ciphertext = [iv, cipher.getAuthTag(), data].map(part => part.toString('base64')).join('.');
  raw.prepare('UPDATE git_credential SET repo_url = ?, encrypted_secret = ? WHERE credential_id = ?').run(repo, ciphertext, info.credential_id);
  const restarted = new GitCredentialStore(db, key);
  expect(restarted.list('svc', 'team', 'alice')[0].hostname).toBeNull();
  expect(restarted.resolve('svc', 'team', 'alice', info.credential_id, repo)).toEqual(previous);
  expect(restarted.resolve('svc', 'team', 'alice', info.credential_id, 'git@another.example:repo.git')).toEqual(ssh);
  store.put('svc', 'team', 'alice', { ...info, secret: { ...ssh, private_key: ssh.private_key + '-rotated' } });
  expect(restarted.resolve('svc', 'team', 'alice', info.credential_id, repo)).toHaveProperty('known_hosts', previous.known_hosts);
});

it('discovers public fingerprints without trust or authentication until explicitly confirmed', async () => {
  const { request, store, info } = setup();
  const repo_url = 'git@git.example:org/repo.git';
  const keys = hostEntry('git.example');
  const scan = vi.spyOn(GitSourceFetcher.prototype, 'hostKeys').mockResolvedValue(keys);
  const test = vi.spyOn(GitSourceFetcher.prototype, 'test').mockResolvedValue(undefined);
  expect((await request('host-key', { repo_url, user_id: 'bob' })).status).toBe(404);
  expect(scan).not.toHaveBeenCalled();
  const discovered = (await (await request('host-key', { repo_url })).json()).data;
  expect(discovered).toMatchObject({ trusted: false, previous_known_hosts: null, known_hosts: keys });
  expect(discovered.fingerprints[0]).toMatch(/^ssh-ed25519 SHA256:/);
  expect(JSON.stringify(discovered)).not.toContain('PRIVATE KEY');
  expect((await request('test', { repo_url })).status).toBe(409);
  expect(test).not.toHaveBeenCalled();
  expect((await request('trust-host', { repo_url, known_hosts: keys, previous_known_hosts: null })).status).toBe(200);
  expect((await (await request('host-key', { repo_url })).json()).data.trusted).toBe(true);
  expect(scan).toHaveBeenCalledTimes(1);
  expect((await request('test', { repo_url })).status).toBe(200);
  scan.mockResolvedValue(hostEntry('git.example', 2));
  const changed = (await (await request('host-key', { repo_url, refresh: true })).json()).data;
  expect(changed.trusted).toBe(false);
  expect(changed.previous_known_hosts).toBe(keys);
  expect(store.resolve('svc', 'team', 'alice', info.credential_id, repo_url)).toHaveProperty('known_hosts', keys);
  expect((await request('trust-host', { repo_url, known_hosts: changed.known_hosts, previous_known_hosts: null })).status).toBe(409);
});

it('applies private-network checks before attempting host discovery', async () => {
  const fetcher = new GitSourceFetcher();
  await expect(fetcher.hostKeys('git@127.0.0.1:repo.git')).rejects.toThrow('private/loopback');
  await expect(fetcher.hostKeys('https://git.example/repo.git')).rejects.toThrow('SSH repository');
});

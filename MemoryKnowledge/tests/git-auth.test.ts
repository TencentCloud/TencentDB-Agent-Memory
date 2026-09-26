import { hostEntry } from './git-host-fixture.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseGitSource, validateGitBranch } from '../src/source-fetcher/git-source.js';
import { validateGitSecret } from '../src/store/git-credential-store.js';
import { withGitAuth } from '../src/source-fetcher/git-auth.js';

const fake = vi.hoisted(() => ({ env: {} as Record<string, string>, options: {} as any }));
vi.mock('simple-git', () => ({ default: (options: unknown) => {
  fake.options = options;
  return { env(env: Record<string, string>) { fake.env = env; return this; } };
} }));
afterEach(() => vi.unstubAllEnvs());

describe('Git transport secret handling', () => {
  it('never starts SSH authentication before server trust is available', async () => {
    const run = vi.fn();
    await expect(withGitAuth(undefined, { kind: 'ssh', private_key: 'synthetic' }, run)).rejects.toThrow('not trusted');
    expect(run).not.toHaveBeenCalled();
  });
  it('isolates HTTPS secrets and removes its temporary directory on failure', async () => {
    vi.stubEnv('GIT_TRACE', '1'); vi.stubEnv('GIT_CONFIG_COUNT', '4'); vi.stubEnv('SSH_AUTH_SOCK', '/agent');
    const token = 'do-not-leak-token';
    await expect(withGitAuth(undefined, { kind: 'https', username: 'reader', token }, async () => {
      expect(fake.env.GIT_TRACE).toBeUndefined();
      expect(fake.env.GIT_CONFIG_COUNT).toBeUndefined();
      expect(fake.env.SSH_AUTH_SOCK).toBeUndefined();
      expect(fake.env.MEMORY_GIT_TOKEN).toBe(token);
      expect(fake.options.config).toContain('http.followRedirects=false');
      expect(JSON.stringify(fake.options)).not.toContain(token);
      expect(await readFile(fake.env.GIT_ASKPASS, 'utf8')).not.toContain(token);
      // Git copies template files into .git, so this directory MUST stay empty.
      expect(await readdir(fake.env.GIT_TEMPLATE_DIR)).toEqual([]);
      throw new Error(`Authentication failed: ${token}`);
    })).rejects.toThrow('Git authentication failed');
    await expect(access(fake.env.HOME)).rejects.toThrow();
  });

  it('uses strict SSH host verification, private file modes and no ssh-agent', async () => {
    const secret = { kind: 'ssh' as const, private_key: 'PRIVATE_KEY_SENTINEL', known_hosts: hostEntry('github.com') };
    await withGitAuth(undefined, secret, async () => {
      expect(fake.env.SSH_AUTH_SOCK).toBeUndefined();
      expect(await readFile(join(fake.env.HOME, 'identity'), 'utf8')).toBe(secret.private_key + '\n');
      expect((await stat(join(fake.env.HOME, 'identity'))).mode & 0o777).toBe(0o600);
      const script = await readFile(fake.env.GIT_SSH, 'utf8');
      expect(script).toContain('StrictHostKeyChecking=yes');
      expect(script).toContain('IdentityAgent=none');
      expect(script).not.toContain(secret.private_key);
      expect(await readdir(fake.env.GIT_TEMPLATE_DIR)).toEqual([]);
    });
    await expect(access(fake.env.HOME)).rejects.toThrow();
  });

  it('public repositories cannot inherit service-account credentials', async () => {
    vi.stubEnv('GIT_ASKPASS', '/global/secret');
    await withGitAuth(undefined, undefined, async () => {
      expect(fake.env.GIT_ASKPASS).toBeUndefined();
      expect(fake.env.GIT_ALLOW_PROTOCOL).toBe('https');
      expect(fake.options.config).toContain('credential.helper=');
      expect(fake.options.config).toContain('http.followRedirects=initial');
    });
  });
});

describe('Git inputs', () => {
  it.each(['file:///etc/passwd', '/local/repo', 'http://host/repo.git', 'https://u:t@host/repo.git', 'https://host/repo.git?token=secret', 'ssh://git:password@host/repo.git', 'ssh://-proxy@host/repo.git', 'https://host/a\nb', String.raw`https://github.com\@other.example/repo.git`, 'ssh://git@host', 'ssh://git@host:2222'])('rejects unsafe URL %s', (url) => {
    expect(() => parseGitSource(url)).toThrow();
  });
  it('supports HTTPS, scp and SSH with a custom port', () => {
    expect(parseGitSource('git@github.com:owner/repo.git').kind).toBe('ssh');
    expect(parseGitSource('ssh://git@git.example:2222/owner/repo.git').knownHost).toBe('[git.example]:2222');
    expect(parseGitSource('https://github.com/owner/repo.git').kind).toBe('https');
  });
  it.each(['--upload-pack=evil', 'a..b', 'a b', 'x\ny', '../main', 'x.lock', 'a//b'])('rejects unsafe branch %s', (branch) => expect(() => validateGitBranch(branch)).toThrow());
  it('accepts a feature branch', () => expect(() => validateGitBranch('minti/feat/support-private-git')).not.toThrow());
  it('allows saving just an SSH identity and rejects invalid or wildcard host entries', () => {
    expect(() => validateGitSecret({ kind: 'ssh', private_key: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc' })).not.toThrow();
    for (const known_hosts of ['', '*.example ssh-ed25519 AAAA', 'other.example ssh-ed25519 AAAA']) {
      expect(() => validateGitSecret({ kind: 'ssh', private_key: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc', known_hosts })).toThrow('known_hosts');
    }
  });
});

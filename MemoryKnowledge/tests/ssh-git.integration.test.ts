import { hostEntry } from './git-host-fixture.js';
/** Real Git over a deterministic SSH transport double. This checks that Git
 * executes the generated SSH wrapper and passes isolated key/host files; host
 * trust itself is enforced by the OpenSSH options verified in git-auth.test.ts.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitSourceFetcher } from '../src/source-fetcher/git-fetcher.js';

const exec = promisify(execFile);
afterEach(() => vi.unstubAllEnvs());

it('clones over SSH using only the selected identity and verified-host file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'private-git-ssh-'));
  try {
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    const seed = join(root, 'seed'); const bin = join(root, 'bin');
    await mkdir(seed); await mkdir(bin);
    await exec('git', ['init', '-b', 'main'], { cwd: seed });
    await writeFile(join(seed, 'code.ts'), 'export const privateCode = true;\n');
    await exec('git', ['add', '.'], { cwd: seed });
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'seed'], { cwd: seed });
    await exec('git', ['clone', '--bare', seed, join(root, 'repo.git')]);
    // The stub only accepts the wrapper's strict options and expected test identity.
    // It proxies upload-pack over stdin/stdout, like an SSH channel would.
    const script = `#!${process.execPath}
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const identity = args[args.indexOf('-i') + 1];
const knownHosts = args.find(x => x.startsWith('UserKnownHostsFile='))?.split('=').slice(1).join('=');
if (!args.includes('StrictHostKeyChecking=yes') || !args.includes('IdentityAgent=none') || !args.includes('IdentitiesOnly=yes') || process.env.SSH_AUTH_SOCK) process.exit(2);
if (!identity || !knownHosts || !fs.readFileSync(identity, 'utf8').includes('synthetic-key') || !fs.readFileSync(knownHosts, 'utf8').includes(${JSON.stringify(hostEntry('test.example'))})) process.exit(3);
fs.writeFileSync(${JSON.stringify(join(root, 'observed.json'))}, JSON.stringify({ identity, knownHosts, args }));
const child = spawn('git', ['upload-pack', ${JSON.stringify(join(root, 'repo.git'))}], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code || 0));
`;
    await writeFile(join(bin, 'ssh'), script, { mode: 0o700 });
    vi.stubEnv('PATH', bin + ':' + process.env.PATH);
    vi.stubEnv('SSH_AUTH_SOCK', '/must-not-inherit');
    const fetcher = new GitSourceFetcher({ ssrfCheck: false });
    const secret = { kind: 'ssh' as const, private_key: '-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic-key\n-----END OPENSSH PRIVATE KEY-----', known_hosts: hostEntry('test.example') };
    const checkout = join(root, 'checkout');
    await fetcher.fetch('git@test.example:owner/repo.git', 'main', checkout, secret);
    expect(await readFile(join(checkout, 'code.ts'), 'utf8')).toContain('privateCode');
    const observed = JSON.parse(await readFile(join(root, 'observed.json'), 'utf8'));
    expect(JSON.stringify(observed.args)).not.toContain('synthetic-key');
    await expect(readFile(observed.identity)).rejects.toThrow();
    await expect(readFile(observed.knownHosts)).rejects.toThrow();
    await expect(readFile(join(checkout, '.git/identity'))).rejects.toThrow();
    expect(await readFile(join(checkout, '.git/config'), 'utf8')).not.toContain('synthetic-key');
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15_000);

/** Real Git smart-HTTP against a local HTTPS server requiring Basic auth.
 * No external account, network host or personal credential is used.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:https';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitSourceFetcher } from '../src/source-fetcher/git-fetcher.js';

const exec = promisify(execFile);
let root: string;
let server: Server;
let url: string;
let token = 'first-token';
const requests: { path: string; authenticated: boolean }[] = [];
const fetcher = new GitSourceFetcher({ ssrfCheck: false });
const secret = () => ({ kind: 'https' as const, username: 'reader', token });
const git = (cwd: string, args: string[]) => exec('git', args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'private-git-integration-'));
  const seed = join(root, 'seed'); await mkdir(seed);
  await git(seed, ['init', '-b', 'main']);
  await writeFile(join(seed, 'hello.ts'), 'export const hello = 1;\n');
  await git(seed, ['add', '.']);
  await git(seed, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']);
  await git(root, ['clone', '--bare', seed, join(root, 'repo.git')]);
  await writeFile(join(root, 'cert.cnf'), '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n');
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'server.key'), '-out', join(root, 'server.crt'), '-days', '1', '-config', join(root, 'cert.cnf')]);
  vi.stubEnv('GIT_SSL_CAINFO', join(root, 'server.crt'));
  server = createServer({ key: await readFile(join(root, 'server.key')), cert: await readFile(join(root, 'server.crt')) }, (req, res) => {
    const requestUrl = new URL(req.url!, 'https://localhost');
    requests.push({ path: requestUrl.pathname, authenticated: !!req.headers.authorization });
    if (requestUrl.pathname.startsWith('/public-moved.git/')) {
      res.writeHead(301, { location: req.url!.replace('/public-moved.git/', '/public.git/') }); res.end(); return;
    }
    if (!requestUrl.pathname.startsWith('/public.git/') && req.headers.authorization !== 'Basic ' + Buffer.from('reader:' + token).toString('base64')) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="private-git"' }); res.end(); return;
    }
    if (requestUrl.pathname.startsWith('/private-moved.git/')) {
      res.writeHead(301, { location: req.url!.replace('/private-moved.git/', '/public.git/') }); res.end(); return;
    }
    const child = spawn('git', ['http-backend'], { env: {
      ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', REMOTE_USER: 'reader',
      REQUEST_METHOD: req.method, PATH_INFO: requestUrl.pathname.replace('/public.git/', '/repo.git/'),
      QUERY_STRING: requestUrl.search.slice(1), CONTENT_TYPE: req.headers['content-type'] ?? '',
      ...(req.headers['content-length'] ? { CONTENT_LENGTH: req.headers['content-length'] } : {}),
    } });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.resume(); req.pipe(child.stdin);
    child.on('close', () => {
      const response = Buffer.concat(chunks);
      const end = response.indexOf('\r\n\r\n');
      if (end < 0) { res.writeHead(500); res.end(); return; }
      let status = 200; const headers: Record<string, string> = {};
      for (const line of response.subarray(0, end).toString().split('\r\n')) {
        const colon = line.indexOf(':'); const name = line.slice(0, colon).toLowerCase(); const value = line.slice(colon + 1).trim();
        if (name === 'status') status = Number(value.split(' ')[0]); else headers[name] = value;
      }
      res.writeHead(status, headers); res.end(response.subarray(end + 4));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address() as { port: number };
  url = `https://127.0.0.1:${address.port}/repo.git`;
}, 30_000);

it('clones and syncs a redirected public repository without sending credentials', async () => {
  const start = requests.length;
  const redirected = url.replace('/repo.git', '/public-moved.git');
  const checkout = join(root, 'public-checkout');
  await fetcher.fetch(redirected, 'main', checkout);
  await fetcher.sync(redirected, 'main', checkout);
  expect(await readFile(join(checkout, 'hello.ts'), 'utf8')).toContain('export const hello');
  expect(requests.slice(start).some(r => r.path.startsWith('/public.git/'))).toBe(true);
  expect(requests.slice(start).every(r => !r.authenticated)).toBe(true);
}, 30_000);

it('does not forward a selected token through an authenticated redirect', async () => {
  const start = requests.length;
  await expect(fetcher.test(url.replace('/repo.git', '/private-moved.git'), secret())).rejects.toThrow('Git operation failed');
  expect(requests.slice(start).some(r => r.authenticated)).toBe(true);
  expect(requests.slice(start).some(r => r.path.startsWith('/public.git/'))).toBe(false);
});

it('rejects backslash authority confusion before connecting', async () => {
  const start = requests.length;
  const target = new URL(url);
  const crafted = `https://trusted.example\\@${target.host}/repo.git`;
  await expect(fetcher.test(crafted, secret())).rejects.toThrow('Invalid Git repository URL');
  expect(requests).toHaveLength(start);
});

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

it('tests access, clones privately, rotates credentials and syncs without persisting secrets', async () => {
  await expect(fetcher.test(url, { ...secret(), token: 'wrong' })).rejects.toThrow('authentication');
  await fetcher.test(url, secret());
  const checkout = join(root, 'checkout');
  const first = await fetcher.fetch(url, 'main', checkout, secret());
  expect(await readFile(join(checkout, 'hello.ts'), 'utf8')).toContain('hello = 1');
  const config = await readFile(join(checkout, '.git/config'), 'utf8');
  expect(config).not.toContain(token);
  expect(config).not.toContain('reader');
  await expect(readFile(join(checkout, '.git/askpass'))).rejects.toThrow();
  token = 'rotated-token';
  const seed = join(root, 'seed');
  await writeFile(join(seed, 'hello.ts'), 'export const hello = 2;\n');
  await git(seed, ['add', '.']);
  await git(seed, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'update']);
  await git(seed, ['push', join(root, 'repo.git'), 'main']);
  await mkdir(join(checkout, '.codegraph')); await writeFile(join(checkout, '.codegraph/index-marker'), 'keep');
  await expect(fetcher.sync(url, 'main', checkout, { ...secret(), token: 'first-token' })).rejects.toThrow('authentication');
  expect(await readFile(join(checkout, '.codegraph/index-marker'), 'utf8')).toBe('keep');
  expect(await readFile(join(checkout, 'hello.ts'), 'utf8')).toContain('hello = 1');
  const second = await fetcher.sync(url, 'main', checkout, secret());
  expect(second.version).not.toBe(first.version);
  expect(await readFile(join(checkout, 'hello.ts'), 'utf8')).toContain('hello = 2');
  expect(await readFile(join(checkout, '.codegraph/index-marker'), 'utf8')).toBe('keep');
  expect(await readFile(join(checkout, '.git/config'), 'utf8')).not.toContain(token);
}, 30_000);

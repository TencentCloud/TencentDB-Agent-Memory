/** Synthetic native OKF smoke test. Requires a running Knowledge service. */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const key = process.env.KNOWLEDGE_SERVICE_KEY;
if (!key) throw new Error('Set KNOWLEDGE_SERVICE_KEY in the environment');
const base = new URL((process.env.KNOWLEDGE_API_URL || 'http://127.0.0.1:8421/v3').replace(/\/+$/, '') + '/');
if (base.username || base.password || base.search || base.hash ||
    !(base.protocol === 'https:' || (base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)))) {
  throw new Error('Use an HTTPS service URL or a local loopback HTTP service');
}
const service = process.env.KNOWLEDGE_SERVICE_ID || 'okf-example-service';
const team = 'okf-example-team';
let wiki;
async function post(path, body, expected = 200) {
  const response = await fetch(new URL(path, base), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${key}`, 'x-tdai-service-id': service, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.status !== expected) throw new Error(`Example request ${path} returned HTTP ${response.status}`);
  const envelope = await response.json();
  if (envelope.code !== 0) throw new Error(`Example request ${path} returned an API error`);
  return envelope.data;
}
function bytes(file) {
  if (!['utf-8', 'base64', undefined].includes(file.encoding)) throw new Error('Unexpected bundle encoding');
  return Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
}
const work = await mkdtemp(join(tmpdir(), 'okf-http-example-'));
try {
  const bundlePath = join(work, 'bundle.json');
  // The CLI needs no service credentials. Do not pass them to its child process.
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/okf.ts', 'export', 'examples/okf', bundlePath],
    { cwd: root, env: { PATH: process.env.PATH || '/usr/bin:/bin' }, stdio: 'pipe' });
  const bundle = JSON.parse(await readFile(bundlePath, 'utf8'));
  const created = await post('wiki/create', { team_id: team, name: `OKF synthetic example ${randomUUID()}` }, 201);
  wiki = created.wiki_id;
  if (typeof wiki !== 'string' || !/^wiki-[a-z0-9]{8}$/.test(wiki)) throw new Error('Unexpected created wiki ID');
  await post('wiki/okf/validate', bundle);
  await post('wiki/okf/import', { team_id: team, wiki_id: wiki, files: bundle.files });
  const exported = await post('wiki/okf/export', { team_id: team, wiki_id: wiki });
  const expected = new Map(bundle.files.map(file => [file.path, bytes(file)]));
  if (exported.files.length !== expected.size) throw new Error('Round-trip file count mismatch');
  for (const file of exported.files) {
    if (!expected.get(file.path)?.equals(bytes(file))) throw new Error('Round-trip bytes mismatch');
    expected.delete(file.path);
  }
  if (expected.size) throw new Error('Round-trip files missing');
  const deleted = await post('wiki/delete', { wiki_ids: [wiki] });
  if (!deleted.deleted_ids?.includes(wiki)) throw new Error('Synthetic wiki cleanup failed');
  wiki = undefined;
  console.log('OKF native HTTP round-trip passed; synthetic wiki deleted.');
} catch (error) {
  if (wiki) console.error(`Synthetic wiki retained for inspection: ${wiki}`);
  throw error;
} finally {
  await rm(work, { recursive: true, force: true });
}

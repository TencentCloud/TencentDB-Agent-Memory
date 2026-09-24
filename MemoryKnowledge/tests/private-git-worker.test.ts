import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDb } from '../src/db/client.js';
import { createKnowledgeModule } from '../src/module.js';
import { GitTransportError } from '../src/source-fetcher/git-auth.js';

const transport = vi.hoisted(() => ({ fetch: vi.fn(), sync: vi.fn() }));
vi.mock('../src/source-fetcher/registry.js', () => ({ SourceFetcherRegistry: class { resolve() { return transport; } } }));
vi.mock('../src/engines/code/index.js', () => ({
  indexProject: vi.fn(async () => ({})), openIndex: vi.fn(async () => ({})), syncIndex: vi.fn(async () => undefined),
  getStats: () => ({ files: 1, nodes: 1, edges: 0 }), closeIndex: vi.fn(),
}));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it('resolves current credentials at execution time and preserves an existing index on auth failure', async () => {
  vi.stubEnv('KNOWLEDGE_GIT_CREDENTIAL_KEY', 'ab'.repeat(32));
  vi.stubEnv('KNOWLEDGE_AUTO_SYNC_ENABLED', 'false');
  const dir = await mkdtemp(join(tmpdir(), 'git-worker-test-'));
  const { db, raw } = createDb({ path: ':memory:' });
  const module = createKnowledgeModule({ db, dataDir: dir, llmConfig: { mode: 'custom', protocol: 'openai', provider: 'custom', apiKey: '', model: '', baseUrl: '', maxTokens: 100, timeoutMs: 100 } });
  try {
    const repo = 'https://github.com/owner/repo.git';
    const info = module.gitCredentialStore.put('svc', 'team', 'alice', { name: 'repo', hostname: 'github.com', secret: { kind: 'https', username: 'reader', token: 'first' } });
    transport.fetch.mockImplementation(async (_url, _branch, path) => {
      await mkdir(join(path, '.git'), { recursive: true });
      await writeFile(join(path, 'existing-index'), 'preserve');
      return { version: 'commit-one' };
    });
    const { row } = module.cgService.create({ service_id: 'svc', team_id: 'team', owner_user_id: 'alice', repo_url: repo, branch: 'main', credential_id: info.credential_id });
    await module.cgService.onIdle();
    expect(module.cgService.getById('svc', row.code_graph_id)?.status).toBe('ready');
    module.gitCredentialStore.put('svc', 'team', 'alice', { ...info, secret: { kind: 'https', username: 'reader', token: 'rotated' } });
    transport.sync.mockRejectedValue(new GitTransportError('Git authentication failed'));
    module.cgService.sync('svc', 'team', row.code_graph_id);
    await module.cgService.onIdle();
    expect(transport.sync.mock.calls[0][3]).toMatchObject({ token: 'rotated' });
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(await readFile(join(module.cgService.dirFor('svc', 'team', row.code_graph_id), 'existing-index'), 'utf8')).toBe('preserve');
    expect(module.cgService.getById('svc', row.code_graph_id)?.sync_error).toBe('Git authentication failed');
  } finally {
    module.autoSyncScheduler.stop(); raw.close(); await rm(dir, { recursive: true, force: true });
  }
});

import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../../src/db/client.js';
import { SqliteKnowledgeStore } from '../../src/store/sqlite-store.js';
import { WikiService, type WikiWorker } from '../../src/store/wiki-service.js';
import { createWikiRoutes, type WikiRouteDeps } from '../../src/routes/wiki.js';
import { evictWikiDb } from '../../src/engines/wiki/index-db.js';

// Real Hono routes -> service -> Drizzle/SQLite, queue and filesystem.
// Only the expensive external indexing/LLM worker and engine registry are replaced.
describe('Wiki route, storage and build lifecycle integration', () => {
  let root: string;
  let database: ReturnType<typeof createDb>;
  let store: SqliteKnowledgeStore;
  let service: WikiService;
  let routes: ReturnType<typeof createWikiRoutes>;
  let worker: ReturnType<typeof vi.fn<WikiWorker>>;
  const wikiIds: string[] = [];
  const releases: Array<() => void> = [];

  function open() {
    database = createDb({ path: join(root, 'knowledge.db') });
    store = new SqliteKnowledgeStore(database.db);
    service = new WikiService({ store, dataRoot: join(root, 'assets'), worker: (ctx) => worker(ctx) });
    routes = createWikiRoutes({
      wikiService: service,
      wikiMgr: { remove() {} } as unknown as WikiRouteDeps['wikiMgr'],
      publicBaseUrl: 'http://knowledge.test/v3',
    });
  }

  async function post(path: string, body: Record<string, unknown>, tenant = 'tenant-a') {
    const response = await routes.request(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-tdai-service-id': tenant },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  async function create(name = 'wiki', tenant = 'tenant-a', team = 'team-a') {
    const result = await post('/create', { name, team_id: team, user_id: 'owner' }, tenant);
    expect(result.status).toBe(201);
    const id = result.body.data.wiki_id as string;
    wikiIds.push(id);
    return id;
  }

  async function upload(id: string, content = 'source text') {
    const result = await post('/raw/write', {
      wiki_id: id, team_id: 'team-a', files: [{ filename: 'source.md', content }],
    });
    expect(result.status).toBe(200);
  }

  function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    releases.push(release);
    return { promise, release };
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-integration-'));
    worker = vi.fn<WikiWorker>().mockResolvedValue({ pageCount: 1 });
    open();
  });

  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    await service?.onIdle();
    for (const id of wikiIds.splice(0)) evictWikiDb(id);
    if (database?.raw.open) database.raw.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('creates idempotently within one tenant/team and isolates duplicate names elsewhere', async () => {
    const id = await create();
    const duplicate = await post('/create', { name: 'wiki', team_id: 'team-a' });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.data.wiki_id).toBe(id);
    expect(await create('wiki', 'tenant-b')).not.toBe(id);
    expect(await create('wiki', 'tenant-a', 'team-b')).not.toBe(id);
    const list = await post('/list', { team_id: 'team-a' });
    expect(list.body.data.total).toBe(1);
    expect(list.body.data.items[0]).toMatchObject({ wiki_id: id, service_url: 'http://knowledge.test/v3' });
    expect(existsSync(join(service.dirFor('tenant-a', 'team-a', id), 'index.db'))).toBe(true);
  });

  it('enforces tenant/team scope at the routes and actual SQLite mutations', async () => {
    const id = await create();
    await upload(id);
    expect((await post('/get', { wiki_id: id }, 'tenant-b')).status).toBe(404);
    expect((await post('/raw/write', { wiki_id: id, team_id: 'team-b', files: [{ filename: 'source.md', content: 'wrong' }] })).status).toBe(404);
    const deletion = await post('/delete', { wiki_ids: [id] }, 'tenant-b');
    expect(deletion.body.data).toEqual({ deleted_ids: [], failed: [{ id, reason: 'not found' }] });
    store.updateWikiStatus('tenant-b', id, { status: 'failed' });
    expect(store.getWikiById('tenant-a', id)?.status).toBe('draft');
    const read = await post('/raw/read', { wiki_id: id, filenames: ['source.md'] });
    expect(read.body.data.items).toEqual([{ filename: 'source.md', content: 'source text' }]);
  });

  it('rejects a bad file in a batch before writing any files or source index rows', async () => {
    const id = await create();
    const result = await post('/raw/write', { wiki_id: id, team_id: 'team-a', files: [
      { filename: 'good.md', content: 'good' }, { filename: '../escape.md', content: 'bad' },
    ] });
    expect(result.status).toBe(400);
    expect((await post('/raw/ls', { wiki_id: id })).body.data.items).toEqual([]);
    expect(existsSync(join(service.dirFor('tenant-a', 'team-a', id), 'raw', 'sources', 'good.md'))).toBe(false);
  });

  it('rolls back previously written files when a later file hits a real filesystem error', async () => {
    const id = await create();
    await upload(id, 'original');
    const dir = join(service.dirFor('tenant-a', 'team-a', id), 'raw', 'sources');
    mkdirSync(join(dir, 'blocked.md'));
    const result = await post('/raw/write', { wiki_id: id, team_id: 'team-a', files: [
      { filename: 'source.md', content: 'overwritten' }, { filename: 'blocked.md', content: 'cannot write over directory' },
    ] });
    expect(result.status).toBe(400);
    expect(readFileSync(join(dir, 'source.md'), 'utf8')).toBe('original');
    expect(service.rawLs('tenant-a', 'team-a', id)?.map((file) => file.filename)).toEqual(['source.md']);
  });

  it('enforces byte-size limits, including multibyte text, before touching storage', async () => {
    const id = await create();
    const result = await post('/raw/write', { wiki_id: id, team_id: 'team-a', files: [
      { filename: 'large.md', content: '中'.repeat(180_000) },
    ] });
    expect(result.status).toBe(413);
    expect(service.rawLs('tenant-a', 'team-a', id)).toEqual([]);
  });

  it('retains metadata, source files and source index after closing and reopening SQLite', async () => {
    const id = await create();
    await upload(id, 'persisted source');
    evictWikiDb(id);
    database.raw.close();
    open();
    expect((await post('/get', { wiki_id: id })).body.data.name).toBe('wiki');
    const read = await post('/raw/read', { wiki_id: id, filenames: ['source.md'] });
    expect(read.body.data.items[0].content).toBe('persisted source');
    expect(service.rawLs('tenant-a', 'team-a', id)).toHaveLength(1);
  });

  it('recovers interrupted rows after restart without changing ready or draft assets', async () => {
    const pending = await create('pending');
    const ready = await create('ready');
    const draft = await create('draft');
    const otherTenant = await create('processing', 'tenant-b');
    store.updateWikiStatus('tenant-a', pending, { status: 'pending' });
    store.updateWikiStatus('tenant-a', ready, { status: 'ready' });
    store.updateWikiStatus('tenant-b', otherTenant, { status: 'processing' });
    database.raw.close();
    open();
    expect(store.markInterruptedAsFailed()).toBe(2);
    expect(store.getWikiById('tenant-a', pending)).toMatchObject({ status: 'failed', sync_error: 'interrupted by restart' });
    expect(store.getWikiById('tenant-b', otherTenant)?.status).toBe('failed');
    expect(store.getWikiById('tenant-a', ready)?.status).toBe('ready');
    expect(store.getWikiById('tenant-a', draft)?.status).toBe('draft');
    expect(store.markInterruptedAsFailed()).toBe(0);
  });

  it('allows a second wiki to finish while another wiki worker is blocked', async () => {
    const first = await create('first');
    const second = await create('second');
    await upload(first);
    await upload(second);
    const active = gate();
    worker.mockImplementationOnce(async () => { await active.promise; return { pageCount: 2 }; });
    await post('/ingest', { wiki_id: first });
    await post('/ingest', { wiki_id: second });
    await service.onIdle(second);
    expect(store.getWikiById('tenant-a', first)?.status).toBe('processing');
    expect(store.getWikiById('tenant-a', second)?.status).toBe('ready');
    active.release();
    await service.onIdle();
  });

  it('rejects duplicate ingest while running, persists failure, and permits a successful retry', async () => {
    const id = await create();
    await upload(id);
    const active = gate();
    worker.mockImplementationOnce(async () => { await active.promise; throw new Error('model unavailable'); });
    expect((await post('/ingest', { wiki_id: id })).status).toBe(202);
    expect((await post('/ingest', { wiki_id: id })).status).toBe(409);
    active.release();
    await service.onIdle();
    expect(store.getWikiById('tenant-a', id)).toMatchObject({ status: 'failed', sync_error: 'model unavailable' });
    expect((await post('/ingest', { wiki_id: id })).status).toBe(202);
    await service.onIdle();
    expect(store.getWikiById('tenant-a', id)).toMatchObject({ status: 'ready', sync_error: null, page_count: 1 });
    expect(worker).toHaveBeenCalledTimes(2);
  });

  it('does not resurrect a wiki deleted while its worker is still running', async () => {
    const id = await create();
    await upload(id);
    const active = gate();
    worker.mockImplementationOnce(async () => { await active.promise; return { pageCount: 99 }; });
    await post('/ingest', { wiki_id: id });
    expect((await post('/delete', { wiki_ids: [id] })).body.data.deleted_ids).toEqual([id]);
    active.release();
    await service.onIdle();
    expect(store.getWikiById('tenant-a', id)).toBeNull();
    expect(existsSync(service.dirFor('tenant-a', 'team-a', id))).toBe(false);
    expect(store.listWikiAudit('tenant-a', id).some((entry) => entry.action === 'ready')).toBe(false);
  });

  it.each([
    ['repeated-replace', 'resolve'], ['repeated-replace', 'reject'],
    ['upload-before-replace', 'resolve'], ['upload-before-replace', 'reject'],
  ])('only publishes the latest build after %s when the old worker will %s', async (scenario, completion) => {
    const id = await create();
    await upload(id);
    const active = gate();
    worker.mockImplementationOnce(async () => {
      await active.promise;
      if (completion === 'reject') throw new Error('superseded build failed');
      return { pageCount: 99 };
    });
    await post('/ingest', { wiki_id: id });
    if (scenario === 'upload-before-replace') await upload(id, 'new source');
    expect((await post('/ingest', { wiki_id: id, on_busy: 'replace' })).body.data.queued).toBe(true);
    if (scenario === 'repeated-replace') await post('/ingest', { wiki_id: id, on_busy: 'replace' });
    active.release();
    await service.onIdle();
    expect(store.getWikiById('tenant-a', id)).toMatchObject({ status: 'ready', page_count: 1 });
    expect(worker).toHaveBeenCalledTimes(2); // The active old worker + the latest requested build.
    expect(store.listWikiAudit('tenant-a', id).filter((entry) => entry.action === 'ready')).toHaveLength(1);
    expect(store.listWikiAudit('tenant-a', id).filter((entry) => entry.action === 'failed')).toHaveLength(0);
  });
});

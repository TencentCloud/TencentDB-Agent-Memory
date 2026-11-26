/**
 * POST /api/v1/knowledge/wiki/import-and-ingest 路由级回归测试（issue #1795）。
 *
 * 背景：external 模式下修复前丢弃了 kc.wikiSourceImport() 的返回
 * （imported/skippedDirs/failed/warnings），无条件触发 wikiIngest 并返回 ok:true，
 * 导致"所有页都没导入"也被前端当作成功并启动 ingest 进度。
 *
 * 测试方式：不启 HTTP server，把 wiki 路由挂到独立 Hono app，用最小 fake deps
 * （metaKernel 负责门控，knowledgeClientFactory 返回 mock kc）驱动。
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { PanelDeps } from '../../src/panel/panel-deps.js';
import type { MetaEnvelope } from '../../src/panel/kernel/envelope.js';
import type { WikiSourceImportResult } from '../../src/panel/kernel/ports/knowledge-client-port.js';
import { registerKnowledgeWikiRoutes } from '../../src/panel/http/routes/knowledge/wiki-routes.js';

const INSTANCE_ID = 'inst-test';
const USER_KEY = 'uk-test';
const CALLER_ID = 'user-caller';
const WIKI_ID = 'wiki-1';
const TEAM_ID = 'team-1';

function envelope<T>(code: number, message: string, data: T): MetaEnvelope<T> {
  return { code, message, request_id: 'req-test', data };
}

function silentLogger(): PanelDeps['logger'] {
  const logger: PanelDeps['logger'] = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
  };
  return logger;
}

interface Harness {
  app: Hono;
  importCalls: unknown[];
  ingestCalls: Array<{ wikiId: string; opts: unknown }>;
}

function createHarness(importImpl: () => Promise<WikiSourceImportResult>): Harness {
  const importCalls: unknown[] = [];
  const ingestCalls: Array<{ wikiId: string; opts: unknown }> = [];

  const metaKernel = {
    async invoke(action: string): Promise<MetaEnvelope<unknown>> {
      if (action === 'auth/verify') {
        return envelope(0, 'ok', { valid: true, user: { user_id: CALLER_ID } });
      }
      if (action === 'asset/get') {
        return envelope(0, 'ok', {
          asset_id: WIKI_ID,
          team_id: TEAM_ID,
          asset_type: 'llm_wiki',
          name: 'w',
          owner_user_id: CALLER_ID,
          visibility: 'team',
          status: 'active',
        });
      }
      if (action === 'acl/check') return envelope(0, 'ok', { allowed: true });
      if (action === 'team-member/get') return envelope(0, 'ok', { user_id: CALLER_ID });
      throw new Error(`unexpected meta action: ${action}`);
    },
  };

  const kc = {
    async wikiSourceImport(params: unknown): Promise<WikiSourceImportResult> {
      importCalls.push(params);
      return importImpl();
    },
    async wikiIngest(wikiId: string, opts: unknown) {
      ingestCalls.push({ wikiId, opts });
      return { wiki_id: wikiId, status: 'pending', queued: false };
    },
  };

  const deps = {
    config: { auth: { sessionCookieName: 'panel_session' }, metadataRemoteTimeoutMs: 30_000 },
    logger: silentLogger(),
    instanceRegistry: {
      resolve: () => ({
        instance_id: INSTANCE_ID,
        name: 'test-instance',
        gateway_endpoint: 'http://kernel.invalid',
        api_key: 'test-api-key',
      }),
    },
    metaKernel,
    knowledgeClientFactory: () => kc,
    auth: { resolveSession: () => null },
  } as unknown as PanelDeps;

  const api = new Hono();
  api.use('*', async (c, next) => {
    c.set('reqId', 'req-test');
    await next();
  });
  registerKnowledgeWikiRoutes(api, deps);
  const app = new Hono();
  app.route('/api/v1', api);
  return { app, importCalls, ingestCalls };
}

async function post(
  h: Harness,
  body: Record<string, unknown> = {
    wiki_id: WIKI_ID,
    mode: 'external',
    source_url: 'https://wiki.example.invalid/space/1',
    provider_id: 'iwiki',
    page_ids: ['p1', 'p2'],
  },
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await h.app.request('/api/v1/knowledge/wiki/import-and-ingest', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tdai-service-id': INSTANCE_ID,
      'x-tdai-user-key': USER_KEY,
    },
    body: JSON.stringify(body),
  });
  const env = (await res.json()) as MetaEnvelope<Record<string, unknown>>;
  return { status: res.status, data: env.data };
}

describe('import-and-ingest · external 导入结果（issue #1795 回归）', () => {
  it('零页导入且有失败 → 不触发 ingest，ok:false 并带失败摘要', async () => {
    const h = createHarness(async () => ({
      imported: 0,
      skippedDirs: 0,
      failed: [
        { id: 'deleted-page', error: 'requested page not found in current source listing' },
        { id: 'p2', error: 'download failed: 500' },
      ],
      warnings: ['token near expiry'],
    }));

    const { status, data } = await post(h);

    expect(status).toBe(200);
    expect(h.importCalls).toHaveLength(1);
    expect(h.ingestCalls).toHaveLength(0);
    expect(data.ok).toBe(false);
    expect(data.wiki_id).toBe(WIKI_ID);
    expect(data.failed_at).toBe('write');
    expect(data.error_code).toBe('WIKI_SOURCE_IMPORT_FAILED');
    expect(data.raw_persisted).toBe(false);
    expect(data.imported).toBe(0);
    expect(data.failed).toEqual([
      { id: 'deleted-page', error: 'requested page not found in current source listing' },
      { id: 'p2', error: 'download failed: 500' },
    ]);
    expect(data.warnings).toEqual(['token near expiry']);
    const msg = String(data.error_message);
    expect(msg).toContain('imported 0');
    expect(msg).toContain('failed 2');
    expect(msg).toContain('deleted-page');
  });

  it('部分成功 → 照常触发 ingest，ok:true 且带回 imported/failed', async () => {
    const h = createHarness(async () => ({
      imported: 3,
      skippedDirs: 1,
      failed: [{ id: 'p9', error: 'timeout' }],
      warnings: [],
    }));

    const { status, data } = await post(h);

    expect(status).toBe(200);
    expect(h.ingestCalls).toEqual([{ wikiId: WIKI_ID, opts: { onBusy: 'replace' } }]);
    expect(data.ok).toBe(true);
    expect(data.status).toBe('pending');
    expect(data.raw_persisted).toBe(true);
    expect(data.imported).toBe(3);
    expect(data.skipped_dirs).toBe(1);
    expect(data.failed).toEqual([{ id: 'p9', error: 'timeout' }]);
    expect(data.warnings).toEqual([]);
  });

  it('全部成功 → ok:true 并保持原有字段兼容', async () => {
    const h = createHarness(async () => ({ imported: 2, skippedDirs: 0, failed: [], warnings: [] }));

    const { status, data } = await post(h);

    expect(status).toBe(200);
    expect(h.ingestCalls).toHaveLength(1);
    expect(data).toMatchObject({
      ok: true,
      wiki_id: WIKI_ID,
      ingest_task_id: WIKI_ID,
      status: 'pending',
      queued: false,
      raw_persisted: true,
      imported: 2,
      failed: [],
    });
  });

  it('wikiSourceImport 抛错 → 沿用原 catch：ok:false / IMPORT_AND_INGEST_FAILED / failed_at=write', async () => {
    const h = createHarness(async () => {
      throw new Error('source unreachable');
    });

    const { status, data } = await post(h);

    expect(status).toBe(200);
    expect(h.ingestCalls).toHaveLength(0);
    expect(data).toEqual({
      ok: false,
      wiki_id: WIKI_ID,
      failed_at: 'write',
      error_code: 'IMPORT_AND_INGEST_FAILED',
      error_message: 'source unreachable',
      raw_persisted: false,
    });
  });

  it('reingest 模式不受影响：不调导入，直接 ingest，响应无导入摘要', async () => {
    const h = createHarness(async () => ({ imported: 0, skippedDirs: 0, failed: [], warnings: [] }));

    const { data } = await post(h, { wiki_id: WIKI_ID, mode: 'reingest' });

    expect(h.importCalls).toHaveLength(0);
    expect(h.ingestCalls).toHaveLength(1);
    expect(data).toEqual({
      ok: true,
      wiki_id: WIKI_ID,
      ingest_task_id: WIKI_ID,
      status: 'pending',
      queued: false,
    });
  });
});

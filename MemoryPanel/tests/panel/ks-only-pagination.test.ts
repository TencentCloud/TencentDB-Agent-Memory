/**
 * KS-only 资产分页回归测试（issue #1636）。
 *
 * 背景：`mergeWithKsOnlyItems` 用 `fetchKsOnlyItems` 把 meta 未注册的 KS 资产
 * （经 Knowledge API 直接创建的 code graph / wiki）补进列表。修复前它调用
 * `kc.wikiList(teamId)` / `kc.codeGraphList(teamId)` 时**不传分页参数**，而 KS 侧
 * （MemoryKnowledge/src/routes/wiki.ts、routes/code-graph.ts）未传 limit 时默认
 * 20，于是第 21 条起被静默截断 —— 用户建了 28 个 code graph，Memory Hub 只显示
 * 20 个且没有下一页。
 *
 * 修复后 `fetchKsOnlyItems` 按 `{limit: 100, offset}` 翻页拉全，本文件覆盖：
 *   1. 25 个 KS-only code graph / wiki 全部出现（跨过默认 20 条线）；
 *   2. 分页请求参数逐次断言（limit/offset/总数），不重复、不遗漏；
 *   3. 中间页整页为空但 total 仍指示后面有数据 → 继续推进 offset；
 *   4. 短页 + total 缺失（无 total 的 KS 兼容形态）→ 按总条数/空页收敛；
 *   5. 第二页抛错 → 与既有 catch 语义一致：fetchKsOnlyItems 返回 []，
 *      mergeWithKsOnlyItems 原样返回 meta 列表，不向上抛；
 *   6. 防御性上限：total 说谎且每页都满时，翻页次数被封顶，不无限拉。
 *
 * 测试方式：不启 HTTP server，mock `PanelDeps.knowledgeClientFactory` 提供一个
 * 忠实模拟 KS 分页语义的 fake `KnowledgeClientPort`（不传 limit 默认 20、offset
 * 默认 0），通过导出的 `mergeWithKsOnlyItems` 驱动，并记录每次分页调用的实参。
 */
import { describe, expect, it } from 'vitest';
import {
  ASSET_TYPE_CODE_GRAPH,
  ASSET_TYPE_WIKI,
  mergeWithKsOnlyItems,
  type KnowledgeAssetListItem,
} from '../../src/panel/http/routes/knowledge/common.js';
import type { PanelDeps } from '../../src/panel/panel-deps.js';
import type { MetaCallContext } from '../../src/panel/kernel/types.js';
import type {
  CodeGraphDetail,
  CodeGraphListResult,
  KnowledgeClientPort,
  WikiDetail,
  WikiListResult,
} from '../../src/panel/kernel/ports/knowledge-client-port.js';

const INSTANCE_ID = 'inst-test';
const TEAM_ID = 'team-1';
/** KS 侧不传 limit 的默认值（routes/wiki.ts、routes/code-graph.ts 同款）。 */
const KS_DEFAULT_LIMIT = 20;
/** 修复后 fetchKsOnlyItems 期望的页大小。 */
const PAGE = 100;
/** 与 common.ts 的 KS_LIST_MAX_PAGES 对齐（防御性上限断言用）。 */
const MAX_PAGES = 1000;

const ctx = { instanceId: INSTANCE_ID } as MetaCallContext;

// ── fixtures ──────────────────────────────────────────────────────────

function makeWiki(i: number): WikiDetail {
  return {
    wiki_id: `wiki-${String(i).padStart(3, '0')}`,
    team_id: TEAM_ID,
    name: `Wiki ${i}`,
    source_type: null,
    source_url: null,
    service_url: null,
    summary: null,
    status: 'ready',
    internal_status: null,
    sync_error: null,
    version: 'v1',
    owner_user_id: 'user-1',
    page_count: 3,
    last_sync_at: null,
    created_at: '2026-10-12T00:00:00Z',
    updated_at: '2026-10-12T00:00:00Z',
  };
}

function makeCodeGraph(i: number): CodeGraphDetail {
  return {
    code_graph_id: `cg-${String(i).padStart(3, '0')}`,
    team_id: TEAM_ID,
    repo_name: `repo-${i}`,
    repo_url: `https://example.com/repo-${i}.git`,
    branch: 'main',
    source_type: null,
    commit_hash: null,
    service_url: null,
    summary: null,
    status: 'ready',
    sync_error: null,
    version: 'v1',
    owner_user_id: 'user-1',
    stats: { files: 1, nodes: 2, edges: 3 },
    last_sync_at: null,
    created_at: '2026-10-12T00:00:00Z',
    updated_at: '2026-10-12T00:00:00Z',
  };
}

// ── fake KS client ────────────────────────────────────────────────────

interface KsCall {
  method: 'wikiList' | 'codeGraphList';
  teamId: string;
  opts: { limit: number; offset: number } | undefined;
}

interface FakeKsOptions {
  wikis?: WikiDetail[];
  codeGraphs?: CodeGraphDetail[];
  /** 覆盖单次响应（index 从 0 递增），用于模拟空页 / 报错 / total 说谎。 */
  override?: (
    call: KsCall,
    index: number,
  ) => WikiListResult | CodeGraphListResult | Error | undefined;
}

interface FakeKs {
  client: KnowledgeClientPort;
  calls: KsCall[];
  factoryCalls: string[];
}

/**
 * 忠实模拟 KS 分页语义：不传 limit → 20，不传 offset → 0（与
 * MemoryKnowledge/src/routes/wiki.ts:219-222 一致），并按 total 返回全量计数。
 */
function createFakeKs(options: FakeKsOptions = {}): FakeKs {
  const wikis = options.wikis ?? [];
  const codeGraphs = options.codeGraphs ?? [];
  const calls: KsCall[] = [];
  const factoryCalls: string[] = [];

  const page = <T>(all: T[], opts?: { limit?: number; offset?: number }) => {
    const limit = typeof opts?.limit === 'number' ? opts.limit : KS_DEFAULT_LIMIT;
    const offset = typeof opts?.offset === 'number' ? opts.offset : 0;
    return { items: all.slice(offset, offset + limit), total: all.length };
  };

  const run = (call: KsCall, all: WikiDetail[] | CodeGraphDetail[]) => {
    const index = calls.filter((c) => c.method === call.method).length;
    calls.push(call);
    const overridden = options.override?.(call, index);
    if (overridden instanceof Error) throw overridden;
    if (overridden) return overridden;
    return page(all, call.opts);
  };

  const client = {
    async wikiList(
      teamId: string,
      opts?: { limit?: number; offset?: number },
    ): Promise<WikiListResult> {
      const call: KsCall = {
        method: 'wikiList',
        teamId,
        opts: opts as { limit: number; offset: number } | undefined,
      };
      return run(call, wikis) as WikiListResult;
    },
    async codeGraphList(
      teamId: string,
      opts?: { limit?: number; offset?: number },
    ): Promise<CodeGraphListResult> {
      const call: KsCall = {
        method: 'codeGraphList',
        teamId,
        opts: opts as { limit: number; offset: number } | undefined,
      };
      return run(call, codeGraphs) as CodeGraphListResult;
    },
  };

  return {
    client: client as unknown as KnowledgeClientPort,
    calls,
    factoryCalls,
  };
}

function makeDeps(fake: FakeKs): PanelDeps {
  return {
    knowledgeClientFactory: (instanceId: string) => {
      fake.factoryCalls.push(instanceId);
      return fake.client;
    },
  } as unknown as PanelDeps;
}

/** meta 侧已注册的列表项（join 后的形态，只有 knowledge_id 参与去重）。 */
function metaItem(id: string, assetType: string): KnowledgeAssetListItem {
  return {
    knowledge_id: id,
    asset_type: assetType,
    name: `registered ${id}`,
    visibility: 'team',
    owner_user_id: 'user-1',
    meta_status: 'ready',
    status: 'ready',
  };
}

/** 只断言分页实参序列：每页 limit=PAGE，offset 依次 0/100/200/...。 */
function expectedPages(pages: number): Array<{ limit: number; offset: number }> {
  return Array.from({ length: pages }, (_, i) => ({ limit: PAGE, offset: i * PAGE }));
}

// ── tests ─────────────────────────────────────────────────────────────

describe('fetchKsOnlyItems pagination (issue #1636)', () => {
  it('returns all 25 KS-only code graphs, not just the KS default page of 20', async () => {
    const codeGraphs = Array.from({ length: 25 }, (_, i) => makeCodeGraph(i));
    const fake = createFakeKs({ codeGraphs });

    const result = await mergeWithKsOnlyItems(
      makeDeps(fake),
      ctx,
      TEAM_ID,
      [],
      ASSET_TYPE_CODE_GRAPH,
    );

    expect(result).toHaveLength(25);
    expect(result.map((r) => r.knowledge_id)).toEqual(codeGraphs.map((g) => g.code_graph_id));
    // 修复前：不传 opts → KS 只回前 20 条。这里显式排掉该回归。
    expect(result.map((r) => r.knowledge_id)).toContain('cg-024');
  });

  it('returns all 25 KS-only wikis, not just the KS default page of 20', async () => {
    const wikis = Array.from({ length: 25 }, (_, i) => makeWiki(i));
    const fake = createFakeKs({ wikis });

    const result = await mergeWithKsOnlyItems(makeDeps(fake), ctx, TEAM_ID, [], ASSET_TYPE_WIKI);

    expect(result).toHaveLength(25);
    expect(result.map((r) => r.knowledge_id)).toEqual(wikis.map((w) => w.wiki_id));
    expect(result.map((r) => r.knowledge_id)).toContain('wiki-024');
  });

  it('pages code graphs with the correct limit/offset sequence: no duplicates, no gaps', async () => {
    const codeGraphs = Array.from({ length: 250 }, (_, i) => makeCodeGraph(i));
    const fake = createFakeKs({ codeGraphs });

    const result = await mergeWithKsOnlyItems(
      makeDeps(fake),
      ctx,
      TEAM_ID,
      [],
      ASSET_TYPE_CODE_GRAPH,
    );

    // 请求参数逐次断言：100/0, 100/100, 100/200。
    expect(fake.calls.map((c) => ({ method: c.method, teamId: c.teamId, ...c.opts }))).toEqual(
      expectedPages(3).map((opts) => ({ method: 'codeGraphList', teamId: TEAM_ID, ...opts })),
    );
    // 无重复、无遗漏。
    const ids = result.map((r) => r.knowledge_id);
    expect(ids).toHaveLength(codeGraphs.length);
    expect(new Set(ids).size).toBe(codeGraphs.length);
    expect(ids).toEqual(codeGraphs.map((g) => g.code_graph_id));
  });

  it('pages wikis with the correct limit/offset sequence: no duplicates, no gaps', async () => {
    const wikis = Array.from({ length: 200 }, (_, i) => makeWiki(i));
    const fake = createFakeKs({ wikis });

    const result = await mergeWithKsOnlyItems(makeDeps(fake), ctx, TEAM_ID, [], ASSET_TYPE_WIKI);

    // 200 条 = 两页满页；第二页后按 total 收敛，不再多发一次空页请求。
    expect(fake.calls.map((c) => ({ method: c.method, ...c.opts }))).toEqual(
      expectedPages(2).map((opts) => ({ method: 'wikiList', ...opts })),
    );
    const ids = result.map((r) => r.knowledge_id);
    expect(new Set(ids).size).toBe(200);
    expect(ids).toEqual(wikis.map((w) => w.wiki_id));
  });

  it('stops after one request when the team has fewer items than one page', async () => {
    const codeGraphs = Array.from({ length: 7 }, (_, i) => makeCodeGraph(i));
    const fake = createFakeKs({ codeGraphs });

    const result = await mergeWithKsOnlyItems(
      makeDeps(fake),
      ctx,
      TEAM_ID,
      [],
      ASSET_TYPE_CODE_GRAPH,
    );

    expect(result).toHaveLength(7);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.opts).toEqual({ limit: PAGE, offset: 0 });
  });

  it('keeps paging when an intermediate page is empty but total says more follows', async () => {
    const codeGraphs = Array.from({ length: 250 }, (_, i) => makeCodeGraph(i));
    const fake = createFakeKs({
      codeGraphs,
      override: (call, index) => {
        if (call.method !== 'codeGraphList') return undefined;
        // 第 0 页正常 100 条（total=250）；第 1 页（offset=100）模拟过滤后整页为空，
        // total 仍是 250 → 不能就此收尾；第 2 页（offset=200）由 fake 按真实 offset
        // 切片返回 50 条短页 → 收敛。
        if (index === 1) return { items: [], total: 250 };
        return undefined;
      },
    });

    const result = await mergeWithKsOnlyItems(
      makeDeps(fake),
      ctx,
      TEAM_ID,
      [],
      ASSET_TYPE_CODE_GRAPH,
    );

    // offset 0（100 条）→ offset 100（空页，但 total 说还有 → 继续推进）→ offset 200（短页，收敛）。
    expect(fake.calls.map((c) => c.opts)).toEqual(expectedPages(3));
    expect(result).toHaveLength(150);
    expect(new Set(result.map((r) => r.knowledge_id)).size).toBe(150);
  });

  it('falls back to empty-page termination when KS omits total (legacy list shape)', async () => {
    const codeGraphs = Array.from({ length: 25 }, (_, i) => makeCodeGraph(i));
    const fake = createFakeKs({
      codeGraphs,
      override: (call) => {
        if (call.method !== 'codeGraphList') return undefined;
        const opts = call.opts ?? { limit: KS_DEFAULT_LIMIT, offset: 0 };
        const items = codeGraphs.slice(opts.offset, opts.offset + opts.limit);
        // 无 total：只能靠空页/短页收敛。
        return { items } as unknown as CodeGraphListResult;
      },
    });

    const result = await mergeWithKsOnlyItems(
      makeDeps(fake),
      ctx,
      TEAM_ID,
      [],
      ASSET_TYPE_CODE_GRAPH,
    );

    expect(result).toHaveLength(25);
    // 第 0 页 25 条（短页）→ 收敛；不追加空页请求。
    expect(fake.calls.map((c) => c.opts)).toEqual(expectedPages(1));
  });

  it('returns [] (no throw) when the second page fails, preserving the existing catch semantics', async () => {
    const codeGraphs = Array.from({ length: 250 }, (_, i) => makeCodeGraph(i));
    const fake = createFakeKs({
      codeGraphs,
      override: (call, index) => {
        if (call.method === 'codeGraphList' && index === 1) {
          return new Error('KS upstream 502');
        }
        return undefined;
      },
    });
    const registered = metaItem('cg-000', ASSET_TYPE_CODE_GRAPH);

    const result = await mergeWithKsOnlyItems(
      makeDeps(fake),
      ctx,
      TEAM_ID,
      [registered],
      ASSET_TYPE_CODE_GRAPH,
    );

    // 修复前后共同语义：fetchKsOnlyItems 内部 catch 返回 []，因此 KS 侧一条也不补，
    // 已有的 meta 列表原样返回，且不向上抛错（已取到的第 1 页也被丢弃 —— 宁可
    // 少显示也不半截显示，与既有 catch 行为一致）。
    expect(result).toEqual([registered]);
    // 确认确实打到了第 2 页才失败，不是首屏就短路。
    expect(fake.calls.map((c) => c.opts)).toEqual(expectedPages(2));
  });

  it('returns [] (no throw) when the wiki second page fails', async () => {
    const wikis = Array.from({ length: 150 }, (_, i) => makeWiki(i));
    const fake = createFakeKs({
      wikis,
      override: (call, index) =>
        call.method === 'wikiList' && index === 1 ? new Error('KS upstream timeout') : undefined,
    });

    const result = await mergeWithKsOnlyItems(makeDeps(fake), ctx, TEAM_ID, [], ASSET_TYPE_WIKI);

    expect(result).toEqual([]);
    expect(fake.calls.map((c) => c.opts)).toEqual(expectedPages(2));
  });

  it('caps the number of pages when KS keeps returning full pages with a bogus total', async () => {
    const codeGraphs = Array.from({ length: 100 }, (_, i) => makeCodeGraph(i));
    const fake = createFakeKs({
      codeGraphs,
      override: (call) => {
        if (call.method !== 'codeGraphList') return undefined;
        // total 永远说谎（比已取到的大很多），且每页都“满”——只有防御性上限能收敛。
        return { items: codeGraphs, total: Number.MAX_SAFE_INTEGER };
      },
    });

    const result = await mergeWithKsOnlyItems(
      makeDeps(fake),
      ctx,
      TEAM_ID,
      [],
      ASSET_TYPE_CODE_GRAPH,
    );

    expect(fake.calls).toHaveLength(MAX_PAGES);
    expect(result).toHaveLength(MAX_PAGES * PAGE);
  });

  it('still appends KS-only items after meta-registered ones without duplicating ids', async () => {
    const codeGraphs = Array.from({ length: 25 }, (_, i) => makeCodeGraph(i));
    const fake = createFakeKs({ codeGraphs });
    // meta 已注册 cg-000 / cg-024 与一个 KS 侧不存在的 id。
    const registered = [
      metaItem('cg-000', ASSET_TYPE_CODE_GRAPH),
      metaItem('cg-024', ASSET_TYPE_CODE_GRAPH),
      metaItem('cg-meta-only', ASSET_TYPE_CODE_GRAPH),
    ];

    const result = await mergeWithKsOnlyItems(
      makeDeps(fake),
      ctx,
      TEAM_ID,
      registered,
      ASSET_TYPE_CODE_GRAPH,
    );

    expect(result.slice(0, registered.length)).toEqual(registered);
    const orphanIds = result.slice(registered.length).map((r) => r.knowledge_id);
    expect(orphanIds).toHaveLength(23);
    expect(orphanIds).not.toContain('cg-000');
    expect(orphanIds).not.toContain('cg-024');
    expect(orphanIds).toContain('cg-023');
  });
});
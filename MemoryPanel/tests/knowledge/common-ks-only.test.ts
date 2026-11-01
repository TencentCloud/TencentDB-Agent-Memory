/**
 * fetchKsOnlyItems 分页回归测试（issue #1636）。
 *
 * 内核 DEFAULT_PAGINATION = { limit: 20 }，fetchKsOnlyItems 原来调用
 * kc.codeGraphList(teamId) / kc.wikiList(teamId) 不传 opts，导致 meta 未注册的
 * KS-only 项（如经 Knowledge API 直接创建的 code graph）从第 21 个起被静默截断。
 * 修复后应按 { limit: 100, offset } 翻页取全。
 *
 * stub 的 KC 忠实模拟内核分页语义（pagination.ts resolvePagination：不传 limit
 * 默认 20、offset 默认 0；单页上限 100）。
 */
import { describe, expect, it } from 'vitest';

import type { PanelDeps } from '../../src/panel/panel-deps.js';
import type { MetaCallContext } from '../../src/panel/kernel/types.js';
import type {
  CodeGraphDetail,
  CodeGraphListResult,
  KnowledgeClientPort,
  WikiDetail,
  WikiListResult,
} from '../../src/panel/kernel/ports/knowledge-client-port.js';
import { mergeWithKsOnlyItems } from '../../src/panel/http/routes/knowledge/common.js';

const ctx = { instanceId: 'inst-test' } as MetaCallContext;

/** 内核同款分页切片（默认 20/0）。 */
function paginate<T>(all: T[], opts?: { limit?: number; offset?: number }): { items: T[]; total: number } {
  const limit = opts?.limit ?? 20;
  const offset = opts?.offset ?? 0;
  return { items: all.slice(offset, offset + limit), total: all.length };
}

function makeGraph(i: number): CodeGraphDetail {
  const id = `cg-${String(i).padStart(4, '0')}`;
  return {
    code_graph_id: id,
    team_id: 'team-1',
    repo_name: `repo-${i}`,
    repo_url: `https://example.com/${i}.git`,
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

function makeWiki(i: number): WikiDetail {
  return {
    wiki_id: `wiki-${String(i).padStart(4, '0')}`,
    name: `wiki-${i}`,
    team_id: 'team-1',
    source_type: null,
    source_url: null,
    service_url: null,
    summary: null,
    status: 'ready',
    internal_status: null,
    sync_error: null,
    version: 'v1',
    owner_user_id: 'user-1',
    page_count: 0,
    last_sync_at: null,
    created_at: '2026-10-12T00:00:00Z',
    updated_at: '2026-10-12T00:00:00Z',
  };
}

interface ListCall { limit?: number; offset?: number }

/** 记录每次调用的 opts，便于断言翻页参数。 */
function makeDeps(graphs: CodeGraphDetail[], wikis: WikiDetail[]) {
  const codeGraphCalls: ListCall[] = [];
  const wikiCalls: ListCall[] = [];
  const kc = {
    codeGraphList(_teamId: string, opts?: { limit?: number; offset?: number }): Promise<CodeGraphListResult> {
      codeGraphCalls.push(opts ?? {});
      return Promise.resolve(paginate(graphs, opts));
    },
    wikiList(_teamId: string, opts?: { limit?: number; offset?: number }): Promise<WikiListResult> {
      wikiCalls.push(opts ?? {});
      return Promise.resolve(paginate(wikis, opts));
    },
  } as unknown as KnowledgeClientPort;
  const deps = { knowledgeClientFactory: () => kc } as unknown as PanelDeps;
  return { deps, codeGraphCalls, wikiCalls };
}

describe('mergeWithKsOnlyItems · fetchKsOnlyItems 分页（issue #1636）', () => {
  it('code graph 恰好默认一页上限内（≤20）时行为不变', async () => {
    const graphs = Array.from({ length: 20 }, (_, i) => makeGraph(i));
    const { deps } = makeDeps(graphs, []);
    const items = await mergeWithKsOnlyItems(deps, ctx, 'team-1', [], 'code_graph');
    expect(items).toHaveLength(20);
  });

  it('21 个 code graph 全部可见（原 bug：只见 20）', async () => {
    const graphs = Array.from({ length: 21 }, (_, i) => makeGraph(i));
    const { deps, codeGraphCalls } = makeDeps(graphs, []);
    const items = await mergeWithKsOnlyItems(deps, ctx, 'team-1', [], 'code_graph');
    expect(items).toHaveLength(21);
    expect(items.map((x) => x.knowledge_id)).toContain('cg-0020');
    // 翻页：页大小 100，第 2 页 offset=100
    expect(codeGraphCalls).toEqual([{ limit: 100, offset: 0 }]);
  });

  it('101 个 code graph 翻两页取全（原单页 schema 上限 100）', async () => {
    const graphs = Array.from({ length: 101 }, (_, i) => makeGraph(i));
    const { deps, codeGraphCalls } = makeDeps(graphs, []);
    const items = await mergeWithKsOnlyItems(deps, ctx, 'team-1', [], 'code_graph');
    expect(items).toHaveLength(101);
    expect(items.map((x) => x.knowledge_id)).toContain('cg-0100');
    expect(codeGraphCalls).toEqual([
      { limit: 100, offset: 0 },
      { limit: 100, offset: 100 },
    ]);
  });

  it('恰好 100 个 code graph 一页取全、不多翻页', async () => {
    const graphs = Array.from({ length: 100 }, (_, i) => makeGraph(i));
    const { deps, codeGraphCalls } = makeDeps(graphs, []);
    const items = await mergeWithKsOnlyItems(deps, ctx, 'team-1', [], 'code_graph');
    expect(items).toHaveLength(100);
    expect(codeGraphCalls).toEqual([{ limit: 100, offset: 0 }]);
  });

  it('meta 已注册的项不与 KS-only 孤儿重复', async () => {
    const graphs = Array.from({ length: 21 }, (_, i) => makeGraph(i));
    const { deps } = makeDeps(graphs, []);
    const joined = [{
      knowledge_id: 'cg-0000',
      asset_type: 'code_graph',
      name: 'registered',
      visibility: 'team',
      owner_user_id: 'user-1',
      meta_status: 'active',
      status: 'ready',
    }];
    const items = await mergeWithKsOnlyItems(deps, ctx, 'team-1', joined, 'code_graph');
    expect(items).toHaveLength(21);
    expect(items.filter((x) => x.knowledge_id === 'cg-0000')).toHaveLength(1);
  });

  it('wiki 路径同修：21 个 wiki 全部可见', async () => {
    const wikis = Array.from({ length: 21 }, (_, i) => makeWiki(i));
    const { deps, wikiCalls } = makeDeps([], wikis);
    const items = await mergeWithKsOnlyItems(deps, ctx, 'team-1', [], 'llm_wiki');
    expect(items).toHaveLength(21);
    expect(items.map((x) => x.knowledge_id)).toContain('wiki-0020');
    expect(wikiCalls).toEqual([{ limit: 100, offset: 0 }]);
  });
});

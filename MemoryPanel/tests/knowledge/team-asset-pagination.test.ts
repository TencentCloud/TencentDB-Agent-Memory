import { describe, expect, it, vi } from 'vitest';
import {
  ASSET_TYPE_CODE_GRAPH,
  ASSET_TYPE_WIKI,
  mergeWithKsOnlyItems,
  type KnowledgeAssetListItem,
} from '../../src/panel/http/routes/knowledge/common.js';
import type {
  CodeGraphDetail,
  KnowledgeClientPort,
  WikiDetail,
} from '../../src/panel/kernel/ports/knowledge-client-port.js';
import type { MetaCallContext } from '../../src/panel/kernel/types.js';
import type { PanelDeps } from '../../src/panel/panel-deps.js';

const teamId = 'team-1';
const ctx = { instanceId: 'instance-1' } as MetaCallContext;

function clientDeps(client: Partial<KnowledgeClientPort>): PanelDeps {
  return { knowledgeClientFactory: () => client } as PanelDeps;
}

function codeGraphs(count: number): CodeGraphDetail[] {
  return Array.from({ length: count }, (_, index) => ({
    code_graph_id: `cg-${index}`,
    repo_name: `repo-${index}`,
    team_id: teamId,
    status: 'ready',
  }) as CodeGraphDetail);
}

function list<T>(items: T[], pageSize = 100) {
  return vi.fn((_teamId: string, opts?: { offset?: number; limit?: number }) => {
    const offset = opts?.offset ?? 0;
    const size = Math.min(opts?.limit ?? 20, pageSize);
    return Promise.resolve({ items: items.slice(offset, offset + size), total: items.length });
  });
}

describe('team knowledge asset pagination', () => {
  it('lists all API-created code graphs beyond the default page and 1,000 items', async () => {
    const graphs = codeGraphs(1028);
    const codeGraphList = list(graphs);
    const deps = clientDeps({ codeGraphList });

    const result = await mergeWithKsOnlyItems(deps, ctx, teamId, [], ASSET_TYPE_CODE_GRAPH);

    expect(result.map((item) => item.knowledge_id)).toEqual(graphs.map((graph) => graph.code_graph_id));
    expect(codeGraphList.mock.calls).toEqual(
      Array.from({ length: 11 }, (_, page) => [teamId, { limit: 100, offset: page * 100 }]),
    );
  });

  it('continues after short pages when the Knowledge total indicates more items', async () => {
    const codeGraphList = list(codeGraphs(28), 20);
    const deps = clientDeps({ codeGraphList });

    const result = await mergeWithKsOnlyItems(deps, ctx, teamId, [], ASSET_TYPE_CODE_GRAPH);

    expect(result).toHaveLength(28);
    expect(codeGraphList.mock.calls).toEqual([
      [teamId, { limit: 100, offset: 0 }],
      [teamId, { limit: 100, offset: 20 }],
    ]);
  });

  it('preserves metadata and deduplicates overlapping Wiki pages', async () => {
    const wikis = Array.from({ length: 101 }, (_, index) => ({
      wiki_id: `wiki-${index}`,
      name: `Knowledge wiki ${index}`,
      team_id: teamId,
      status: 'ready',
    }) as WikiDetail);
    const wikiList = list([...wikis.slice(0, 100), wikis[99], wikis[100]]);
    const deps = clientDeps({ wikiList });
    const registered = { knowledge_id: 'wiki-0', name: 'Registered name' } as KnowledgeAssetListItem;

    const result = await mergeWithKsOnlyItems(deps, ctx, teamId, [registered], ASSET_TYPE_WIKI);

    expect(result[0]).toBe(registered);
    expect(result.map((item) => item.knowledge_id)).toEqual(wikis.map((wiki) => wiki.wiki_id));
    expect(wikiList).toHaveBeenLastCalledWith(teamId, { limit: 100, offset: 100 });
  });

  it('stops when a concurrent removal leaves an empty page', async () => {
    const codeGraphList = list(codeGraphs(100))
      .mockResolvedValueOnce({ items: codeGraphs(100), total: 101 })
      .mockResolvedValueOnce({ items: [], total: 101 });
    const deps = clientDeps({ codeGraphList });

    const result = await mergeWithKsOnlyItems(deps, ctx, teamId, [], ASSET_TYPE_CODE_GRAPH);

    expect(result).toHaveLength(100);
    expect(codeGraphList).toHaveBeenCalledTimes(2);
  });
});

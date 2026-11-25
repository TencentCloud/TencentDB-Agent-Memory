import { describe, expect, it, vi } from 'vitest';
import {
  KS_LIST_MAX_PAGES,
  KS_LIST_PAGE_SIZE,
  fetchAllKsPages,
  fetchKsOnlyItems,
} from '../src/panel/http/routes/knowledge/common.js';

function pagedSource(total: number) {
  const rows = Array.from({ length: total }, (_, i) => i);
  return vi.fn(async ({ limit, offset }: { limit: number; offset: number }) => ({
    items: rows.slice(offset, offset + limit),
    total,
  }));
}

describe('fetchAllKsPages', () => {
  it('collects every page instead of only the KS default first page', async () => {
    const src = pagedSource(250);
    const all = await fetchAllKsPages(src);
    expect(all).toHaveLength(250);
    expect(src).toHaveBeenCalledTimes(3);
    expect(src.mock.calls.map((c) => c[0])).toEqual([
      { limit: KS_LIST_PAGE_SIZE, offset: 0 },
      { limit: KS_LIST_PAGE_SIZE, offset: 100 },
      { limit: KS_LIST_PAGE_SIZE, offset: 200 },
    ]);
  });

  it('stops on an empty page even if total is inflated', async () => {
    const src = vi.fn(async () => ({ items: [] as number[], total: 10_000 }));
    expect(await fetchAllKsPages(src)).toEqual([]);
    expect(src).toHaveBeenCalledTimes(1);
  });

  it('is bounded by KS_LIST_MAX_PAGES when KS keeps returning data', async () => {
    const src = vi.fn(async () => ({ items: [1], total: Number.MAX_SAFE_INTEGER }));
    await fetchAllKsPages(src);
    expect(src).toHaveBeenCalledTimes(KS_LIST_MAX_PAGES);
  });
});

describe('fetchKsOnlyItems', () => {
  it('returns wiki items beyond the first 20', async () => {
    const wikis = Array.from({ length: 30 }, (_, i) => ({ wiki_id: `w${i}`, name: `n${i}`, status: 'ready', team_id: 't' }));
    const kc = {
      wikiList: vi.fn(async (_team: string, opts?: { limit?: number; offset?: number }) => {
        const limit = opts?.limit ?? 20;
        const offset = opts?.offset ?? 0;
        return { items: wikis.slice(offset, offset + limit), total: wikis.length };
      }),
    } as any;
    const items = await fetchKsOnlyItems(kc, 't', 'llm_wiki');
    expect(items.map((i) => i.knowledge_id)).toEqual(wikis.map((w) => w.wiki_id));
  });
});

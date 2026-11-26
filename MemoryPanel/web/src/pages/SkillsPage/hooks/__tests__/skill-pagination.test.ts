/**
 * listAllSkills 用例。
 *
 * 覆盖 fixed tab 从「只取第一页 200 条」改为「循环翻完全部分页」后的契约：
 *   1. 按 total 翻到最后一页，offset 依次推进；
 *   2. 空页 / 整页重复必须立刻退出（防死循环）；
 *   3. 触达 maxItems 返回 truncated；
 *   4. 任意一页失败不抛错，保留已取到的页；
 *   5. 被更新的 refresh 取代时返回 stale 且不交出数据。
 */
import { describe, expect, it, vi } from 'vitest';
import type { ListSkillResult, SkillSummary } from '@/lib/api/skill-api';
import { listAllSkills, SKILL_MAX_ITEMS, SKILL_PAGE_SIZE } from '../skill-pagination';

function makeSkill(id: string): SkillSummary {
  return {
    skill_id: id,
    name: `skill-${id}`,
    description: '',
    version: 1,
    is_head: true,
    status: 'active',
    owner_user_id: 'user_1',
    owner_agent_id: 'agent_1',
    team_id: 'team_1',
    task_id: '',
    created_at_ms: 0,
    updated_at_ms: 0,
  };
}

/** 按 offset/limit 切出一页，模拟服务端行为（total = 全量条数）。 */
function pagedSource(ids: string[]) {
  return vi.fn(
    async ({ limit, offset }: { limit: number; offset: number }): Promise<ListSkillResult> => ({
      items: ids.slice(offset, offset + limit).map(makeSkill),
      total: ids.length,
    }),
  );
}

const range = (count: number, prefix = 'sk'): string[] =>
  Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(4, '0')}`);

describe('listAllSkills', () => {
  it('总数不超过一页时只请求一次', async () => {
    const fetchPage = pagedSource(range(3));
    const result = await listAllSkills(fetchPage);

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result.items.map((s) => s.skill_id)).toEqual(range(3));
    expect(result.total).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.stale).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('总数 450 时分三页取全，offset 依次为 0 / 200 / 400', async () => {
    const ids = range(450);
    const fetchPage = pagedSource(ids);
    const result = await listAllSkills(fetchPage);

    expect(SKILL_PAGE_SIZE).toBe(200);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(fetchPage.mock.calls.map(([page]) => page)).toEqual([
      { limit: 200, offset: 0 },
      { limit: 200, offset: 200 },
      { limit: 200, offset: 400 },
    ]);
    expect(result.items).toHaveLength(450);
    expect(result.total).toBe(450);
    expect(result.truncated).toBe(false);
  });

  it('后端返回空页但 total 仍大于已取数时立即停止', async () => {
    const fetchPage = vi.fn(async (): Promise<ListSkillResult> => ({ items: [], total: 999 }));
    const result = await listAllSkills(fetchPage);

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result.items).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('后端整页重复时立即停止，不会死循环', async () => {
    const dupPage: ListSkillResult = { items: [makeSkill('sk1'), makeSkill('sk2')], total: 100 };
    const fetchPage = vi.fn(async (): Promise<ListSkillResult> => dupPage);
    const result = await listAllSkills(fetchPage);

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(result.items.map((s) => s.skill_id)).toEqual(['sk1', 'sk2']);
  });

  it('跨页重复的 skill_id 被去重且不重复计数', async () => {
    const pages: Record<number, ListSkillResult> = {
      0: { items: [makeSkill('a'), makeSkill('b')], total: 4 },
      2: { items: [makeSkill('b'), makeSkill('c')], total: 4 },
      4: { items: [makeSkill('d')], total: 4 },
    };
    const fetchPage = vi.fn(async ({ offset }: { limit: number; offset: number }) => pages[offset]);
    const result = await listAllSkills(fetchPage, { pageSize: 2 });

    expect(result.items.map((s) => s.skill_id)).toEqual(['a', 'b', 'c', 'd']);
    expect(result.total).toBe(4);
  });

  it('触达 maxItems 时截断并标记 truncated', async () => {
    const fetchPage = pagedSource(range(100));
    const result = await listAllSkills(fetchPage, { pageSize: 2, maxItems: 3 });

    expect(result.items).toHaveLength(3);
    expect(result.total).toBe(100);
    expect(result.truncated).toBe(true);
  });

  it('默认上限为 2000 条', () => {
    expect(SKILL_MAX_ITEMS).toBe(2000);
  });

  it('第 2 页失败时保留第 1 页数据并返回 error', async () => {
    const failure = new Error('boom');
    const fetchPage = vi.fn(
      async ({ offset }: { limit: number; offset: number }): Promise<ListSkillResult> => {
        if (offset === 0) return { items: [makeSkill('a'), makeSkill('b')], total: 10 };
        throw failure;
      },
    );
    const result = await listAllSkills(fetchPage, { pageSize: 2 });

    expect(result.items.map((s) => s.skill_id)).toEqual(['a', 'b']);
    expect(result.error).toBe(failure);
    expect(result.stale).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it('第 1 页失败时 items 为空并返回 error', async () => {
    const failure = new Error('network down');
    const fetchPage = vi.fn(async (): Promise<ListSkillResult> => {
      throw failure;
    });
    const result = await listAllSkills(fetchPage);

    expect(result.items).toEqual([]);
    expect(result.error).toBe(failure);
  });

  it('一开始就 stale 时不发请求', async () => {
    const fetchPage = pagedSource(range(5));
    const result = await listAllSkills(fetchPage, { isStale: () => true });

    expect(fetchPage).not.toHaveBeenCalled();
    expect(result.stale).toBe(true);
    expect(result.items).toEqual([]);
  });

  it('取完第 1 页后变为 stale 时丢弃全部数据', async () => {
    let stale = false;
    const fetchPage = vi.fn(
      async ({ offset }: { limit: number; offset: number }): Promise<ListSkillResult> => {
        if (offset === 0) return { items: [makeSkill('a'), makeSkill('b')], total: 10 };
        return { items: [makeSkill('c'), makeSkill('d')], total: 10 };
      },
    );
    const result = await listAllSkills(fetchPage, {
      pageSize: 2,
      isStale: () => {
        // 第 1 页返回之后才变 stale（第 2 次请求前的那次检查会命中）
        const snapshot = stale;
        stale = true;
        return snapshot;
      },
    });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result.stale).toBe(true);
    expect(result.items).toEqual([]);
  });
});

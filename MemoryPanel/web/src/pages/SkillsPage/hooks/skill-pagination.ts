/**
 * skill-pagination —— fixed tab（按 agent 拉 skill）的分页聚合。
 *
 * 背景：数据面 `skill/list` 是分页接口，此前页面写死 `pagination: { limit: 200 }`
 * 只取第一页，agent 下 skill 超过 200 条时列表被静默截断，前端搜索也只能搜到
 * 已加载的 200 条。这里把「按 offset 翻完所有页」抽成独立纯函数，便于单测，
 * 也让 hook 侧只关心结果。
 *
 * 与服务端的约定（`SqliteSkillStore` 实测）：
 *   - `limit` 会被 clamp 到 [1, 1000]；
 *   - `total` 是**过滤后的全量条数**，不是当前页条数；
 *   - `offset` 语义正常。
 *
 * 本函数不抛错：分页中途失败时保留已取到的页，由调用方决定提示与降级。
 */
import type { ListSkillResult, SkillSummary } from '@/lib/api/skill-api';

/** 每页条数。与改动前的首屏请求一致，便于对比回归。 */
export const SKILL_PAGE_SIZE = 200;

/** 聚合上限（10 页）。防止后端 total 异常导致超长循环 / 内存膨胀。 */
export const SKILL_MAX_ITEMS = 2000;

export interface ListAllSkillsResult {
  /** 已去重、保持后端返回顺序的 skill 列表 */
  items: SkillSummary[];
  /** 服务端报告的全量条数 */
  total: number;
  /** 触达 maxItems 被截断 */
  truncated: boolean;
  /** 已被更新的 refresh 取代：调用方**不得**再 setState */
  stale: boolean;
  /** 中断分页的错误；此时 items 可能只含前几页数据 */
  error?: unknown;
}

export interface ListAllSkillsOptions {
  pageSize?: number;
  maxItems?: number;
  /** 竞态检查：每次请求前后各调用一次，为 true 表示本次结果已过期 */
  isStale?: () => boolean;
}

export async function listAllSkills(
  fetchPage: (page: { limit: number; offset: number }) => Promise<ListSkillResult>,
  options: ListAllSkillsOptions = {},
): Promise<ListAllSkillsResult> {
  const pageSize = options.pageSize ?? SKILL_PAGE_SIZE;
  const maxItems = options.maxItems ?? SKILL_MAX_ITEMS;
  const isStale = options.isStale;

  const items: SkillSummary[] = [];
  // offset 分页的两类边界：
  //   1) 期间有新 skill 写入 → 后一页可能重复返回前页末尾的条目（下面用 seen 去重）；
  //   2) 期间有更新导致排序变化 → 个别条目可能被跳过（offset 分页固有问题，
  //      彻底解决要换 cursor / 按 updated_at_ms 做 keyset 分页，暂不在本 PR 范围）。
  const seen = new Set<string>();
  let offset = 0;
  // 服务端给的 total 只在「明确是数字」时采信，且只增不减：
  // 若某页漏带 total（代理裁剪 / 接口变体），不能把已知总数覆盖成 0。
  let total = 0;

  for (;;) {
    if (isStale?.()) return { items: [], total, truncated: false, stale: true };

    let page: ListSkillResult;
    try {
      page = await fetchPage({ limit: pageSize, offset });
    } catch (error) {
      // 第 1 页失败 → items 为空；第 N 页失败 → 保留前 N-1 页，比整表清空更友好。
      return { items, total, truncated: false, stale: false, error };
    }

    if (isStale?.()) return { items: [], total, truncated: false, stale: true };

    const pageItems = page.items ?? [];
    if (typeof page.total === 'number' && Number.isFinite(page.total)) {
      total = Math.max(total, page.total);
    }

    let added = 0;
    for (const item of pageItems) {
      if (seen.has(item.skill_id)) continue;
      seen.add(item.skill_id);
      items.push(item);
      added += 1;
    }

    // 空页或整页重复：继续翻也不会新增，必须退出（否则后端忽略 offset 时会死循环）。
    if (added === 0) break;

    // 用实际返回条数推进，不假设后端一定给满页。
    offset += pageItems.length;

    // 退出条件二选一：
    //   - 知道总数：取满 total 即停；
    //   - 不知道总数（缺失 / 0）：用「短页 = 最后一页」兜底，
    //     不能直接按 total=0 退出，否则会退化成"只取首页"这个原始 bug。
    const reachedTotal = total > 0 ? items.length >= total : pageItems.length < pageSize;
    if (reachedTotal) break;

    if (items.length >= maxItems) {
      return { items: items.slice(0, maxItems), total, truncated: true, stale: false };
    }
  }

  return { items, total, truncated: false, stale: false };
}

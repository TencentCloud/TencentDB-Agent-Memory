/**
 * Claude Code AskUserQuestion 分页布局器。
 *
 * 背景：CC AskUserQuestion 单 question 最多 4 个 option。中间页需要留 1 个
 * slot 给"更多 →"，所以最多塞 3 个真实项；末页无 MORE，可塞满 4 个。
 *
 * 策略：
 *   - total ≤ 4：单页展示所有（无 MORE）
 *   - total > 4：前 N-1 页每页 3 个 + MORE，末页塞剩下的（∈ [2, 4]）
 *
 * 页数：`totalPages = ceil((total - 4) / 3) + 1`
 *   - 前 N-1 页各 3 项 = 3(N-1) 项
 *   - 末页 total - 3(N-1) 项
 *   - 反过来推 N：total - 3(N-1) ∈ [2, 4] ⇔ N - 1 = ceil((total - 4) / 3)
 *
 * 效果：
 *   total=4  → [4]                   （单页）
 *   total=5  → [3+MORE, 2]
 *   total=6  → [3+MORE, 3]
 *   total=7  → [3+MORE, 4]           ← 末页塞满 4，比"3+2+2"少 1 页
 *   total=8  → [3+MORE, 3+MORE, 2]
 *   total=9  → [3+MORE, 3+MORE, 3]
 *   total=10 → [3+MORE, 3+MORE, 4]   ← 末页塞满 4
 *   total=11 → [3+MORE, 3+MORE, 3+MORE, 2]
 *   total=13 → [3+MORE ×3, 4]
 *
 * 每页 count 恒定 ≥ 2 ≤ 4，永不 solo末页 —— init.ts 的 autoSelectSolo* 兜底
 * 分支从此进不到 MORE 翻页路径（total===1 的场景由 advanceFromAgentPicked 上
 * 游 auto-select，也走不到 form）。
 *
 * agents 和 tasks 共用同一分页，行为一致。
 */

/** CC AskUserQuestion 单 question 硬上限（含 MORE 槽位）。 */
export const CC_MAX_OPTIONS = 4;

/** 非末页真实选项数（保留 1 slot 给 MORE→）。 */
export const CC_PAGE_SIZE = 3;

/** 单页展示阈值：total ≤ 此值时不分页、不放 MORE，一页展示全部。 */
export const CC_SINGLE_PAGE_LIMIT = CC_MAX_OPTIONS;

export interface PageSlice {
  /** 该 page 覆盖的元素区间 [start, end)，start 含 end 不含 —— 直接 slice 用。 */
  start: number;
  end: number;
  /** 该 page 是否是最后一页（末页不追加 MORE 选项）。 */
  isLastPage: boolean;
  /** 该 page 展示的真实选项数（= end - start）。 */
  count: number;
  /** 分页后的总页数（total ≤ 4 时为 1）。 */
  totalPages: number;
  /** 全体元素数量，方便调用方拼提示文案。 */
  total: number;
}

/**
 * 计算给定 `total` 项、目标 `pageIndex`（0-based）的切片区间。
 *
 * 保证：任何合法的 pageIndex 返回的 `count >= 2`（除非 total < 2，此时是
 * form builder 上游的边界问题，非本函数职责）。
 *
 * pageIndex 超出 totalPages-1 时，钳制到最后一页（防御性；正常调用方会先
 * 用 totalPages-1 计算 safeNextPage，见 init.ts MORE 分支）。
 */
export function computePagination(total: number, pageIndex: number): PageSlice {
  const safeTotal = Math.max(0, total);

  // 单页阈值：≤ CC_SINGLE_PAGE_LIMIT 时不分页。
  if (safeTotal <= CC_SINGLE_PAGE_LIMIT) {
    return {
      start: 0,
      end: safeTotal,
      isLastPage: true,
      count: safeTotal,
      totalPages: 1,
      total: safeTotal,
    };
  }

  // total > 4 时：前 N-1 页各 3 real + MORE，末页塞 total - 3(N-1) 项（∈ [2, 4]）。
  // N - 1 页承载 3 每页需 ≥ (total - 4) 项（末页最多 4），即 N-1 = ceil((total-4) / 3)。
  const totalPages = Math.ceil((safeTotal - CC_MAX_OPTIONS) / CC_PAGE_SIZE) + 1;

  // 钳制 pageIndex 到合法范围（防御性）。
  const idx = Math.max(0, Math.min(pageIndex, totalPages - 1));

  const isLastPage = idx === totalPages - 1;
  const start = idx * CC_PAGE_SIZE;
  const end = isLastPage ? safeTotal : start + CC_PAGE_SIZE;

  return {
    start,
    end,
    isLastPage,
    count: end - start,
    totalPages,
    total: safeTotal,
  };
}

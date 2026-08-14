/**
 * Codex `request_user_input` 分页布局器 —— 结构照抄
 * `session/claude-code/pagination.ts`，只是 codex 的 option 上限跟 CC 不同：
 *
 * - codex 单 question 最多 **3 个** option（客户端会自动追加"其他"占 1 位，
 *   我们不能自己塞，所以实际能用 2 或 3 位）
 * - 中间页需要留 1 slot 给"MORE →"翻页 → 每页最多 2 real
 * - 末页无 MORE → 可塞满 3
 *
 * 策略：
 *   - total ≤ 3：单页展示所有（无 MORE）
 *   - total > 3：前 N-1 页每页 2 real + MORE，末页塞剩下的（∈ [2, 3]）
 *
 * 页数：`totalPages = ceil((total - 3) / 2) + 1`
 *   - 前 N-1 页各 2 real = 2(N-1) 项
 *   - 末页 total - 2(N-1) 项
 *
 * 效果：
 *   total=3  → [3]                   （单页）
 *   total=4  → [2+MORE, 2]
 *   total=5  → [2+MORE, 3]           ← 末页塞满 3，比"2+2+1"避免 solo
 *   total=6  → [2+MORE, 2+MORE, 2]
 *   total=7  → [2+MORE, 2+MORE, 3]
 *   total=8  → [2+MORE, 2+MORE, 2+MORE, 2]
 *
 * 每页 count 恒定 ≥ 2 ≤ 3，永不 solo 末页。
 *
 * 跟 CC 分页共用同一哲学，只是常量不同（3/2 vs 4/3）。agents 和 tasks
 * 都用这套。
 */

/** codex `request_user_input` 单 question option 硬上限（客户端"其他"槽独立）。 */
export const CODEX_MAX_OPTIONS = 3;

/** 非末页真实选项数（保留 1 slot 给 MORE→）。 */
export const CODEX_PAGE_SIZE = 2;

/** 单页阈值：total ≤ 此值时不分页、不放 MORE。 */
export const CODEX_SINGLE_PAGE_LIMIT = CODEX_MAX_OPTIONS;

export interface CodexPageSlice {
  /** 该 page 覆盖的元素区间 [start, end)。 */
  start: number;
  end: number;
  /** 该 page 是否是最后一页（末页不追加 MORE 选项）。 */
  isLastPage: boolean;
  /** 该 page 展示的真实选项数（= end - start）。 */
  count: number;
  /** 分页后的总页数（total ≤ 3 时为 1）。 */
  totalPages: number;
  /** 全体元素数量，方便调用方拼提示文案。 */
  total: number;
}

/**
 * 计算给定 `total` 项、目标 `pageIndex`（0-based）的切片区间。
 *
 * 保证：任何合法 pageIndex 返回 `count >= 2`（除非 total < 2 —— 边界由
 * 上游 form builder 兜底）。
 *
 * pageIndex 超出 totalPages-1 时钳制到最后一页（防御性；正常调用方会先
 * 用 totalPages-1 计算 safeNextPage）。
 */
export function computeCodexPagination(
  total: number,
  pageIndex: number,
): CodexPageSlice {
  const safeTotal = Math.max(0, total);

  if (safeTotal <= CODEX_SINGLE_PAGE_LIMIT) {
    return {
      start: 0,
      end: safeTotal,
      isLastPage: true,
      count: safeTotal,
      totalPages: 1,
      total: safeTotal,
    };
  }

  // total > 3 时：前 N-1 页各 2 real + MORE，末页塞 total - 2(N-1) 项（∈ [2, 3]）。
  const totalPages =
    Math.ceil((safeTotal - CODEX_MAX_OPTIONS) / CODEX_PAGE_SIZE) + 1;

  const idx = Math.max(0, Math.min(pageIndex, totalPages - 1));
  const isLastPage = idx === totalPages - 1;
  const start = idx * CODEX_PAGE_SIZE;
  const end = isLastPage ? safeTotal : start + CODEX_PAGE_SIZE;

  return {
    start,
    end,
    isLastPage,
    count: end - start,
    totalPages,
    total: safeTotal,
  };
}

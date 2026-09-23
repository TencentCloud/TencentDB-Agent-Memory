/**
 * text-pagination.ts — 文字模式独立分页.
 *
 * 与卡片模式（claude-code/pagination.ts）的差异：
 *   - 卡片模式：每页 3 项 real + 1 个 MORE 槽位（受 AskUserQuestion 硬上限 4 选项限制）
 *   - 文字模式：每页 10 项 real，无 MORE 槽位（markdown 无上限，靠 `next/prev` 关键字翻页）
 *
 * 复用 formData.pageIndex 字段：卡片模式和文字模式**永不共存**（能力探测决定走哪路），
 * 因此同一个 pageIndex 字段两边各自使用即可，无需引入 textPageIndex。
 *
 * 边界：
 *   - items 为空 → currentPageItems = [], totalPages = 1, isEmpty = true
 *   - pageIndex 越界（负数 / 超尾）→ clamp 到 [0, totalPages-1]，不抛
 */

// ── Constants ──────────────────────────────────────────────────────────────────

/** 文字模式每页显示的选项数（不含 next/prev/skip 等关键字操作提示）。 */
export const TEXT_PAGE_SIZE = 10;

// ── Types ──────────────────────────────────────────────────────────────────────

export interface TextPagination<T> {
  /** 当前页要渲染的 items（可能是 items 全量的子集）。 */
  currentPageItems: T[];
  /** 总页数（items 为空时约定 1，方便渲染层显示"第 1 页 / 共 1 页"）。 */
  totalPages: number;
  /** 当前页码（0-based，clamp 到合法范围）。 */
  currentPageIndex: number;
  /** items 是否为空。 */
  isEmpty: boolean;
  /** 是否还有下一页（用于渲染 `next` 关键字提示）。 */
  hasNext: boolean;
  /** 是否还有上一页（用于渲染 `prev` 关键字提示）。 */
  hasPrev: boolean;
  /** 当前页首个 item 在 items 里的绝对序号（0-based，用于渲染编号）。 */
  offset: number;
}

// ── Compute ────────────────────────────────────────────────────────────────────

/**
 * 计算文字模式分页信息。
 *
 * @param items      - 完整 items 列表
 * @param pageIndex  - 请求的页码（0-based，可能越界，内部会 clamp）
 * @param pageSize   - 每页大小，默认 TEXT_PAGE_SIZE
 */
export function computeTextPagination<T>(
  items: readonly T[],
  pageIndex = 0,
  pageSize: number = TEXT_PAGE_SIZE,
): TextPagination<T> {
  const total = items.length;
  const safePageSize = Math.max(1, pageSize | 0);
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));

  const rawIdx = Number.isFinite(pageIndex) ? Math.trunc(pageIndex) : 0;
  const currentPageIndex = Math.max(0, Math.min(rawIdx, totalPages - 1));

  const offset = currentPageIndex * safePageSize;
  const currentPageItems = items.slice(offset, offset + safePageSize);

  return {
    currentPageItems,
    totalPages,
    currentPageIndex,
    isEmpty: total === 0,
    hasNext: currentPageIndex < totalPages - 1,
    hasPrev: currentPageIndex > 0,
    offset,
  };
}

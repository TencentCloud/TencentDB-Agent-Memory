/**
 * Take the leading slice of `sorted` (ascending updatedAt) within the record
 * and character budgets. Always takes at least one record, and never cuts
 * between records that share an updatedAt (the L2 cursor is a strict `>`).
 */
export function sliceL2Batch<T extends { updatedAt: string; content: string }>(
  sorted: T[],
  maxRecords: number,
  maxChars: number,
): T[] {
  let end = 0;
  let chars = 0;
  while (end < sorted.length) {
    const next = sorted[end]!;
    if (end > 0 && (end >= maxRecords || chars + next.content.length > maxChars)) break;
    chars += next.content.length;
    end++;
  }
  while (end < sorted.length && end > 0 && sorted[end]!.updatedAt === sorted[end - 1]!.updatedAt) end++;
  return sorted.slice(0, end);
}

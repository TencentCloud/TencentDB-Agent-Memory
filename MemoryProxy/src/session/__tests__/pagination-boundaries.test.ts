import { describe, expect, it } from "vitest";
import { computeCodexPagination } from "../codex/pagination.js";
import { computePagination } from "../claude-code/pagination.js";

describe.each([
  { client: "Codex", paginate: computeCodexPagination, maxOptions: 3 },
  { client: "Claude Code", paginate: computePagination, maxOptions: 4 },
])("$client option pagination", ({ paginate, maxOptions }) => {
  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 13, 100])(
    "covers every item exactly once without exceeding option slots (total=%i)", (total) => {
      const first = paginate(total, 0);
      const covered: number[] = [];
      for (let index = 0; index < first.totalPages; index++) {
        const page = paginate(total, index);
        expect(page.count + (page.isLastPage ? 0 : 1)).toBeLessThanOrEqual(maxOptions);
        expect(page.isLastPage).toBe(index === first.totalPages - 1);
        if (total > maxOptions) expect(page.count).toBeGreaterThanOrEqual(2);
        for (let item = page.start; item < page.end; item++) covered.push(item);
      }
      expect(covered).toEqual(Array.from({ length: total }, (_, index) => index));
    },
  );

  it("clamps stale page indexes to the first or final valid page", () => {
    const first = paginate(13, 0);
    expect(paginate(13, -1)).toEqual(first);
    expect(paginate(13, 100)).toEqual(paginate(13, first.totalPages - 1));
  });

  it("normalizes a negative total into an empty page", () => {
    expect(paginate(-1, 0)).toEqual({
      start: 0, end: 0, count: 0, total: 0, totalPages: 1, isLastPage: true,
    });
  });
});

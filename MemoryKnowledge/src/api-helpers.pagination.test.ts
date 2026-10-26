import { describe, it, expect } from "vitest";
import { clampListPagination } from "./api-helpers.js";

describe("clampListPagination", () => {
  it("clamps limit into [1,100] with default 20", () => {
    expect(clampListPagination({ limit: 1e9 }).limit).toBe(100);
    expect(clampListPagination({ limit: 0 }).limit).toBe(1);
    expect(clampListPagination({ limit: -5 }).limit).toBe(1);
    expect(clampListPagination({ limit: 2.7 }).limit).toBe(2);
    expect(clampListPagination({}).limit).toBe(20);
    expect(clampListPagination({ limit: "x" }).limit).toBe(20);
    expect(clampListPagination({ limit: NaN }).limit).toBe(20);
    expect(clampListPagination(undefined).limit).toBe(20);
    expect(clampListPagination({ limit: 50 }).limit).toBe(50);
  });
  it("clamps offset to integer >= 0 with default 0", () => {
    expect(clampListPagination({ offset: -3 }).offset).toBe(0);
    expect(clampListPagination({ offset: 4.9 }).offset).toBe(4);
    expect(clampListPagination({}).offset).toBe(0);
    expect(clampListPagination({ offset: "x" }).offset).toBe(0);
    expect(clampListPagination({ offset: Infinity }).offset).toBe(0);
    expect(clampListPagination({ offset: 40 }).offset).toBe(40);
  });
});

import { describe, expect, it } from "vitest";

import { randomBase62 } from "./short-id.js";

const BASE62 = /^[0-9A-Za-z]+$/;

describe("randomBase62", () => {
  it("returns a base62 string of the requested length", () => {
    for (const len of [1, 8, 12, 32, 128]) {
      const id = randomBase62(len);
      expect(id).toHaveLength(len);
      expect(BASE62.test(id)).toBe(true);
    }
  });

  it("rejects non-positive or non-integer lengths", () => {
    for (const len of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => randomBase62(len)).toThrow(RangeError);
    }
  });

  it("produces independent values across calls", () => {
    const ids = new Set(Array.from({ length: 50 }, () => randomBase62(12)));
    expect(ids.size).toBe(50);
  });

  it("uses the full alphabet over a large sample", () => {
    const sample = randomBase62(4096);
    const distinct = new Set(sample).size;
    expect(distinct).toBeGreaterThan(55);
  });
});

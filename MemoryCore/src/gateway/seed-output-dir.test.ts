import { describe, it, expect } from "vitest";
import { makeSeedOutputDir } from "./seed-output-dir.js";

describe("makeSeedOutputDir", () => {
  it("keeps the sortable timestamp prefix under baseDir", () => {
    const now = new Date(2026, 0, 5, 9, 8, 7); // 2026-01-05 09:08:07 local
    const dir = makeSeedOutputDir("/data/memory", now);
    expect(dir).toMatch(/^\/data\/memory\/seed-20260105-090807-[0-9a-f]{8}$/);
  });

  it("produces different dirs for two seeds in the same second", () => {
    const now = new Date(2026, 5, 15, 12, 0, 0);
    const a = makeSeedOutputDir("/data", now);
    const b = makeSeedOutputDir("/data", now);
    expect(a).not.toBe(b);
    // Same timestamp portion — only the uuid suffix differs.
    expect(a.slice(0, -8)).toBe(b.slice(0, -8));
  });
});

import { describe, expect, it } from "vitest";
import {
  JEV_STATE_LIMIT_CHARS_DEFAULT,
  resolveJevOverflowPolicy,
  resolveJevStateLimit,
  trimJevStateForLimit,
  type JevStatePayload,
} from "./jev-state-trim.js";

const scene = (filename: string, content: string, summary = `summary:${filename}`) => ({
  filename,
  summary,
  updated: "2026-10-16T00:00:00.000Z",
  content,
});

describe("resolveJevStateLimit", () => {
  it("defaults to 32000 when unset", () => {
    expect(JEV_STATE_LIMIT_CHARS_DEFAULT).toBe(32_000);
    expect(resolveJevStateLimit({})).toBe(32_000);
  });

  it("honors a positive integer override", () => {
    expect(resolveJevStateLimit({ JEV_STATE_LIMIT_CHARS: "45000" })).toBe(45_000);
    expect(resolveJevStateLimit({ JEV_STATE_LIMIT_CHARS: " 1200 " })).toBe(1_200);
  });

  it("falls back to the default on invalid values", () => {
    for (const raw of ["0", "-5", "abc", "12.5", "3e4", "0x10", ""]) {
      expect(resolveJevStateLimit({ JEV_STATE_LIMIT_CHARS: raw })).toBe(32_000);
    }
  });
});

describe("resolveJevOverflowPolicy", () => {
  it("defaults to defer", () => {
    expect(resolveJevOverflowPolicy({})).toBe("defer");
    expect(resolveJevOverflowPolicy({ JEV_STATE_OVERFLOW_POLICY: "nonsense" })).toBe("defer");
  });

  it("accepts trim case-insensitively", () => {
    expect(resolveJevOverflowPolicy({ JEV_STATE_OVERFLOW_POLICY: "trim" })).toBe("trim");
    expect(resolveJevOverflowPolicy({ JEV_STATE_OVERFLOW_POLICY: " TRIM " })).toBe("trim");
    expect(resolveJevOverflowPolicy({ JEV_STATE_OVERFLOW_POLICY: "Trim" })).toBe("trim");
  });
});

describe("trimJevStateForLimit", () => {
  it("returns the original state untouched when it already fits", () => {
    const payload: JevStatePayload = {
      current_persona: "hello",
      changed_scenes: [scene("a.md", "world")],
    };
    const res = trimJevStateForLimit(payload, 10_000);
    expect(res).not.toBeNull();
    expect(res!.trimmedChars).toBe(0);
    expect(res!.trimmedScenes).toEqual([]);
    expect(res!.state).toBe(JSON.stringify(payload));
  });

  it("truncates the largest scene (head+tail kept) until the payload fits", () => {
    const payload: JevStatePayload = {
      current_persona: "P".repeat(500),
      changed_scenes: [
        scene("small.md", "S".repeat(200)),
        scene("big.md", "HEAD" + "X".repeat(20_000) + "TAIL"),
      ],
    };
    const limit = 4_000;
    const res = trimJevStateForLimit(payload, limit);
    expect(res).not.toBeNull();
    expect(res!.state.length).toBeLessThanOrEqual(limit);
    expect(res!.trimmedScenes).toEqual(["big.md"]);
    // Every scene entry survives; only the oversized content is shortened.
    expect(res!.state).toContain("small.md");
    expect(res!.state).toContain("summary:big.md");
    // The untouched small scene keeps its full content.
    expect(res!.state).toContain("S".repeat(200));
    // Head and tail of the big scene survive, with an inline marker between.
    expect(res!.state).toContain("HEAD");
    expect(res!.state).toContain("TAIL");
    expect(res!.state).toContain("[... truncated");
    expect(res!.trimmedChars).toBeGreaterThan(15_000);
  });

  it("falls back to null when even emptied contents cannot fit the limit", () => {
    const payload: JevStatePayload = {
      current_persona: "P".repeat(50_000),
      changed_scenes: [scene("a.md", "x".repeat(10))],
    };
    expect(trimJevStateForLimit(payload, 1_000)).toBeNull();
  });

  it("keeps scene order and can shrink multiple oversized scenes", () => {
    const payload: JevStatePayload = {
      current_persona: "p",
      changed_scenes: [
        scene("a.md", "A".repeat(10_000)),
        scene("b.md", "B".repeat(10_000)),
        scene("c.md", "C".repeat(10)),
      ],
    };
    const limit = 3_000;
    const res = trimJevStateForLimit(payload, limit);
    expect(res).not.toBeNull();
    expect(res!.state.length).toBeLessThanOrEqual(limit);
    const parsed = JSON.parse(res!.state) as JevStatePayload;
    expect(parsed.changed_scenes.map((s) => s.filename)).toEqual(["a.md", "b.md", "c.md"]);
    expect(parsed.changed_scenes[2].content).toBe("C".repeat(10));
    expect([...res!.trimmedScenes].sort()).toEqual(["a.md", "b.md"]);
  });
});

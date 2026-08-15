import { describe, expect, it } from "vitest";

import type { SceneIndexEntry } from "./scene-index.js";
import {
  generateSceneNavigation,
  getSceneNavigationHeatBucket,
  getSceneNavigationRecencyBucket,
  scoreSceneForNavigation,
  selectTopScenesForNavigation,
} from "./scene-navigation.js";

function scene(filename: string, overrides: Partial<SceneIndexEntry> = {}): SceneIndexEntry {
  return {
    filename,
    summary: `summary for ${filename}`,
    heat: 1,
    created: "2026-07-01T00:00:00.000Z",
    updated: "2026-07-11T00:00:00.000Z",
    ...overrides,
  };
}

describe("scene navigation", () => {
  it("limits output to top N scenes by default", () => {
    const entries = Array.from({ length: 8 }, (_, i) => scene(`scene-${i}.md`, { heat: 80 - i }));

    const output = generateSceneNavigation(entries, "D:\\memory");

    expect(output).toContain("Showing top 5 scenes out of 8.");
    expect((output.match(/### Path:/g) ?? []).length).toBe(5);
    expect(output).toContain("Additional scenes omitted");
  });

  it("calculates heat buckets", () => {
    expect(getSceneNavigationHeatBucket(0)).toBe(0);
    expect(getSceneNavigationHeatBucket(1)).toBe(1);
    expect(getSceneNavigationHeatBucket(9)).toBe(1);
    expect(getSceneNavigationHeatBucket(10)).toBe(2);
    expect(getSceneNavigationHeatBucket(29)).toBe(3);
    expect(getSceneNavigationHeatBucket(30)).toBe(4);
  });

  it("calculates recency buckets", () => {
    const now = new Date("2026-07-11T12:00:00+08:00");

    expect(getSceneNavigationRecencyBucket("2026-07-11T01:00:00+08:00", now)).toBe(3);
    expect(getSceneNavigationRecencyBucket("2026-07-10T23:00:00+08:00", now)).toBe(2);
    expect(getSceneNavigationRecencyBucket("2026-07-10T11:00:00+08:00", now)).toBe(1);
    expect(getSceneNavigationRecencyBucket("2026-07-03T12:00:00+08:00", now)).toBe(0);
    expect(getSceneNavigationRecencyBucket("not-a-date", now)).toBe(0);
    expect(getSceneNavigationRecencyBucket("", now)).toBe(0);
  });

  it("uses filename as a stable tie breaker", () => {
    const now = new Date("2026-07-11T12:00:00+08:00");
    const selected = selectTopScenesForNavigation([
      scene("b.md", { heat: 10, updated: "2026-07-11T01:00:00+08:00" }),
      scene("a.md", { heat: 10, updated: "2026-07-11T01:00:00+08:00" }),
    ], { now, topN: 2 });

    expect(selected.map((entry) => entry.filename)).toEqual(["a.md", "b.md"]);
  });

  it("keeps order stable for small changes that do not cross buckets", () => {
    const beforeNow = new Date("2026-07-11T12:00:00+08:00");
    const afterNow = new Date("2026-07-11T13:00:00+08:00");
    const before = [
      scene("a.md", { heat: 21, updated: "2026-07-11T02:00:00+08:00" }),
      scene("b.md", { heat: 21, updated: "2026-07-11T02:00:00+08:00" }),
    ];
    const after = [
      scene("a.md", { heat: 29, updated: "2026-07-11T02:00:00+08:00" }),
      scene("b.md", { heat: 29, updated: "2026-07-11T02:00:00+08:00" }),
    ];

    expect(selectTopScenesForNavigation(before, { now: beforeNow, topN: 2 }).map((entry) => entry.filename))
      .toEqual(selectTopScenesForNavigation(after, { now: afterNow, topN: 2 }).map((entry) => entry.filename));
  });

  it("changes score when heat crosses a bucket", () => {
    const now = new Date("2026-07-11T12:00:00+08:00");
    const before = scoreSceneForNavigation(scene("a.md", { heat: 29 }), now);
    const after = scoreSceneForNavigation(scene("a.md", { heat: 30 }), now);

    expect(after - before).toBe(10);
  });

  it("truncates at scene block boundaries", () => {
    const output = generateSceneNavigation([
      scene("a.md", { heat: 100, summary: "a".repeat(120) }),
      scene("b.md", { heat: 90, summary: "b".repeat(120) }),
      scene("c.md", { heat: 80, summary: "c".repeat(120) }),
    ], undefined, { maxChars: 650 });

    expect(output.length).toBeLessThanOrEqual(650);
    expect(output).toContain("Additional scenes omitted");
  });
});

import { describe, expect, it } from "vitest";

import {
  applyRecallBudgetToItems,
  buildStableRecallContext,
  canonicalSortRecallItems,
  formatRecallDisplayItem,
  type RecallDisplayItem,
} from "./auto-recall.js";

function item(overrides: Partial<RecallDisplayItem> = {}): RecallDisplayItem {
  return {
    recordId: "record-a",
    type: "episodic",
    priority: 50,
    sceneName: "scene-a",
    content: "content",
    score: 0.5,
    ...overrides,
  };
}

describe("canonical recall ordering", () => {
  it("returns the same order for the same item set in different input orders", () => {
    const a = item({ recordId: "a", type: "episodic", sceneName: "s2" });
    const b = item({ recordId: "b", type: "instruction", sceneName: "s1" });
    const c = item({ recordId: "c", type: "persona", sceneName: "s3" });

    expect(canonicalSortRecallItems([c, a, b]).map((entry) => entry.recordId))
      .toEqual(canonicalSortRecallItems([b, c, a]).map((entry) => entry.recordId));
  });

  it("sorts by type rank before other keys", () => {
    const sorted = canonicalSortRecallItems([
      item({ recordId: "e", type: "episodic" }),
      item({ recordId: "p", type: "persona" }),
      item({ recordId: "i", type: "instruction" }),
    ]);

    expect(sorted.map((entry) => entry.recordId)).toEqual(["i", "p", "e"]);
  });

  it("uses priority, scene name, and record id as stable tie breakers", () => {
    const sorted = canonicalSortRecallItems([
      item({ recordId: "b", type: "episodic", priority: 50, sceneName: "same" }),
      item({ recordId: "c", type: "episodic", priority: 90, sceneName: "same" }),
      item({ recordId: "a", type: "episodic", priority: 50, sceneName: "same" }),
      item({ recordId: "d", type: "episodic", priority: 50, sceneName: "aaa" }),
    ]);

    expect(sorted.map((entry) => entry.recordId)).toEqual(["c", "d", "a", "b"]);
  });

  it("falls back to content hash when record id is missing", () => {
    const first = canonicalSortRecallItems([
      item({ recordId: "", content: "beta" }),
      item({ recordId: "", content: "alpha" }),
    ]).map(formatRecallDisplayItem);
    const second = canonicalSortRecallItems([
      item({ recordId: "", content: "alpha" }),
      item({ recordId: "", content: "beta" }),
    ]).map(formatRecallDisplayItem);

    expect(first).toEqual(second);
  });

  it("keeps budgeted output deterministic for the same item set", () => {
    const recall = {
      maxResults: 5,
      maxCharsPerMemory: 80,
      maxTotalRecallChars: 140,
      scoreThreshold: 0,
      strategy: "hybrid" as const,
      enabled: true,
      timeoutMs: 5000,
    };
    const a = item({ recordId: "a", type: "instruction", content: "a".repeat(120) });
    const b = item({ recordId: "b", type: "episodic", content: "b".repeat(120) });
    const c = item({ recordId: "c", type: "persona", content: "c".repeat(120) });

    const first = applyRecallBudgetToItems([c, a, b], recall).map(formatRecallDisplayItem);
    const second = applyRecallBudgetToItems([b, c, a], recall).map(formatRecallDisplayItem);

    expect(first).toEqual(second);
  });
});

describe("stable recall context ordering", () => {
  it("places tools guide before persona and scene navigation", () => {
    const context = buildStableRecallContext({
      personaContent: "persona",
      sceneNavigation: "scene navigation",
      hasDynamicRecall: true,
    });

    expect(context).toBeTruthy();
    expect(context).not.toContain("<relevant-memories>");
    expect(context!.indexOf("<memory-tools-guide>")).toBeLessThan(context!.indexOf("<user-persona>"));
    expect(context!.indexOf("<user-persona>")).toBeLessThan(context!.indexOf("<scene-navigation>"));
  });

  it("does not create stable context when nothing is available", () => {
    expect(buildStableRecallContext({ hasDynamicRecall: false })).toBeUndefined();
  });
});

import { describe, it, expect } from "vitest";
import {
  RecallCachePolicy,
  DEFAULT_CACHE_STABILITY,
  normalizeSystemContext,
  stableHash,
  type RecallItem,
} from "./recall-cache-policy.js";
import { generateSceneNavigation } from "../scene/scene-navigation.js";
import type { SceneIndexEntry } from "../scene/scene-index.js";

const SESSION = "s1";

function item(id: string, content = `content-${id}`): RecallItem {
  return { id, type: "episodic", content, line: `- [episodic] ${content}` };
}

describe("RecallCachePolicy.resolveSystemContext", () => {
  it("freezes the first revision and replays it byte-for-byte", () => {
    const p = new RecallCachePolicy();
    const first = p.resolveSystemContext(SESSION, "persona A", 1_000);
    expect(first.text).toBe("persona A");
    expect(first.reason).toBe("first-freeze");

    // A background pipeline rewrites the persona two turns later.
    p.beginTurn(SESSION, 1_100);
    const second = p.resolveSystemContext(SESSION, "persona B", 1_100);
    expect(second.text).toBe("persona A");
    expect(second.withheld).toBe(true);
    expect(second.reason).toBe("turn-gate-closed");
  });

  it("refreshes only when BOTH the turn and the time gate are open", () => {
    const p = new RecallCachePolicy({ systemContextRefreshTurns: 3, systemContextRefreshMs: 10_000 });
    p.resolveSystemContext(SESSION, "v1", 0);

    // Turns pass but not enough wall-clock time.
    for (let i = 0; i < 5; i++) p.beginTurn(SESSION, 100 * i);
    const tooSoon = p.resolveSystemContext(SESSION, "v2", 500);
    expect(tooSoon.text).toBe("v1");
    expect(tooSoon.reason).toBe("time-gate-closed");

    // Enough time as well → promote.
    const now = 20_000;
    const promoted = p.resolveSystemContext(SESSION, "v2", now);
    expect(promoted.text).toBe("v2");
    expect(promoted.refreshed).toBe(true);
    expect(promoted.reason).toBe("refresh-gates-open");
  });

  it("keeps serving the frozen revision when the fresh one is transiently empty", () => {
    const p = new RecallCachePolicy();
    p.resolveSystemContext(SESSION, "persona A", 0);
    const gone = p.resolveSystemContext(SESSION, undefined, 1);
    expect(gone.text).toBe("persona A");
    expect(gone.reason).toBe("fresh-empty-keep-frozen");
  });

  it("does not count trailing-whitespace churn as a change", () => {
    const p = new RecallCachePolicy();
    p.resolveSystemContext(SESSION, "line one\nline two", 0);
    const same = p.resolveSystemContext(SESSION, "line one   \nline two\n\n", 1);
    expect(same.reason).toBe("unchanged");
    expect(same.withheld).toBe(false);
  });

  it("is a pass-through when disabled", () => {
    const p = new RecallCachePolicy({ enabled: false });
    expect(p.resolveSystemContext(SESSION, "a", 0).text).toBe("a");
    expect(p.resolveSystemContext(SESSION, "b", 1).text).toBe("b");
  });

  it("isolates sessions from each other", () => {
    const p = new RecallCachePolicy();
    p.resolveSystemContext("a", "persona-a", 0);
    p.resolveSystemContext("b", "persona-b", 0);
    expect(p.resolveSystemContext("a", "changed", 1).text).toBe("persona-a");
    expect(p.resolveSystemContext("b", "changed", 1).text).toBe("persona-b");
  });
});

describe("RecallCachePolicy.filterMemories / commitInjected", () => {
  it("does not record anything until commitInjected is called", () => {
    const p = new RecallCachePolicy();
    const items = [item("m1"), item("m2")];

    // Preview twice — still nothing committed, so nothing is filtered.
    expect(p.filterMemories(SESSION, items).kept).toHaveLength(2);
    expect(p.filterMemories(SESSION, items).kept).toHaveLength(2);

    p.commitInjected(SESSION, ["m1"]);
    const after = p.filterMemories(SESSION, items);
    expect(after.kept.map((i) => i.id)).toEqual(["m2"]);
    expect(after.skippedIds).toEqual(["m1"]);
  });

  it("keeps a budget-dropped memory eligible for a later turn", () => {
    const p = new RecallCachePolicy();
    const items = [item("m1"), item("m2"), item("m3")];

    // Turn 1: recall 3, but the char budget only lets m1 through.
    const t1 = p.filterMemories(SESSION, items);
    p.commitInjected(SESSION, [t1.kept[0].id]);

    // Turn 2: m2 and m3 were never shown, so they must still be offered.
    const t2 = p.filterMemories(SESSION, items);
    expect(t2.kept.map((i) => i.id)).toEqual(["m2", "m3"]);
  });

  it("evicts FIFO once dedupMaxTracked is exceeded", () => {
    const p = new RecallCachePolicy({ dedupMaxTracked: 2 });
    p.commitInjected(SESSION, ["m1", "m2"]);
    expect(p.filterMemories(SESSION, [item("m1")]).kept).toHaveLength(0);

    p.commitInjected(SESSION, ["m3"]); // evicts m1
    expect(p.filterMemories(SESSION, [item("m1")]).kept).toHaveLength(1);
    expect(p.filterMemories(SESSION, [item("m3")]).kept).toHaveLength(0);
  });

  it("is a pass-through when dedup is disabled", () => {
    const p = new RecallCachePolicy({ dedupMemories: false });
    p.commitInjected(SESSION, ["m1"]);
    expect(p.filterMemories(SESSION, [item("m1")]).kept).toHaveLength(1);
  });
});

describe("RecallCachePolicy session lifecycle", () => {
  it("reset() forgets both the frozen context and the dedup set", () => {
    const p = new RecallCachePolicy();
    p.resolveSystemContext(SESSION, "persona A", 0);
    p.commitInjected(SESSION, ["m1"]);

    p.reset(SESSION);

    expect(p.hasFrozenSystemContext(SESSION)).toBe(false);
    expect(p.filterMemories(SESSION, [item("m1")]).kept).toHaveLength(1);
  });

  it("sweeps sessions idle beyond the TTL", () => {
    const p = new RecallCachePolicy({ sessionTtlMs: 1_000 });
    p.beginTurn("old", 0);
    expect(p.sessionCount).toBe(1);
    p.beginTurn("new", 5_000); // sweep runs on beginTurn
    expect(p.sessionCount).toBe(1);
    expect(p.hasFrozenSystemContext("old")).toBe(false);
  });

  it("exposes merged defaults", () => {
    const p = new RecallCachePolicy({ dedupMaxTracked: 7 });
    expect(p.options.dedupMaxTracked).toBe(7);
    expect(p.options.systemContextRefreshTurns).toBe(DEFAULT_CACHE_STABILITY.systemContextRefreshTurns);
  });
});

describe("helpers", () => {
  it("normalizeSystemContext collapses CRLF and trailing spaces", () => {
    expect(normalizeSystemContext("a  \r\nb\t\n\n")).toBe("a\nb");
  });

  it("stableHash is deterministic and 8 hex chars", () => {
    expect(stableHash("abc")).toBe(stableHash("abc"));
    expect(stableHash("abc")).toMatch(/^[0-9a-f]{8}$/);
    expect(stableHash("abc")).not.toBe(stableHash("abd"));
  });
});

describe("generateSceneNavigation stable rendering", () => {
  const scenes: SceneIndexEntry[] = [
    { filename: "b.md", summary: "S-b", heat: 120, created: "2026-01-01", updated: "2026-05-01" },
    { filename: "a.md", summary: "S-a", heat: 130, created: "2026-01-01", updated: "2026-05-02" },
  ];

  it("legacy mode changes bytes when heat or mtime moves", () => {
    const before = generateSceneNavigation(scenes, "/d");
    const bumped = scenes.map((s) =>
      s.filename === "a.md" ? { ...s, heat: s.heat + 1, updated: "2026-05-09" } : s,
    );
    expect(generateSceneNavigation(bumped, "/d")).not.toBe(before);
  });

  it("stable mode absorbs intra-tier heat bumps and mtime churn", () => {
    const before = generateSceneNavigation(scenes, "/d", { stable: true });
    const bumped = scenes.map((s) =>
      s.filename === "a.md" ? { ...s, heat: s.heat + 1, updated: "2026-05-09" } : s,
    );
    expect(generateSceneNavigation(bumped, "/d", { stable: true })).toBe(before);
  });

  it("stable mode still reorders when a scene crosses a tier boundary", () => {
    const before = generateSceneNavigation(scenes, "/d", { stable: true });
    const promoted = scenes.map((s) => (s.filename === "b.md" ? { ...s, heat: 600 } : s));
    expect(generateSceneNavigation(promoted, "/d", { stable: true })).not.toBe(before);
  });

  it("stable mode sorts deterministically within a tier", () => {
    const nav = generateSceneNavigation(scenes, "/d", { stable: true });
    expect(nav.indexOf("a.md")).toBeLessThan(nav.indexOf("b.md"));
    // Same tier, so swapping input order must not change the output.
    expect(generateSceneNavigation([...scenes].reverse(), "/d", { stable: true })).toBe(nav);
  });

  it("omits the raw counter and mtime in stable mode", () => {
    const nav = generateSceneNavigation(scenes, "/d", { stable: true });
    expect(nav).not.toContain("130");
    expect(nav).not.toContain("2026-05-02");
    expect(nav).toContain("**热度**: 中");
  });
});

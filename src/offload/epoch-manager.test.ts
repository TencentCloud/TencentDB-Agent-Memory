import { describe, expect, it } from "vitest";
import { createInitialCacheEpoch, shouldTransitionCacheEpoch, transitionCacheEpoch } from "./epoch-manager.js";

describe("cache epoch manager", () => {
  it("keeps append-only epochs below threshold", () => {
    const epoch = createInitialCacheEpoch({ snapshotHash: "h1", startedAtTurn: 1 });

    expect(shouldTransitionCacheEpoch(epoch, {
      totalTokens: 100,
      contextWindow: 1_000,
      currentTurn: 3,
      triggerRatio: 0.8,
      minimumTurns: 4,
    })).toBe(false);
  });

  it("creates a new frozen epoch when threshold and minimum turns are reached", () => {
    const epoch = createInitialCacheEpoch({ snapshotHash: "h1", startedAtTurn: 1 });
    const next = transitionCacheEpoch(epoch, {
      snapshotHash: "h2",
      compactedRange: { startTurn: 1, endTurn: 8 },
      currentTurn: 9,
    });

    expect(next.id).toBe(epoch.id + 1);
    expect(next.previousSnapshotHash).toBe("h1");
    expect(next.snapshotHash).toBe("h2");
    expect(next.compactedRanges).toEqual([{ startTurn: 1, endTurn: 8 }]);
  });
});

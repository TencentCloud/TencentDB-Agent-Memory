export interface CacheEpoch {
  id: number;
  snapshotHash: string;
  previousSnapshotHash?: string;
  startedAtTurn: number;
  compactedRanges: Array<{ startTurn: number; endTurn: number }>;
}

export function createInitialCacheEpoch(input: { snapshotHash: string; startedAtTurn?: number }): CacheEpoch {
  return {
    id: 1,
    snapshotHash: input.snapshotHash,
    startedAtTurn: input.startedAtTurn ?? 1,
    compactedRanges: [],
  };
}

export function shouldTransitionCacheEpoch(
  epoch: CacheEpoch,
  input: {
    totalTokens: number;
    contextWindow: number;
    currentTurn: number;
    triggerRatio: number;
    minimumTurns: number;
  },
): boolean {
  if (input.contextWindow <= 0) return false;
  const turnsInEpoch = input.currentTurn - epoch.startedAtTurn + 1;
  if (turnsInEpoch < input.minimumTurns) return false;
  return input.totalTokens / input.contextWindow >= input.triggerRatio;
}

export function transitionCacheEpoch(
  epoch: CacheEpoch,
  input: {
    snapshotHash: string;
    compactedRange: { startTurn: number; endTurn: number };
    currentTurn: number;
  },
): CacheEpoch {
  return {
    id: epoch.id + 1,
    previousSnapshotHash: epoch.snapshotHash,
    snapshotHash: input.snapshotHash,
    startedAtTurn: input.currentTurn,
    compactedRanges: [...epoch.compactedRanges, input.compactedRange],
  };
}

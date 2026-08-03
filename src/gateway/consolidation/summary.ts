/**
 * Initial-failed RunSummary factory.
 *
 * Shared by day-runner.ts and night-runner.ts (both start with status:
 * "failed" and grow the summary as the run progresses).
 */

import type { RunSummary } from "./types.js";

export function mkFailedSummary(
  role: string,
  startedAt: string,
  reason: string,
  dryRun: boolean | undefined,
): RunSummary {
  return {
    role,
    status: "failed",
    startedAt,
    finishedAt: startedAt,
    elapsedMs: 0,
    reason,
    dryRun: !!dryRun,
    newL0: 0,
    recordsPresented: 0,
    overLimitBlocks: 0,
    applied: { merges: [], deletes: [], rewrites: [] },
    skipped: { merges: [], deletes: [], rewrites: [] },
    reindexed: false,
    needsReindex: false,
  };
}

/**
 * Initial-failed RunSummary factory.
 *
 * Used by run-role.ts: a run starts as "failed" and grows the summary as it
 * progresses.
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

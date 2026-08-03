/**
 * busySummary — the failed RunSummary shape returned when the per-role gate
 * refuses an overlapping run of the same role.
 */
import type { RunSummary } from "./types.js";

export function busySummary(
  now: () => number,
  roleName: string,
  opts: { reason: string; dryRun?: boolean; runType?: string },
): RunSummary {
  const startedMs = now();
  return {
    role: opts.runType ?? roleName,
    status: "failed",
    startedAt: new Date(startedMs).toISOString(),
    finishedAt: new Date(startedMs).toISOString(),
    elapsedMs: 0,
    reason: opts.reason,
    dryRun: !!opts.dryRun,
    newL0: 0,
    recordsPresented: 0,
    overLimitBlocks: 0,
    applied: { merges: [], deletes: [], rewrites: [] },
    skipped: { merges: [], deletes: [], rewrites: [] },
    error: "another consolidation run is in flight (single-flight)",
    reindexed: false,
    needsReindex: false,
  };
}

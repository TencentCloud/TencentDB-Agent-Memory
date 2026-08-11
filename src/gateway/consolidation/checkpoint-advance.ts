/**
 * Checkpoint advance: cursor, counter and per-role stamp.
 *
 * Split out of queries.ts before tz-03a touches any of it — that file was at
 * 130 lines, and the package adds the A2 recompute, the runId marker and the
 * cross-process lock on top. Keeping the moved code identical here means the
 * later diffs read as changes, not as a relocation.
 */

import path from "node:path";
import { maxL0RecordedAt } from "./diff-builder.js";
import type { OrchestratorContext } from "./context.js";
import type { RunSummary } from "./types.js";
import type { RoleProgress } from "./checkpoint.js";

/** The per-role progress record after a run. A FAILED run keeps the previous
 * `lastRunAt` (it did not run successfully, so the dispatcher must retry) but
 * counts the failure, which is what bounds those retries. */
export function roleProgressAfterRun(
  prev: RoleProgress | undefined,
  summary: RunSummary,
): RoleProgress {
  const ok = summary.status === "ok";
  return {
    lastRunAt: ok ? summary.finishedAt : (prev?.lastRunAt ?? ""),
    recordsProcessed: summary.recordsPresented,
    overLimitBlocks: summary.overLimitBlocks,
    merges: ok ? summary.applied.merges.length : (prev?.merges ?? 0),
    rewrites: ok ? summary.applied.rewrites.length : (prev?.rewrites ?? 0),
    errors: ok ? 0 : 1,
    consecutiveFailures: ok ? 0 : (prev?.consecutiveFailures ?? 0) + 1,
    lastFailureAt: ok ? undefined : summary.finishedAt,
  };
}

/**
 * Stamp `roles[<role>].lastRunAt` for a run that did NOT advance the cursor
 * (an empty sweep, a refused apply). The dispatcher's per-role `ranToday`
 * asks "did this role run today", not "did it move the cursor" — without the
 * stamp a scheduled role with nothing to do would re-fire every tick.
 */
export async function stampRoleRun(
  ctx: OrchestratorContext,
  summary: RunSummary,
): Promise<void> {
  await ctx.checkpoint.update((d) => {
    d.roles[summary.role] = roleProgressAfterRun(
      d.roles[summary.role],
      summary,
    );
  });
}

/**
 * Advance the consolidation checkpoint.
 * Day: anchoredCursor omitted → cursor = current maxL0RecordedAt().
 * Night: anchoredCursor = max slice-time of applied chunks BEFORE the
 *   first skip-merge (anchored advance, plan #9).
 */
export async function advanceCheckpoint(
  ctx: OrchestratorContext,
  prevCursor: string,
  newL0: number,
  summary: RunSummary,
  anchoredCursor?: string,
): Promise<void> {
  const cursor = (anchoredCursor ??
    maxL0RecordedAt(path.join(ctx.dataDir, "vectors.db")))!;
  ctx.logger.debug?.(
    `[checkpoint] advance role=${summary.role} prev=${prevCursor} new=${cursor} newL0=${newL0} status=${summary.status}`,
  );
  await ctx.checkpoint.update((d) => {
    d.lastRunAt = summary.finishedAt;
    if (cursor && cursor >= prevCursor) d.l0Cursor = cursor;
    d.l0Count += newL0;
    d.roles[summary.role] = roleProgressAfterRun(
      d.roles[summary.role],
      summary,
    );
  });
}

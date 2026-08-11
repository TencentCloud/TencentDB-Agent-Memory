/**
 * Checkpoint advance: cursor, counter and per-role stamp.
 *
 * Split out of queries.ts before tz-03a touches any of it — that file was at
 * 130 lines, and the package adds the A2 recompute, the runId marker and the
 * cross-process lock on top. Keeping the moved code identical here means the
 * later diffs read as changes, not as a relocation.
 */

import path from "node:path";
import {
  countL0UpTo,
  cursorOfCheckpoint,
  maxL0RecordedAt,
  type L0Cursor,
} from "./diff-builder.js";
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
 * Order two cursor pairs. An unknown `recordId` ("") sorts before every real
 * id at the same timestamp, which is what makes a legacy cursor behave exactly
 * as it did when it was only a timestamp.
 */
export function cursorGte(a: L0Cursor, b: L0Cursor): boolean {
  if (a.recordedAt !== b.recordedAt) return a.recordedAt >= b.recordedAt;
  return a.recordId >= b.recordId;
}

/**
 * Advance the consolidation checkpoint.
 * Day: anchoredCursor omitted → cursor = current maxL0RecordedAt().
 * Night: anchoredCursor = max slice-time of applied chunks BEFORE the
 *   first skip-merge (anchored advance, plan #9).
 *
 * `prevCursor` is the snapshot this run started from. It is DIAGNOSTIC only —
 * the monotonicity guard reads the live value inside the mutation, because a
 * snapshot cannot see what another run wrote while this one was working.
 */
export async function advanceCheckpoint(
  ctx: OrchestratorContext,
  prevCursor: L0Cursor,
  newL0: number,
  summary: RunSummary,
  anchoredCursor?: L0Cursor,
): Promise<void> {
  const dbPath = path.join(ctx.dataDir, "vectors.db");
  const cursor = anchoredCursor ?? maxL0RecordedAt(dbPath);
  ctx.logger.debug?.(
    `[checkpoint] advance role=${summary.role} prev=${prevCursor.recordedAt}/${prevCursor.recordId} ` +
      `new=${cursor.recordedAt}/${cursor.recordId} newL0=${newL0} status=${summary.status}`,
  );
  await ctx.checkpoint.update((d) => {
    d.lastRunAt = summary.finishedAt;
    // The guard compares against the LIVE cursor, not against the snapshot
    // this run took when it started. Two runs overlap in real life — a night
    // run that started earlier finishes later with a smaller anchor, and
    // against its own stale snapshot that anchor looks like progress. The
    // cursor is monotone: max(live, candidate), never "whatever the last
    // writer happened to hold".
    const live = cursorOfCheckpoint(d);
    if (cursor.recordedAt && cursorGte(cursor, live)) {
      d.l0Cursor = cursor.recordedAt;
      d.l0CursorId = cursor.recordId;
    }
    // A2: the counter is RECOMPUTED from the store against the cursor that was
    // just written — not incremented. `+=` cannot shrink, so it drifted away
    // from the store silently on every TTL sweep, and it double-counted a run
    // that finalized twice. Counting inside the same locked mutation is what
    // keeps the pair (cursor, count) internally consistent: a count taken for
    // a cursor that was then rejected describes a checkpoint that never
    // existed. A failed count (null) leaves the previous value — an undercount
    // is acceptable, a zero that looks like fact is not.
    d.l0Count = countL0UpTo(dbPath, cursorOfCheckpoint(d)) ?? d.l0Count;
    d.roles[summary.role] = roleProgressAfterRun(
      d.roles[summary.role],
      summary,
    );
  });
}

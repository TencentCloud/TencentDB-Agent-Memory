/**
 * Public types for the run-batch pipeline.
 *
 * Split from runner.ts to keep that file ≤150 lines.
 */

import type { RecordEntry } from "./diff-builder.js";
import type { ResolvedRoleContract } from "./role-contract-types.js";

export interface RunBatchArgs {
  records: RecordEntry[];
  overLimit: Array<{ path: string; kind: string; size: number; limit: number }>;
  cp: { l0Cursor: string; lastRunAt: string | null };
  runId: string;
  role: string;
  dryRun: boolean;
  scratchDir: string;
  /** Resolved role contract — the ONLY source of run parameters (tz-01). */
  contract: ResolvedRoleContract;
  remainingDeleteCap: number;
  remainingRewriteCap: number;
  startedMs: number;
}

export interface RunBatchResult {
  presented: number;
  sliceTime: string | null;
  applied: { merges: string[]; deletes: string[]; rewrites: string[] };
  skipped: { merges: string[]; deletes: string[]; rewrites: string[] };
  /** Merge ops skipped because the TARGET is missing (cross-batch partner
   * deleted earlier) — the night anchor, NOT heal-skip. */
  skippedMergesMissingTarget: string[];
  /** True when this batch applied NOTHING (empty/heal-skip diff). */
  appliedNothing: boolean;
  deleteOps: number;
  rewriteOps: number;
  reindexed: boolean;
  needsReindex: boolean;
  child?: {
    exitCode: number | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
  };
  diffText?: string;
  error?: string;
  status?: string;
  /** Apply mutated the store and then aborted (tz-09 Ф2b): the difference
   * between "nothing happened, retry" and "reconcile before anything else". */
  partial?: boolean;
}

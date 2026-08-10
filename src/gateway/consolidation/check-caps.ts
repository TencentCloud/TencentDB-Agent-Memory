/**
 * Mechanical per-run caps check (chunked strategy).
 *
 * Budgets come from the role contract (`policy.caps`), not from the global
 * night config — tz-01 `contract-drives-execution`.
 *
 * Splits from runner-stages.ts to keep that file ≤150 lines. Returns
 * true on pass, false on overflow (with result.error + result.status
 * mutated to "failed").
 */

import type { RunBatchResult } from "./runner-types.js";

export function checkCaps(
  rawDiff: unknown,
  remainingDeleteCap: number,
  remainingRewriteCap: number,
  result: RunBatchResult,
): boolean {
  const diffObj = (rawDiff ?? {}) as Record<string, unknown>;
  const deleteOps = Array.isArray(diffObj.deleteL1)
    ? (diffObj.deleteL1 as unknown[]).length
    : 0;
  const mergeMembers = Array.isArray(diffObj.merge)
    ? (diffObj.merge as Array<{ cluster?: unknown[] }>).reduce(
        (acc: number, m) => acc + (m.cluster?.length ?? 0),
        0,
      )
    : 0;
  const rewriteOps = Array.isArray(diffObj.rewriteRecord)
    ? (diffObj.rewriteRecord as unknown[]).length
    : 0;
  result.deleteOps = deleteOps + mergeMembers;
  result.rewriteOps = rewriteOps;
  if (result.deleteOps > remainingDeleteCap) {
    result.error = `delete cap exceeded (batch deleteL1=${deleteOps} + mergeMembers=${mergeMembers} > remaining delete_per_run=${remainingDeleteCap}) — apply refused (mechanical gate)`;
    result.status = "failed";
    return false;
  }
  if (result.rewriteOps > remainingRewriteCap) {
    result.error = `rewrite cap exceeded (batch rewriteRecord=${rewriteOps} > remaining rewrite_per_run=${remainingRewriteCap}) — apply refused (mechanical gate)`;
    result.status = "failed";
    return false;
  }
  return true;
}

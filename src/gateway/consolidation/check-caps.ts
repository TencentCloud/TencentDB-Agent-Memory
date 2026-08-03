/**
 * Mechanical per-run caps check (night only).
 *
 * Splits from runner-stages.ts to keep that file ≤150 lines. Returns
 * true on pass, false on overflow (with result.error + result.status
 * mutated to "failed").
 */

import type { NightConsolidationConfig } from "../../config.js";
import type { RunBatchResult } from "./runner-types.js";

export function checkCaps(
  rawDiff: unknown,
  cap: NightConsolidationConfig,
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
    result.error = `night delete cap exceeded (batch deleteL1=${deleteOps} + mergeMembers=${mergeMembers} > remaining deleteCapPerRun=${remainingDeleteCap}) — apply refused (mechanical gate)`;
    result.status = "failed";
    return false;
  }
  if (result.rewriteOps > remainingRewriteCap) {
    result.error = `night rewrite cap exceeded (batch rewriteRecord=${rewriteOps} > remaining rewriteCapPerRun=${remainingRewriteCap}) — apply refused (mechanical gate)`;
    result.status = "failed";
    return false;
  }
  return true;
}

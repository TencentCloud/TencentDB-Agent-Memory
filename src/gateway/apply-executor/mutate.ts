/**
 * The mutation section of one apply (tz-09 Ф7).
 *
 * Split out of the apply-executor shim so the whole critical section has one
 * name: everything in here runs under the store-wide apply lock and between
 * the two control-plane transitions (`applying` → terminal). The ORDER is
 * also the canonical `opIndex` order of the journal (control-plane/oplog.ts)
 * — changing it here changes every operation id.
 */
import { applyMerges } from "./apply-ops-merge.js";
import { applyRewritesRecords } from "./apply-ops-record.js";
import { applyDeletes, applyRewrites } from "./apply-ops-rewrite.js";
import type { ApplyExecutorDeps } from "./apply-executor-deps.js";
import type { OnOp } from "./op-journal.js";
import type { ApplyDiff } from "./schemas.js";
import type { ApplyResult } from "./types.js";

export async function applyMutations(
  deps: ApplyExecutorDeps,
  diff: ApplyDiff,
  result: ApplyResult,
  onOp: OnOp | undefined,
): Promise<void> {
  await applyMerges(deps, diff.merge, result, onOp);
  await applyRewritesRecords(deps, diff.rewriteRecord, result, onOp);
  await applyDeletes(deps, diff.deleteL1, result, onOp);
  await applyRewrites(
    deps,
    diff.rewriteBlock,
    diff.rewritePersona,
    result,
    onOp,
  );
}

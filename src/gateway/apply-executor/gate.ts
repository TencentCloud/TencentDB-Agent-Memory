/**
 * The apply gate (tz-09 Ф3, criteria 4 and 5).
 *
 * ONE call site inside `apply()`, before any mutation: ops_subset first, then
 * the mechanical caps. In `shadow` every violation is logged and the apply
 * proceeds — that is how a day of real traffic is collected before the gate
 * is armed; in `enforce` the same violation throws and nothing is written.
 *
 * `assertOpsSubset` itself has existed since the factory wave and was never
 * reachable from apply() — see apply-executor.characterization.test.ts.
 */
import { assertOpsSubset } from "./validate.js";
import { ApplyValidationError } from "./errors.js";
import { countCapUsage, type RunContext } from "./run-context.js";
import type { ApplyDiff } from "./schemas.js";
import type { ApplyExecutorDeps } from "./apply-executor-deps.js";

/** @throws ApplyValidationError in `enforce` mode. */
export function runApplyGate(
  deps: ApplyExecutorDeps,
  diff: ApplyDiff,
  run: RunContext | undefined,
): void {
  if (run === undefined) return;
  const mode = run.gateMode ?? "shadow";
  const violations: string[] = [];

  if (run.opsSubset !== undefined) {
    try {
      assertOpsSubset(diff, run.opsSubset);
    } catch (err) {
      violations.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (run.caps !== undefined) {
    const used = countCapUsage(diff);
    if (used.deletes > run.caps.deletePerRun) {
      violations.push(
        `delete cap exceeded (${used.deletes} > delete_per_run=${run.caps.deletePerRun})`,
      );
    }
    if (used.rewrites > run.caps.rewritePerRun) {
      violations.push(
        `rewrite cap exceeded (${used.rewrites} > rewrite_per_run=${run.caps.rewritePerRun})`,
      );
    }
  }

  if (violations.length === 0) return;
  const detail = violations.join("; ");
  if (mode === "shadow") {
    deps.logger.warn?.(
      `[memory/apply] gate SHADOW (would refuse in enforce)` +
        `${run.runId === undefined ? "" : ` run=${run.runId}`}: ${detail}`,
    );
    return;
  }
  throw new ApplyValidationError(`apply gate refused: ${detail}`);
}

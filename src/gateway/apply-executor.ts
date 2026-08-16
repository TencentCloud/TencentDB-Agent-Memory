/**
 * ApplyExecutor — POST /memory/apply (wave tdai-memory-factory-2026-08-03,
 * Group A decomp). This shim composes the per-step modules in
 * `apply-executor/` and re-exports the public API.
 *
 * Module split (final, 14 files, each ≤150 lines):
 *   - apply-executor/types.ts              — ApplyCounts/ApplyResult/etc + re-exports ApplyOp/ApplyDiff
 *   - apply-executor/schemas.ts            — ApplyOp/ApplyDiff types + per-op zod ^4.4.3 schemas
 *   - apply-executor/errors.ts             — 4 typed errors (ApplyValidationError, …)
 *   - apply-executor/apply-executor-deps.ts — ApplyExecutorDeps interface
 *   - apply-executor/apply-helpers.ts      — resolveWithinDataDir, fetchMetaRows, writeBackup
 *   - apply-executor/apply-provenance.ts   — writeProvenanceRecord (merge + rewriteRecord share)
 *   - apply-executor/apply-route-helpers.ts — parseMetadata, hasApplied/hasMutated, atomicWrite (pure)
 *   - apply-executor/salvage.ts            — per-op shape salvage of the role's diff
 *   - apply-executor/validate.ts           — parseRequest + screenDiff + assertOpsSubset
 *   - apply-executor/manifest.ts           — checkManifest (trust-boundary recheck)
 *   - apply-executor/apply-ops-merge.ts    — applyMerges
 *   - apply-executor/apply-ops-record.ts   — applyRewritesRecords
 *   - apply-executor/apply-ops-rewrite.ts  — applyDeletes + applyRewrites (scene/persona)
 *   - apply-executor/verify-counts.ts      — vec-vs-meta reconciliation
 *   - apply-executor/apply-route.ts        — handleMemoryApply + syncSceneIndex
 *   - src/gateway/limits.ts                — SCENE, PERSONA, MAX, META_START, META_END constants
 */
import {
  parseRequest,
  screenDiff,
  assertOpsSubset,
} from "./apply-executor/validate.js";
import { isEmptyDiff, rejectionSummary } from "./apply-executor/salvage.js";
import { checkManifest } from "./apply-executor/manifest.js";
import { runApplyGate } from "./apply-executor/gate.js";
import { resolveRunPolicy } from "./apply-executor/run-policy.js";
import { touchedSlugs } from "./apply-executor/touched-slugs.js";
import { applyMutations } from "./apply-executor/mutate.js";
import { withStoreApplyLock } from "./apply-executor/store-lock.js";
import {
  enterApplying,
  journalFor,
  leaveApplying,
} from "./apply-executor/run-hooks.js";
import { syncSceneIndex } from "./apply-executor/apply-route.js";
import { verifyCounts } from "./apply-executor/verify-counts.js";
import {
  fetchMetaRows,
  resolveWithinDataDir,
} from "./apply-executor/apply-helpers.js";
import { hasMutated } from "./apply-executor/apply-route-helpers.js";
import { EMPTY_RESULT, type ApplyResult } from "./apply-executor/types.js";
import type { ApplyExecutorDeps } from "./apply-executor/apply-executor-deps.js";
import type { RunContext } from "./apply-executor/run-context.js";
import type { ApplyDiff } from "./apply-executor/schemas.js";
import { notifyCommitted } from "../core/record/commit-port.js";
import {
  ApplyRuntimeError,
  ApplyValidationError,
  ManifestDriftError,
  StaleDeleteError,
} from "./apply-executor/errors.js";

// Re-exports for backward compat — call-sites that import from "../apply-executor.js".
export {
  ApplyValidationError,
  ManifestDriftError,
  StaleDeleteError,
  ApplyRuntimeError,
} from "./apply-executor/errors.js";
export type {
  ApplyCounts,
  ApplyResult,
  ParsedApplyRequest,
  MetaRow,
  ApplyOp,
  ApplyDiff,
  RejectedOp,
} from "./apply-executor/types.js";
export type { ApplyExecutorDeps } from "./apply-executor/apply-executor-deps.js";
export { EMPTY_RESULT } from "./apply-executor/types.js";
export { assertOpsSubset } from "./apply-executor/validate.js";
export { countCapUsage } from "./apply-executor/run-context.js";
export type { RunContext, GateMode } from "./apply-executor/run-context.js";
export {
  handleMemoryApply,
  type ApplyRouteContext,
} from "./apply-executor/apply-route.js";
// Mechanical cap constants — tests (apply-executor.test.ts) and external
// callers import these from "../apply-executor.js" for assertions; re-export
// from limits.ts (the single source of truth for caps + META delimiters).
export {
  SCENE_LIMIT_CHARS,
  PERSONA_LIMIT_CHARS,
  MAX_REINDEX_RETRIES,
} from "./limits.js";

export class ApplyExecutor {
  private readonly deps: ApplyExecutorDeps;

  constructor(deps: ApplyExecutorDeps) {
    this.deps = deps;
  }

  /**
   * Validate + apply a raw request body. Never throws for expected failures —
   * returns an ApplyResult with status applied/aborted/failed and the HTTP
   * statusCode for aborts. Throws only on unexpected internal errors.
   */
  async apply(rawBody: unknown, run?: RunContext): Promise<ApplyResult> {
    const result = EMPTY_RESULT();
    // Visible to the catch path: whatever happens, the run must not be left
    // sitting in `applying` (tz-09 Ф7 — a wedged run has no way out).
    let scopedForFinish: RunContext | undefined;
    // Set only when THIS call opened the door — see leaveApplying.
    let entered = false;
    // Refusals are per-OPERATION (tz-#5): an op the guardrails will not run is
    // dropped and named here, and the rest of the diff still applies. Assigned
    // to the result before the first thing that can throw, so a request
    // refused mid-screen still reports what it had already refused.
    const rejected = result.rejected;
    try {
      // 1. zod on the envelope + per-op shape salvage of the diff.
      const parsed = parseRequest(rawBody, rejected);
      // 2. Semantic guardrails (DB reads) — before any mutation. Returns the
      //    ops that survived; `parsed.diff` must not be used past this line.
      const diff = await screenDiff(this.deps, parsed, rejected);
      for (const r of rejected) {
        this.deps.logger.warn?.(
          `[memory/apply] op refused ${r.section}[${r.ref}]: ${r.reason}`,
        );
      }
      // Every op refused is a failed run, not an empty success: a role whose
      // whole output is unusable must not look like one that found nothing.
      if (rejected.length > 0 && isEmptyDiff(diff)) {
        throw new ApplyValidationError(
          `every operation in the diff was refused: ${rejectionSummary(rejected)}`,
        );
      }
      // 2a. Run identity + policy (tz-09 Ф6): with runRepo on, an apply
      // without a live Run is refused here, and the policy the gate uses is
      // the Run's pinned contract, not what the caller passed.
      // The RAW diff, not `parsed.diff`: the critic digested the bytes the
      // child produced, and zod rebuilds objects in schema key order.
      const scoped = resolveRunPolicy(
        this.deps,
        run,
        (rawBody as { diff?: unknown } | null)?.diff,
      );
      // 2b. Role-scoped gate (tz-09 Ф3): ops_subset + mechanical caps. The
      // ONLY call site — a second one would be a way past it.
      scopedForFinish = scoped;
      runApplyGate(this.deps, diff, scoped);
      // 3-5. Critical section (tz-09 Ф7, tz-02 критерий 1a): the manifest
      // recheck, every mutation AND the index rebuild run under ONE
      // store-wide lock. The baseline is only worth rechecking while nobody
      // else can write between the check and the first mutation. Inside it,
      // the run passes through the single door into `applying`, so two
      // handlers of the same run cannot both mutate.
      //
      // The rebuild belongs inside for a reason of its own: two runs writing
      // DIFFERENT files of the same slug do not contend on any file, but they
      // do contend on that slug's index, which is written afterwards and
      // without an atomic swap — so outside the lock the later rebuild could
      // publish a snapshot taken before the earlier write.
      const onOp = journalFor(this.deps, diff, scoped);
      await withStoreApplyLock(this.deps.dataDir, async () => {
        checkManifest(this.deps, diff, parsed.manifest);
        entered = enterApplying(this.deps, scoped);
        await applyMutations(this.deps, diff, result, onOp);
        result.sceneIndexSynced = await syncSceneIndex(
          this.deps,
          touchedSlugs(diff),
        );
      });
      if (!result.sceneIndexSynced) {
        result.status = "failed";
        result.statusCode = 500;
        result.ok = false;
        result.error =
          "syncSceneIndex failed (files applied; scene_index.json rebuilds on the next /memory/validate)";
        return this.finish(result, scoped, entered);
      }

      // 6. Post-apply vec-vs-meta count check.
      const countsOk = await verifyCounts(this.deps, result);
      if (countsOk) {
        result.status = "applied";
        result.ok = true;
      } else {
        result.status = "failed";
        result.statusCode = 500;
        result.ok = false;
      }
      return this.finish(result, scoped, entered);
    } catch (err) {
      if (
        err instanceof ApplyValidationError ||
        err instanceof ManifestDriftError ||
        err instanceof StaleDeleteError ||
        err instanceof ApplyRuntimeError
      ) {
        result.error = err.message;
        result.partial = hasMutated(result);
        result.status = "aborted";
        result.statusCode = err.statusCode;
        return this.finish(result, scopedForFinish, entered);
      }
      // Unexpected — propagate to the HTTP layer (500 with raw message). The
      // run still has to leave `applying`: a raw throw from the store (a
      // SQLITE_BUSY out of deleteL1Batch, say) would otherwise wedge it as
      // surely as a typed one, and it is exactly the case where the store may
      // be half-written.
      result.partial = hasMutated(result);
      this.finish(result, scopedForFinish, entered);
      throw err;
    }
  }

  /** One exit for every path: the Run leaves `applying` for the state its
   * outcome earned. Skipping this on a failure would wedge the run — takeover
   * from `applying` is forbidden (P5) and the door refuses every later apply. */
  private finish(
    result: ApplyResult,
    run: RunContext | undefined,
    entered: boolean,
  ): ApplyResult {
    const mutated = hasMutated(result);
    leaveApplying(this.deps, run, { ok: result.ok, mutated, entered });
    // tz-03b: announced from the ONE exit, not from the success path — an
    // aborted apply mutated the store just as really as a successful one, and
    // the counters have to see it.
    if (mutated) {
      notifyCommitted({
        carrier: "l1",
        kind: "update",
        affected:
          result.applied.merges.length +
          result.applied.deletes.length +
          result.applied.rewrites.length,
        source: "apply",
        at: new Date().toISOString(),
      });
    }
    return result;
  }
}

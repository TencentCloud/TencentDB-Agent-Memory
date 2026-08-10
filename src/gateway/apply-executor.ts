/**
 * ApplyExecutor — POST /memory/apply (wave tdai-memory-factory-2026-08-03,
 * Group A decomp). This shim composes the per-step modules in
 * `apply-executor/` and re-exports the public API.
 *
 * Module split (final, 14 files, each ≤150 lines):
 *   - apply-executor/types.ts              — ApplyCounts/ApplyResult/etc + re-exports ApplyOp/ApplyDiff
 *   - apply-executor/schemas.ts            — ApplyOp/ApplyDiff types + 6 zod ^4.4.3 schemas
 *   - apply-executor/errors.ts             — 4 typed errors (ApplyValidationError, …)
 *   - apply-executor/apply-executor-deps.ts — ApplyExecutorDeps interface
 *   - apply-executor/apply-helpers.ts      — resolveWithinDataDir, fetchMetaRows, writeBackup
 *   - apply-executor/apply-provenance.ts   — writeProvenanceRecord (merge + rewriteRecord share)
 *   - apply-executor/apply-route-helpers.ts — parseMetadata, hasApplied, atomicWrite (pure)
 *   - apply-executor/validate.ts           — parseRequest + validateSemantics + assertOpsSubset
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
  validateSemantics,
  assertOpsSubset,
} from "./apply-executor/validate.js";
import { checkManifest } from "./apply-executor/manifest.js";
import { runApplyGate } from "./apply-executor/gate.js";
import { resolveRunPolicy } from "./apply-executor/run-policy.js";
import { countOps, createOpJournal } from "./apply-executor/op-journal.js";
import { applyMerges } from "./apply-executor/apply-ops-merge.js";
import { applyRewritesRecords } from "./apply-executor/apply-ops-record.js";
import {
  applyDeletes,
  applyRewrites,
} from "./apply-executor/apply-ops-rewrite.js";
import { syncSceneIndex } from "./apply-executor/apply-route.js";
import { verifyCounts } from "./apply-executor/verify-counts.js";
import {
  fetchMetaRows,
  resolveWithinDataDir,
} from "./apply-executor/apply-helpers.js";
import { hasApplied } from "./apply-executor/apply-route-helpers.js";
import { EMPTY_RESULT, type ApplyResult } from "./apply-executor/types.js";
import type { ApplyExecutorDeps } from "./apply-executor/apply-executor-deps.js";
import type { RunContext } from "./apply-executor/run-context.js";
import type { ApplyDiff } from "./apply-executor/schemas.js";
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
    try {
      // 1. zod validation (strict, readable errors) — before any mutation.
      const parsed = parseRequest(rawBody);
      // 2. Semantic guardrails (DB reads) — before any mutation.
      await validateSemantics(this.deps, parsed);
      // 2a. Run identity + policy (tz-09 Ф6): with runRepo on, an apply
      // without a live Run is refused here, and the policy the gate uses is
      // the Run's pinned contract, not what the caller passed.
      const scoped = resolveRunPolicy(
        this.deps.dataDir,
        run,
        this.deps.runRepo === true,
      );
      // 2b. Role-scoped gate (tz-09 Ф3): ops_subset + mechanical caps. The
      // ONLY call site — a second one would be a way past it.
      runApplyGate(this.deps, parsed.diff, scoped);
      // 3. Trust-boundary manifest recheck — before any mutation.
      checkManifest(this.deps, parsed);
      // 4. Mutations: writes (merge) → records (rewriteRecord) → deletes →
      // files. tz-09 Ф5: each one journals prepared/applied, so a crash in
      // the middle leaves a record of exactly how far the apply got. The
      // canonical opIndex order IS this call order (control-plane/oplog.ts).
      const onOp = this.journalFor(parsed.diff, scoped);
      await applyMerges(this.deps, parsed.diff.merge, result, onOp);
      await applyRewritesRecords(
        this.deps,
        parsed.diff.rewriteRecord,
        result,
        onOp,
      );
      await applyDeletes(this.deps, parsed.diff.deleteL1, result, onOp);
      await applyRewrites(
        this.deps,
        parsed.diff.rewriteBlock,
        parsed.diff.rewritePersona,
        result,
        onOp,
      );

      // 5. Scene index rebuild after file rewrites.
      result.sceneIndexSynced = await syncSceneIndex(this.deps);
      if (!result.sceneIndexSynced) {
        result.status = "failed";
        result.statusCode = 500;
        result.ok = false;
        result.error =
          "syncSceneIndex failed (files applied; scene_index.json rebuilds on the next /memory/validate)";
        return result;
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
      return result;
    } catch (err) {
      if (
        err instanceof ApplyValidationError ||
        err instanceof ManifestDriftError ||
        err instanceof StaleDeleteError ||
        err instanceof ApplyRuntimeError
      ) {
        result.error = err.message;
        result.partial = hasApplied(result);
        result.status = "aborted";
        result.statusCode = err.statusCode;
        return result;
      }
      // Unexpected — propagate to the HTTP layer (500 with raw message).
      throw err;
    }
  }

  /** A journal when the caller named a run, a no-op otherwise: a direct
   * apply (the pre-tz-09 call sites) has nothing to reconcile against. */
  private journalFor(diff: ApplyDiff, run: RunContext | undefined) {
    if (run?.runId === undefined || run.candidateDigest === undefined) {
      return undefined;
    }
    return createOpJournal(
      {
        dataDir: this.deps.dataDir,
        runId: run.runId,
        candidateDigest: run.candidateDigest,
        now: () => Date.now(),
      },
      countOps(diff),
    );
  }
}

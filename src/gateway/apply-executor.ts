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
import { parseRequest, validateSemantics, assertOpsSubset } from "./apply-executor/validate.js";
import { checkManifest } from "./apply-executor/manifest.js";
import { applyMerges } from "./apply-executor/apply-ops-merge.js";
import { applyRewritesRecords } from "./apply-executor/apply-ops-record.js";
import { applyDeletes, applyRewrites } from "./apply-executor/apply-ops-rewrite.js";
import { syncSceneIndex } from "./apply-executor/apply-route.js";
import { verifyCounts } from "./apply-executor/verify-counts.js";
import { fetchMetaRows, resolveWithinDataDir } from "./apply-executor/apply-helpers.js";
import { hasApplied } from "./apply-executor/apply-route-helpers.js";
import { EMPTY_RESULT, type ApplyResult } from "./apply-executor/types.js";
import type { ApplyExecutorDeps } from "./apply-executor/apply-executor-deps.js";
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
  async apply(rawBody: unknown): Promise<ApplyResult> {
    const result = EMPTY_RESULT();
    try {
      // 1. zod validation (strict, readable errors) — before any mutation.
      const parsed = parseRequest(rawBody);
      // 2. Semantic guardrails (DB reads) — before any mutation.
      await validateSemantics(this.deps, parsed);
      // 3. Trust-boundary manifest recheck — before any mutation.
      checkManifest(this.deps, parsed);
      // 4. Mutations: writes (merge) → records (rewriteRecord) → deletes → files.
      await applyMerges(this.deps, parsed.diff.merge, result);
      await applyRewritesRecords(this.deps, parsed.diff.rewriteRecord, result);
      await applyDeletes(this.deps, parsed.diff.deleteL1, result);
      await applyRewrites(
        this.deps,
        parsed.diff.rewriteBlock,
        parsed.diff.rewritePersona,
        result,
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
}

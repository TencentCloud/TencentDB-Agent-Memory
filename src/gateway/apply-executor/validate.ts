/**
 * Validation pipeline for /memory/apply (wave tdai-memory-subagents-2026-08-02, P4).
 *
 * Two stages, both run BEFORE any mutation (критерий 19c):
 *   1. parseRequest  — zod strictObject, throws ApplyValidationError on shape errors.
 *   2. validateSemantics — semantic guardrails (OWASP LLM01/08, ТЗ §5.4):
 *      deleteL1/rewriteRecord ids ⊆ presented; merge target ∈ cluster;
 *      merge cluster members ⊆ presented; rewriteBlock paths in allowlist
 *      AND in the manifest baseline; META frontmatter required.
 *   3. assertOpsSubset (NEW, P9) — role-scoped apply: the role's ops_subset
 *      gates which ops the diff may carry. Empty set → nothing allowed.
 *
 * Stage 3 (manifest recheck, file I/O) lives in manifest.ts. zod schemas
 * live in schemas.ts. Both are pure functions, no `this` — the ApplyExecutor
 * binds its helpers via closure.
 */

import { z } from "zod";
import { isSceneBlockRelPathOrPersona } from "../block-paths.js";
import { META_START, META_END } from "../limits.js";
import { ApplyValidationError } from "./errors.js";
import { fetchMetaRows } from "./apply-helpers.js";
import { applyRequestSchema } from "./schemas.js";
import type { ApplyDiff, ApplyOp } from "./schemas.js";
import type { ApplyExecutorDeps } from "./apply-executor-deps.js";
import type { ParsedApplyRequest } from "./types.js";

/** Stage 1: shape validation only (no DB reads). */
export function parseRequest(rawBody: unknown): ParsedApplyRequest {
  const parsed = applyRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const pretty = z.prettifyError(parsed.error);
    throw new ApplyValidationError(`Invalid apply request: ${pretty}`);
  }
  return parsed.data as ParsedApplyRequest;
}

/**
 * NEW (P9 + factory requirement): the role's ops_subset gates which ops the
 * diff may carry. Empty set → nothing allowed (caller may opt out of any
 * mutation by passing an empty Set). Throws ApplyValidationError on any
 * present-but-disallowed op; missing ops (not in the diff) are ignored.
 */
export function assertOpsSubset(
  diff: ApplyDiff,
  opsSubset: ReadonlySet<ApplyOp>,
): void {
  const present = new Set<ApplyOp>();
  if (diff.deleteL1?.length) present.add("deleteL1");
  if (diff.merge?.length) present.add("merge");
  if (diff.rewriteBlock?.length) present.add("rewriteBlock");
  if (diff.rewriteRecord?.length) present.add("rewriteRecord");
  if (diff.rewritePersona !== undefined) present.add("rewritePersona");
  for (const op of present) {
    if (!opsSubset.has(op)) {
      throw new ApplyValidationError(
        `op "${op}" not in role ops_subset [${[...opsSubset].join(", ")}]`,
      );
    }
  }
}

/**
 * Stage 2: semantic guardrails. `deps.dataDir` is used for the warm-cache
 * fetchMetaRows (no reject on missing rows — apply-ops decides skip vs
 * error per row). Structural checks stay hard.
 */
export async function validateSemantics(
  deps: ApplyExecutorDeps,
  parsed: ParsedApplyRequest,
): Promise<void> {
  const { diff, context, manifest } = parsed;

  const presented = new Set(context.presentedRecordIds);
  for (const op of diff.deleteL1 ?? []) {
    if (!presented.has(op.id)) {
      throw new ApplyValidationError(
        `deleteL1 id "${op.id}" was not presented to the memory-keeper (deleteL1 ids must be ⊆ the diff)`,
      );
    }
  }

  const allMergeTargets: string[] = [];
  for (const op of diff.merge ?? []) {
    if (!op.cluster.includes(op.target)) {
      throw new ApplyValidationError(
        `merge target "${op.target}" is not a member of its cluster [${op.cluster.join(", ")}]`,
      );
    }
    for (const member of op.cluster) {
      if (!presented.has(member)) {
        throw new ApplyValidationError(
          `merge cluster member "${member}" was not presented to the memory-keeper (cluster ids must be ⊆ the diff)`,
        );
      }
    }
    allMergeTargets.push(op.target);
  }
  // Existence-check (was hard-reject): a missing merge target now falls
  // through to applyMerges' skip-if-missing. Structural checks above stay hard.
  if (allMergeTargets.length > 0) {
    await fetchMetaRows(deps.dataDir, allMergeTargets); // warm cache; no reject
  }

  // rewriteRecord: presented-check + no id overlap with deleteL1/merge
  // (an id in two sections of one diff → stale-abort, never double-mutate).
  const touchedByOther = new Set<string>([
    ...(diff.deleteL1 ?? []).map((o) => o.id),
    ...(diff.merge ?? []).flatMap((o) => o.cluster),
  ]);
  for (const op of diff.rewriteRecord ?? []) {
    if (!presented.has(op.id)) {
      throw new ApplyValidationError(
        `rewriteRecord id "${op.id}" was not presented to the memory-keeper (rewriteRecord ids must be ⊆ the diff)`,
      );
    }
    if (touchedByOther.has(op.id)) {
      throw new ApplyValidationError(
        `rewriteRecord id "${op.id}" also appears in deleteL1/merge of the same diff (id-set intersection forbidden)`,
      );
    }
  }

  for (const op of diff.rewriteBlock ?? []) {
    if (!isSceneBlockRelPathOrPersona(op.path)) {
      throw new ApplyValidationError(
        `rewriteBlock path "${op.path}" is not in the allowlist (scene_blocks/** or persona.md)`,
      );
    }
    if (!(op.path in manifest.baseline)) {
      throw new ApplyValidationError(
        `rewriteBlock path "${op.path}" is not covered by the manifest baseline (child may only rewrite what it saw at spawn)`,
      );
    }
    if (!op.content.includes(META_START) || !op.content.includes(META_END)) {
      throw new ApplyValidationError(
        `rewriteBlock content for "${op.path}" must include ${META_START} and ${META_END} (validator requires META frontmatter)`,
      );
    }
  }
  if (diff.rewritePersona !== undefined) {
    if (!("persona.md" in manifest.baseline)) {
      throw new ApplyValidationError(
        "rewritePersona requires persona.md in the manifest baseline (child may only rewrite what it saw at spawn)",
      );
    }
  }
}

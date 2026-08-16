/**
 * Validation pipeline for /memory/apply (wave tdai-memory-subagents-2026-08-02, P4).
 *
 * Three stages, all run BEFORE any mutation (критерий 19c):
 *   1. parseRequest  — strict zod on the ENVELOPE, then per-op shape salvage
 *      of the diff (@see salvage.salvageDiff).
 *   2. screenDiff    — semantic guardrails (OWASP LLM01/08, ТЗ §5.4):
 *      deleteL1/rewriteRecord ids ⊆ presented; merge target ∈ cluster;
 *      merge cluster members ⊆ presented; rewriteBlock paths in allowlist
 *      AND in the manifest baseline; META frontmatter required; and no op
 *      may carry blank content (@see blankReason — blank is erasure, and this
 *      is the one floor that holds in every gate mode).
 *   3. assertOpsSubset (P9) — role-scoped apply: the role's ops_subset gates
 *      which ops the diff may carry. Empty set → nothing allowed.
 *
 * Stage 2 REFUSES OPERATIONS, NOT REQUESTS. Every guardrail above is stated
 * per-op ("the child may only touch what it was shown"), so refusing the op
 * alone keeps the guarantee whole — the whole-request abort was a side effect
 * of `throw`, not a security property, and it cost run f947be67 all 362 of its
 * records. Refusals are collected into `rejected` and reported (never silent).
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
import { refuseOrphanedDeletes, salvageDiff } from "./salvage.js";
import { applyRequestSchema } from "./schemas.js";
import type { ApplyDiff, ApplyOp } from "./schemas.js";
import type { ApplyExecutorDeps } from "./apply-executor-deps.js";
import type { ParsedApplyRequest, RejectedOp } from "./types.js";

/**
 * Stage 1: shape only (no DB reads). The envelope is strict — it is OUR
 * payload, so a malformed one is a gateway bug, not one bad op from a role.
 */
export function parseRequest(
  rawBody: unknown,
  rejected: RejectedOp[],
): ParsedApplyRequest {
  const parsed = applyRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const pretty = z.prettifyError(parsed.error);
    throw new ApplyValidationError(`Invalid apply request: ${pretty}`);
  }
  return {
    ...parsed.data,
    diff: salvageDiff(parsed.data.diff, rejected),
  } as ParsedApplyRequest;
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

/** One op's verdict: `null` keeps it, a string is the reason it is refused. */
type Verdict<T> = (op: T) => string | null;

/**
 * Keep the ops that pass `check`; append the rest to `rejected`.
 * `undefined` (not `[]`) when nothing survives, so a section that lost every
 * op reads as absent to `assertOpsSubset` and the mutation stage.
 */
function keep<T>(
  ops: T[] | undefined,
  section: string,
  refOf: (op: T) => string,
  check: Verdict<T>,
  rejected: RejectedOp[],
): T[] | undefined {
  if (ops === undefined) return undefined;
  const kept: T[] = [];
  for (const op of ops) {
    const reason = check(op);
    if (reason === null) kept.push(op);
    else rejected.push({ section, ref: refOf(op), reason });
  }
  return kept.length > 0 ? kept : undefined;
}

/**
 * Content that is blank is ERASURE, not an edit.
 *
 * Observed on the live instance (run b9bd7db4, 2026-08-15): the role returned
 * `"rewritePersona": ""`, apply wrote it through, and persona.md became a
 * 0-byte file — the whole user persona gone in one run. Nothing upstream stops
 * it: every content field is capped from above and has no floor, and the
 * ops_subset gate that would have refused the op was running in shadow mode.
 *
 * `merge` is the same hazard with a bigger blast radius: blank content
 * overwrites the target AND deletes every other cluster member, so an empty
 * string turns a de-duplication into a net loss of records.
 *
 * So the floor lives here, where it holds in EVERY gate mode. Erasing content
 * is a deletion, and none of these ops is a deletion — a role that means "this
 * should go" has no way to say it, which is the intended answer.
 */
function blankReason(content: string): string | null {
  return content.trim().length === 0
    ? "content is blank — an apply may not erase content"
    : null;
}

function mergeReason(
  op: { cluster: string[]; target: string; content: string },
  presented: ReadonlySet<string>,
): string | null {
  if (!op.cluster.includes(op.target)) {
    return `merge target is not a member of its cluster [${op.cluster.join(", ")}]`;
  }
  for (const member of op.cluster) {
    if (!presented.has(member)) {
      return `cluster member "${member}" was not presented to the memory-keeper (cluster ids must be ⊆ the diff)`;
    }
  }
  return blankReason(op.content);
}

function blockReason(
  op: { path: string; content: string },
  baseline: Record<string, string>,
): string | null {
  if (!isSceneBlockRelPathOrPersona(op.path)) {
    return "path is not in the allowlist (scene_blocks/** or persona.md)";
  }
  if (!(op.path in baseline)) {
    return "path is not covered by the manifest baseline (child may only rewrite what it saw at spawn)";
  }
  const blank = blankReason(op.content);
  if (blank !== null) return blank;
  return op.content.includes(META_START) && op.content.includes(META_END)
    ? null
    : `content must include ${META_START} and ${META_END} (validator requires META frontmatter)`;
}

/**
 * An id claimed by two sections of one diff is a contradiction, and BOTH
 * claims lose. Refusing only the rewrite would let the delete through — a
 * request that used to do nothing would start deleting records, which is a
 * refusal turning into data loss.
 */
function screenIdCollisions(diff: ApplyDiff, rejected: RejectedOp[]): void {
  const touched = new Set<string>([
    ...(diff.deleteL1 ?? []).map((op) => op.id),
    ...(diff.merge ?? []).flatMap((op) => op.cluster),
  ]);
  const contested = new Set(
    (diff.rewriteRecord ?? [])
      .map((op) => op.id)
      .filter((id) => touched.has(id)),
  );
  if (contested.size === 0) return;
  const why =
    "id appears in deleteL1/merge AND rewriteRecord of the same diff (id-set intersection forbidden)";
  const contest = (id: string): string | null =>
    contested.has(id) ? why : null;
  diff.rewriteRecord = keep(
    diff.rewriteRecord,
    "rewriteRecord",
    (op) => op.id,
    (op) => contest(op.id),
    rejected,
  );
  diff.deleteL1 = keep(
    diff.deleteL1,
    "deleteL1",
    (op) => op.id,
    (op) => contest(op.id),
    rejected,
  );
  diff.merge = keep(
    diff.merge,
    "merge",
    (op) => op.target,
    (op) => (op.cluster.some((id) => contested.has(id)) ? why : null),
    rejected,
  );
}

/**
 * Stage 2: semantic guardrails, per operation. Returns the diff of SURVIVING
 * ops; every refusal lands in `rejected` with its reason. `deps.dataDir` is
 * used for the warm-cache fetchMetaRows (no reject on missing rows — apply-ops
 * decides skip vs error per row).
 *
 * Pass order is fixed and load-bearing: (1) each section against its own
 * guardrails, (2) ids claimed by two sections, (3) deletes orphaned by a merge
 * that is now gone. Rule 3 runs LAST because pass 2 itself refuses merges:
 * with `merge [m_a,m_b]→m_a` + `rewriteRecord m_b` + `deleteL1 m_a`, running
 * rule 3 first would leave the delete standing after pass 2 killed the merge,
 * and m_a would be deleted with m_b's content merged nowhere. The cost of this
 * order is over-refusal (pass 2 may drop a rewriteRecord over a delete that
 * pass 3 was going to drop anyway) — refusing too much, never deleting too
 * much, which is the direction the bias belongs in.
 */
export async function screenDiff(
  deps: ApplyExecutorDeps,
  parsed: ParsedApplyRequest,
  rejected: RejectedOp[],
): Promise<ApplyDiff> {
  // Every merge the diff ARRIVED with — not `out.merge`, which is already the
  // survivors of pass 1 and would hide the merges that pass refused.
  const arrived = parsed.diff.merge ?? [];
  const out = screenSections(
    parsed.diff,
    new Set(parsed.context.presentedRecordIds),
    parsed.manifest.baseline,
    rejected,
  );

  screenIdCollisions(out, rejected);
  // `keep` passes the same object through, so identity is the survivor test.
  const survived = new Set(out.merge ?? []);
  const orphaned = new Set<string>();
  for (const op of arrived) {
    if (!survived.has(op)) for (const id of op.cluster) orphaned.add(id);
  }
  refuseOrphanedDeletes(out, orphaned, rejected);

  // Existence-check (was hard-reject): a missing merge target falls through to
  // applyMerges' skip-if-missing. Warms the cache for the survivors only.
  const targets = (out.merge ?? []).map((op) => op.target);
  if (targets.length > 0) await fetchMetaRows(deps.dataDir, targets);
  return out;
}

/** Pass 1: every section against its OWN guardrails, op by op. */
function screenSections(
  diff: ApplyDiff,
  presented: ReadonlySet<string>,
  baseline: Record<string, string>,
  rejected: RejectedOp[],
): ApplyDiff {
  const notPresented = (what: string): string =>
    `${what} id was not presented to the memory-keeper (ids must be ⊆ the diff)`;
  return {
    deleteL1: keep(
      diff.deleteL1,
      "deleteL1",
      (op) => op.id,
      (op) => (presented.has(op.id) ? null : notPresented("deleteL1")),
      rejected,
    ),
    merge: keep(
      diff.merge,
      "merge",
      (op) => op.target,
      (op) => mergeReason(op, presented),
      rejected,
    ),
    rewriteRecord: keep(
      diff.rewriteRecord,
      "rewriteRecord",
      (op) => op.id,
      (op) =>
        presented.has(op.id)
          ? blankReason(op.content)
          : notPresented("rewriteRecord"),
      rejected,
    ),
    rewriteBlock: keep(
      diff.rewriteBlock,
      "rewriteBlock",
      (op) => op.path,
      (op) => blockReason(op, baseline),
      rejected,
    ),
    rewritePersona: screenPersona(diff.rewritePersona, baseline, rejected),
  };
}

function screenPersona(
  content: string | undefined,
  baseline: Record<string, string>,
  rejected: RejectedOp[],
): string | undefined {
  if (content === undefined) return undefined;
  const reason = !("persona.md" in baseline)
    ? "rewritePersona requires persona.md in the manifest baseline (child may only rewrite what it saw at spawn)"
    : blankReason(content);
  if (reason === null) return content;
  rejected.push({ section: "rewritePersona", ref: "-", reason });
  return undefined;
}

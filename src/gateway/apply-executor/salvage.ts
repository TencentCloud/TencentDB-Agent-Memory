/**
 * Shape salvage for the role's diff: parse it ONE OPERATION AT A TIME.
 *
 * Run f947be67 (night-keeper, 2026-08-14) presented 362 records, worked the
 * model for 16 minutes and applied NOTHING, because the result carried
 * `"rewritePersona": null` and a whole-array zod parse turned that into
 * `Invalid apply request` for the entire batch. `null` is how a model writing
 * JSON says "nothing" — here it means the section is absent, which is what it
 * always meant.
 *
 * The same shape holds for every other section: a broken element is dropped
 * and named (@see RejectedOp), never a reason to discard the operations next
 * to it. Only two things still refuse the whole request, and both say the
 * role's contract is broken wholesale rather than one op being malformed:
 * a diff that is not an object, and a section over its count cap.
 *
 * The ENVELOPE (runId / manifest / context) is not salvaged — it is our own
 * payload, so a malformed one is a gateway bug (@see validate.parseRequest).
 */

import { z } from "zod";
import { ApplyValidationError } from "./errors.js";
import { ARRAY_SECTIONS, personaSchema } from "./schemas.js";
import type { ApplyDiff } from "./schemas.js";
import type { RejectedOp } from "./types.js";

/** zod's multi-line report as one log-safe line. */
function reasonOf(error: z.ZodError): string {
  return z.prettifyError(error).replace(/\s+/g, " ").trim();
}

/** How the report names an op: its own id/target/path, else its position. */
function refOf(element: unknown, key: string, index: number): string {
  const named = (element as Record<string, unknown> | null)?.[key];
  return typeof named === "string" && named.length > 0 ? named : `#${index}`;
}

function typeNameOf(value: unknown): string {
  return Array.isArray(value)
    ? "array"
    : value === null
      ? "null"
      : typeof value;
}

/**
 * @throws ApplyValidationError when the section is over its count cap.
 * @returns `kept` — the elements that parsed — and `failed` — the RAW
 * elements that did not. The rejections are appended to `rejected`; `failed`
 * exists because a refused merge still has to give up its cluster ids
 * (@see refuseOrphanedDeletes).
 */
function salvageSection(
  section: string,
  value: unknown,
  rejected: RejectedOp[],
): { kept: unknown[]; failed: unknown[] } {
  const spec = ARRAY_SECTIONS[section];
  if (!Array.isArray(value)) {
    rejected.push({
      section,
      ref: "-",
      reason: `expected an array, got ${typeNameOf(value)}`,
    });
    return { kept: [], failed: [] };
  }
  if (value.length > spec.cap) {
    throw new ApplyValidationError(
      `diff.${section} carries ${value.length} ops, over the cap of ${spec.cap} — ` +
        "the whole request is refused (dropping an arbitrary tail would apply an arbitrary half)",
    );
  }
  const kept: unknown[] = [];
  const failed: unknown[] = [];
  value.forEach((element, index) => {
    const parsed = spec.schema.safeParse(element);
    if (parsed.success) {
      kept.push(parsed.data);
      return;
    }
    failed.push(element);
    rejected.push({
      section,
      ref: refOf(element, spec.key, index),
      reason: reasonOf(parsed.error),
    });
  });
  return { kept, failed };
}

/** Cluster ids claimed by a merge element, however broken the rest of it is. */
function clusterIdsOf(element: unknown): string[] {
  const cluster = (element as { cluster?: unknown } | null)?.cluster;
  return Array.isArray(cluster)
    ? cluster.filter((id): id is string => typeof id === "string")
    : [];
}

/**
 * A `deleteL1` on a member of a merge that will NOT run deletes a record whose
 * content was to be folded into the target — the merge is gone, so nothing
 * folds anywhere and the content is simply lost. Refusing a merge must never
 * turn into deleting its members, so the delete goes with it.
 *
 * Called from both places that can kill a merge: here (its shape was refused)
 * and from the semantic screen (@see validate.screenDiff). One rule, one
 * implementation, two sets of dead merges.
 */
export function refuseOrphanedDeletes(
  diff: ApplyDiff,
  orphaned: ReadonlySet<string>,
  rejected: RejectedOp[],
): void {
  if (orphaned.size === 0 || diff.deleteL1 === undefined) return;
  const kept = diff.deleteL1.filter((op) => {
    if (!orphaned.has(op.id)) return true;
    rejected.push({
      section: "deleteL1",
      ref: op.id,
      reason:
        "id is a member of a merge cluster that was refused — deleting it " +
        "would drop content that was never merged",
    });
    return false;
  });
  diff.deleteL1 = kept.length > 0 ? kept : undefined;
}

/**
 * @throws ApplyValidationError when the diff is not an object at all, or a
 * section is over its count cap — see the module docstring for why those two.
 */
export function salvageDiff(raw: unknown, rejected: RejectedOp[]): ApplyDiff {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ApplyValidationError(
      `Invalid apply request: diff must be an object, got ${typeNameOf(raw)}`,
    );
  }
  const out: ApplyDiff = {};
  const orphaned = new Set<string>();
  for (const [section, value] of Object.entries(raw)) {
    // `null` is a model writing JSON saying "nothing" — the section is absent,
    // and an absent section is not an error worth reporting.
    if (value === null || value === undefined) continue;
    if (section === "rewritePersona") {
      const parsed = personaSchema.safeParse(value);
      if (parsed.success) out.rewritePersona = parsed.data;
      else rejected.push({ section, ref: "-", reason: reasonOf(parsed.error) });
      continue;
    }
    if (!(section in ARRAY_SECTIONS)) {
      rejected.push({ section, ref: "-", reason: "unknown diff section" });
      continue;
    }
    const { kept, failed } = salvageSection(section, value, rejected);
    if (section === "merge") {
      for (const element of failed) {
        for (const id of clusterIdsOf(element)) orphaned.add(id);
      }
    }
    // One contained cast: salvageSection returns what the section's own schema
    // produced, which is by construction that section's element type.
    if (kept.length > 0) (out as Record<string, unknown>)[section] = kept;
  }
  refuseOrphanedDeletes(out, orphaned, rejected);
  return out;
}

/** Nothing left to apply — every section empty and no persona rewrite. */
export function isEmptyDiff(diff: ApplyDiff): boolean {
  return (
    !diff.deleteL1?.length &&
    !diff.merge?.length &&
    !diff.rewriteBlock?.length &&
    !diff.rewriteRecord?.length &&
    diff.rewritePersona === undefined
  );
}

/** Refusals as one line, for the error of an all-refused apply and for logs. */
export function rejectionSummary(rejected: readonly RejectedOp[]): string {
  return rejected.map((r) => `${r.section}[${r.ref}]: ${r.reason}`).join("; ");
}

/**
 * applyMerges — writeMemory (target survives) + deleteL1Batch(cluster∖target).
 *
 * Heal-skip: target alive, members gone. Cross-batch anchor: target gone but
 * members present (skipped — the FIRST such skip anchors the night cursor).
 * Shared writeMemory wrapper in apply-provenance.ts. applyDeletes +
 * applyRewrites live in apply-ops-rewrite.ts.
 */

import { ApplyRuntimeError } from "./errors.js";
import { fetchMetaRows } from "./apply-helpers.js";
import { writeProvenanceRecord } from "./apply-provenance.js";
import { parseMetadata } from "./apply-route-helpers.js";
import type { ApplyExecutorDeps } from "./apply-executor-deps.js";
import type { ApplyResult } from "./types.js";
import { digestOf, type OnOp } from "./op-journal.js";
import type { ExtractedMemory } from "../../core/record/l1-writer.js";

export async function applyMerges(
  deps: ApplyExecutorDeps,
  ops:
    Array<{ cluster: string[]; target: string; content: string }> | undefined,
  result: ApplyResult,
  onOp?: OnOp,
): Promise<void> {
  if (!ops || ops.length === 0) return;
  const { logger, dataDir, vectorStore } = deps;

  for (const [i, op] of ops.entries()) {
    const rows = await fetchMetaRows(dataDir, [op.target, ...op.cluster]);
    const targetRow = rows.get(op.target);
    const membersPresent = op.cluster.some(
      (m) => m !== op.target && rows.has(m),
    );

    if (targetRow && !membersPresent) {
      // heal-skip: target alive, members already merged.
      result.skipped.merges.push(op.target);
      continue;
    }
    if (!targetRow) {
      // Cross-batch partner deleted in an earlier night batch: skip-if-missing
      // (the FIRST-skip-merge anchor for the night loop).
      result.skipped.merges.push(op.target);
      result.skippedMergesMissingTarget.push(op.target);
      continue;
    }

    const memory: ExtractedMemory = {
      content: op.content,
      type: (targetRow.type as ExtractedMemory["type"]) || "episodic",
      priority: targetRow.priority ?? 50,
      source_message_ids: [],
      metadata: parseMetadata(targetRow.metadata_json),
      scene_name: targetRow.scene_name ?? "",
      scope: targetRow.scope === "project" ? "project" : undefined,
    };

    const digest = digestOf(op.content);
    // The members are journalled WITH the merge, not as separate ops: they are
    // the second half of this one operation's effect, and reconciliation has to
    // see a half-done merge as unresolved rather than verified.
    const members = op.cluster.filter((m) => m !== op.target);
    onOp?.("merge", i, op.target, "prepared", digest, members);
    await writeProvenanceRecord(deps, {
      row: targetRow,
      memory,
      action: "merge",
      content: op.content,
      stableId: op.target,
      label: `merge target "${op.target}"`,
    });
    // The target is written. Whatever happens to the members now, this apply
    // has mutated the store and its run may not be reported as a clean failure.
    result.storeTouched = true;

    if (members.length > 0 && vectorStore) {
      const ok = await vectorStore.deleteL1Batch(members);
      if (!ok) {
        throw new ApplyRuntimeError(
          `deleteL1Batch failed after merge "${op.target}" (members [${members.join(", ")}])`,
        );
      }
    }
    onOp?.("merge", i, op.target, "applied", digest, members);
    result.applied.merges.push(op.target);
    logger.info?.(
      `[memory/apply] merged ${op.cluster.length} records into ${op.target}`,
    );
  }
}

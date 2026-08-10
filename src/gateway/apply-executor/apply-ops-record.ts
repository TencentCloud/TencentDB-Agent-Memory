/**
 * applyRewritesRecords — in-place content rewrite of ONE L1 record.
 *
 * Pipeline: fetch meta → stale-check updatedAt (abort like deleteL1) →
 * heal-skip (content already equal → skipped.rewrites) → writeMemory with
 * action=update, stable id, createdAtOverride → vector rewrite + JSONL.
 *
 * Split from apply-ops.ts to keep that file ≤150 lines (the rewriteRecord
 * pipeline is large enough on its own).
 */

import { StaleDeleteError } from "./errors.js";
import { fetchMetaRows } from "./apply-helpers.js";
import { writeProvenanceRecord } from "./apply-provenance.js";
import { parseMetadata } from "./apply-route-helpers.js";
import type { ApplyExecutorDeps } from "./apply-executor-deps.js";
import type { ApplyResult } from "./types.js";
import type { ExtractedMemory } from "../../core/record/l1-writer.js";

export async function applyRewritesRecords(
  deps: ApplyExecutorDeps,
  ops: Array<{ id: string; updatedAt: string; content: string }> | undefined,
  result: ApplyResult,
): Promise<void> {
  if (!ops || ops.length === 0) return;
  const { logger, dataDir } = deps;

  const rows = await fetchMetaRows(
    dataDir,
    ops.map((o) => o.id),
  );
  for (const op of ops) {
    const row = rows.get(op.id);
    if (!row) {
      // Record gone → already applied / deleted elsewhere → skip (heal path).
      result.skipped.rewrites.push(op.id);
      continue;
    }
    if (row.content === op.content) {
      // heal re-run: rewrite already applied → skip, never stale-abort.
      result.skipped.rewrites.push(op.id);
      continue;
    }
    if (row.updated_time !== op.updatedAt) {
      throw new StaleDeleteError(
        `rewriteRecord target "${op.id}" was updated since the diff was built ` +
          `(diff updatedAt "${op.updatedAt}", current "${row.updated_time}") — aborting to protect fresh data`,
      );
    }

    const memory: ExtractedMemory = {
      content: op.content,
      type: (row.type as ExtractedMemory["type"]) || "episodic",
      priority: row.priority ?? 50,
      source_message_ids: [],
      metadata: parseMetadata(row.metadata_json),
      scene_name: row.scene_name ?? "",
      scope: row.scope === "project" ? "project" : undefined,
    };

    await writeProvenanceRecord(deps, {
      row,
      memory,
      action: "update",
      content: op.content,
      stableId: op.id,
      label: `rewriteRecord "${op.id}"`,
    });

    result.applied.rewrites.push(op.id);
    logger.info?.(
      `[memory/apply] rewrote record ${op.id} (${op.content.length} chars)`,
    );
  }
}

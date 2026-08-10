/**
 * applyDeletes (L1 batch remove) + applyRewrites (scene/persona atomic write).
 *
 * applyDeletes: stale-re-check (per-id updatedAt), skip-if-missing, abort on
 *   drift. deleteL1Batch(false) → abort.
 * applyRewrites: tmp + rename with backup. skip-if-equal (heal re-run).
 *
 * applyMerges lives in apply-ops-merge.ts. applyRewritesRecords lives in
 * apply-ops-record.ts.
 */

import fs from "node:fs";
import { ApplyRuntimeError, StaleDeleteError } from "./errors.js";
import {
  fetchMetaRows,
  resolveWithinDataDir,
  writeBackup,
} from "./apply-helpers.js";
import { atomicWrite } from "./apply-route-helpers.js";
import type { ApplyExecutorDeps } from "./apply-executor-deps.js";
import type { ApplyResult } from "./types.js";

/** Deletes with stale-re-check. */
export async function applyDeletes(
  deps: ApplyExecutorDeps,
  ops: Array<{ id: string; updatedAt: string }> | undefined,
  result: ApplyResult,
): Promise<void> {
  if (!ops || ops.length === 0) return;
  const rows = await fetchMetaRows(
    deps.dataDir,
    ops.map((o) => o.id),
  );

  const toDelete: string[] = [];
  for (const op of ops) {
    const row = rows.get(op.id);
    if (!row) {
      result.skipped.deletes.push(op.id);
      continue;
    }
    if (row.updated_time !== op.updatedAt) {
      throw new StaleDeleteError(
        `delete target "${op.id}" was updated since the diff was built ` +
          `(diff updatedAt "${op.updatedAt}", current "${row.updated_time}") — aborting to protect fresh data`,
      );
    }
    toDelete.push(op.id);
  }

  if (toDelete.length > 0 && deps.vectorStore) {
    const ok = await deps.vectorStore.deleteL1Batch(toDelete);
    if (!ok) {
      throw new ApplyRuntimeError(
        `deleteL1Batch failed for [${toDelete.join(", ")}]`,
      );
    }
  }
  result.applied.deletes.push(...toDelete);
}

/** Rewrite scene/persona atomically (tmp + rename) with a backup. */
export async function applyRewrites(
  deps: ApplyExecutorDeps,
  blocks: Array<{ path: string; content: string }> | undefined,
  persona: string | undefined,
  result: ApplyResult,
): Promise<void> {
  const targets: Array<{ relPath: string; content: string }> = [];
  for (const op of blocks ?? [])
    targets.push({ relPath: op.path, content: op.content });
  if (persona !== undefined)
    targets.push({ relPath: "persona.md", content: persona });

  for (const target of targets) {
    const resolved = resolveWithinDataDir(deps.dataDir, target.relPath);
    if (!resolved) {
      throw new ApplyRuntimeError(
        `rewrite path "${target.relPath}" escapes the data dir`,
      );
    }

    let current: string | null = null;
    try {
      current = fs.readFileSync(resolved, "utf-8");
    } catch {
      current = null; // file raced away — backup skipped, write recreates it
    }
    if (current === target.content) {
      result.skipped.rewrites.push(target.relPath);
      continue;
    }

    try {
      if (current !== null) {
        await writeBackup(deps.dataDir, target.relPath, current);
      }
      await atomicWrite(resolved, target.content);
    } catch (err) {
      throw new ApplyRuntimeError(
        `rewrite "${target.relPath}" failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    result.applied.rewrites.push(target.relPath);
    deps.logger.info?.(
      `[memory/apply] rewrote ${target.relPath} (${target.content.length} chars)`,
    );
  }
}

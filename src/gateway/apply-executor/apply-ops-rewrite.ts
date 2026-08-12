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
import { digestOf, type OnOp } from "./op-journal.js";

/** Deletes with stale-re-check. */
export async function applyDeletes(
  deps: ApplyExecutorDeps,
  ops: Array<{ id: string; updatedAt: string }> | undefined,
  result: ApplyResult,
  onOp?: OnOp,
): Promise<void> {
  if (!ops || ops.length === 0) return;
  const rows = await fetchMetaRows(
    deps.dataDir,
    ops.map((o) => o.id),
  );

  // The op index is the position in the REQUEST, not in the compacted list:
  // a skipped id would otherwise shift every later operationId onto the wrong
  // target, and the journal is only useful while its ids mean one thing.
  const toDelete: Array<{ id: string; index: number }> = [];
  for (const [index, op] of ops.entries()) {
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
    toDelete.push({ id: op.id, index });
  }

  const ids = toDelete.map((d) => d.id);
  for (const d of toDelete) onOp?.("deleteL1", d.index, d.id, "prepared");
  if (ids.length > 0 && deps.vectorStore) {
    let ok: boolean;
    try {
      ok = await deps.vectorStore.deleteL1Batch(ids);
    } catch (err) {
      // A batch that THREW may have deleted part of itself — unlike a batch
      // that returned false, which reports "nothing was deleted".
      result.storeTouched = true;
      throw err;
    }
    if (!ok) {
      throw new ApplyRuntimeError(
        `deleteL1Batch failed for [${ids.join(", ")}]`,
      );
    }
    result.storeTouched = true;
  }
  for (const d of toDelete) onOp?.("deleteL1", d.index, d.id, "applied");
  result.applied.deletes.push(...ids);
}

/** Rewrite scene/persona atomically (tmp + rename) with a backup. */
export async function applyRewrites(
  deps: ApplyExecutorDeps,
  blocks: Array<{ path: string; content: string }> | undefined,
  persona: string | undefined,
  result: ApplyResult,
  onOp?: OnOp,
): Promise<void> {
  const targets: Array<{ relPath: string; content: string }> = [];
  for (const op of blocks ?? [])
    targets.push({ relPath: op.path, content: op.content });
  if (persona !== undefined)
    targets.push({ relPath: "persona.md", content: persona });

  for (const [i, target] of targets.entries()) {
    const isPersona = persona !== undefined && i === targets.length - 1;
    const opType = isPersona ? "rewritePersona" : "rewriteBlock";
    const localIndex = isPersona ? 0 : i;
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

    const digest = digestOf(target.content);
    onOp?.(opType, localIndex, target.relPath, "prepared", digest);
    const failed = (err: unknown): ApplyRuntimeError =>
      new ApplyRuntimeError(
        `rewrite "${target.relPath}" failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    try {
      // The backup is written BEFORE the carrier and under its own catch: a
      // backup that fails leaves the carrier untouched, and marking the store
      // as mutated there would park a run that changed nothing.
      if (current !== null) {
        await writeBackup(deps.dataDir, target.relPath, current);
      }
    } catch (err) {
      throw failed(err);
    }
    try {
      await atomicWrite(resolved, target.content);
      result.storeTouched = true;
    } catch (err) {
      // The rename itself is atomic, but a failure inside the sequence leaves
      // the carrier in an unknown state — reconciliation's question, not this
      // catch's.
      result.storeTouched = true;
      throw failed(err);
    }
    onOp?.(opType, localIndex, target.relPath, "applied", digest);
    result.applied.rewrites.push(target.relPath);
    deps.logger.info?.(
      `[memory/apply] rewrote ${target.relPath} (${target.content.length} chars)`,
    );
  }
}

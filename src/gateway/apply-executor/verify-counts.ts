/**
 * verifyCounts — vec-vs-meta count check (wave tdai-memory-factory-2026-08-03,
 * Group A decomp). Lives separately from apply-route.ts to keep that file ≤150.
 */
import { MAX_REINDEX_RETRIES } from "../limits.js";
import type { ApplyExecutorDeps } from "./apply-executor-deps.js";
import type { ApplyCounts, ApplyResult } from "./types.js";

/**
 * vec-vs-meta count check: both COUNTs + orphan/missing id-sets in ONE store
 * transaction. Match → done. Mismatch → orphan purge (per-id stmtDeleteVec,
 * one transaction) → reindexAll with a livelock cap (MAX_REINDEX_RETRIES) →
 * per-row backfill of the remaining delta (reindexL1Records) + L0 window-skip
 * heal (reindexL0Records) → unresolved → failed.
 */
export async function verifyCounts(
  deps: ApplyExecutorDeps,
  result: ApplyResult,
): Promise<boolean> {
  const store = deps.vectorStore;
  if (!store?.consistencyCheck) return true; // backend cannot check — skip

  const updateCounts = (c: {
    metaCount: number;
    vecCount: number | null;
    orphanIds: string[];
    missingIds?: string[];
    l0VecCount?: number | null;
    l0MissingIds?: string[];
  }): void => {
    const out: ApplyCounts = {
      metaCount: c.metaCount,
      vecCount: c.vecCount,
      consistent: c.vecCount === null ? null : c.vecCount === c.metaCount,
    };
    result.counts = out;
  };

  let check = await store.consistencyCheck();
  updateCounts(check);
  // No vec0 tables / degraded → nothing to reconcile (NOT a mismatch).
  if (check.vecCount === null) return true;
  if (check.vecCount === check.metaCount) return true;

  deps.logger.warn?.(
    `[memory/apply] vec-vs-meta mismatch after apply: vec=${check.vecCount} meta=${check.metaCount} orphans=${check.orphanIds.length}`,
  );

  // Orphan purge first — in-process reindexAll per-row cannot remove
  // vec rows without a meta row (sqlite.ts:1914).
  if (check.orphanIds.length > 0 && store.purgeOrphanVectors) {
    const purged = await store.purgeOrphanVectors(check.orphanIds);
    if (purged) {
      check = await store.consistencyCheck();
      updateCounts(check);
      if (check.vecCount === null) return true;
      if (check.vecCount === check.metaCount) return true;
    }
  }

  // Still mismatched → full reindex (livelock-capped, ТЗ §5.6).
  if (!deps.embeddingService) {
    result.needsReindex = true;
    result.error =
      "vec-vs-meta mismatch unresolved (no embedding service available for reindex)";
    return false;
  }
  const embedFn = (text: string) => deps.embeddingService!.embed(text);
  for (let attempt = 1; attempt <= MAX_REINDEX_RETRIES; attempt++) {
    deps.logger.warn?.(
      `[memory/apply] reindexAll attempt ${attempt}/${MAX_REINDEX_RETRIES} (vec-vs-meta mismatch)`,
    );
    await store.reindexAll(embedFn);
    result.reindexed = true;
    check = await store.consistencyCheck();
    updateCounts(check);
    if (check.vecCount === null) return true;
    if (check.vecCount === check.metaCount) return true;
  }

  // Livelock cap reached and still mismatched → backfill the delta per-row
  // (reindexL1Records) INSTEAD of a third full reindex — skip-dual-write
  // during the reindex window produces exactly this delta, and per-row
  // delete+insert is idempotent under concurrent dual-writes.
  const missingIds = check.missingIds ?? [];
  if (missingIds.length > 0 && store.reindexL1Records) {
    deps.logger.warn?.(
      `[memory/apply] livelock cap reached — backfilling ${missingIds.length} L1 row(s) per-row`,
    );
    await store.reindexL1Records(missingIds, embedFn);
    result.reindexed = true;
    check = await store.consistencyCheck();
    updateCounts(check);
  }

  // L0 window-skip heal: L0 vector rows skipped during the reindex window
  // (updateL0Embedding returns false while the flag is set, auto-capture
  // treats it as non-fatal) are backfilled per-row here so messages captured
  // during the window stay searchable. Runs regardless of the L1 outcome.
  // Idempotent under a concurrent background embed (delete+insert replaces).
  const l0Missing = check.l0MissingIds ?? [];
  if (l0Missing.length > 0 && store.reindexL0Records) {
    deps.logger.warn?.(
      `[memory/apply] backfilling ${l0Missing.length} L0 row(s) per-row (reindex window-skip heal)`,
    );
    await store.reindexL0Records(l0Missing, embedFn);
    result.reindexed = true;
  }

  if (check.vecCount === null) return true;
  if (check.vecCount === check.metaCount) return true;

  result.needsReindex = true;
  result.error =
    `vec-vs-meta mismatch unresolved after ${MAX_REINDEX_RETRIES} reindex attempt(s) + per-row backfill ` +
    `(vec=${check.vecCount}, meta=${check.metaCount})`;
  return false;
}

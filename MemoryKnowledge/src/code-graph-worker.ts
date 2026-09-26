/** Build a replacement CodeGraph without mutating the last successfully indexed checkout. */

import { randomUUID } from "node:crypto";
import { constants, existsSync, mkdirSync } from "node:fs";
import { cp, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { closeIndex, getStats, indexProject, openIndex, syncIndex, type CodeGraphInstance } from "./engines/code/index.js";
import { PreservedCodeGraphError, type CodeGraphWorker } from "./store/code-graph-service.js";
import type { CodeGraphInstancePool } from "./module.js";
import type { ISourceFetcher } from "./source-fetcher/index.js";

export interface CodeGraphIndexOps {
  openIndex: (dir: string) => Promise<CodeGraphInstance>;
  indexProject: (dir: string) => Promise<CodeGraphInstance>;
  syncIndex: (instance: CodeGraphInstance) => Promise<{ changed: number }>;
  getStats: (instance: CodeGraphInstance) => {
    fileCount?: number;
    nodeCount?: number;
    edgeCount?: number;
    files?: number;
    nodes?: number;
    edges?: number;
  };
  closeIndex: (instance: CodeGraphInstance) => void;
}

export interface CodeGraphWorkerOptions {
  instancePool: CodeGraphInstancePool;
  resolveFetcher: (repoUrl: string) => ISourceFetcher;
  indexOps?: CodeGraphIndexOps;
  logger?: { warn: (message: string) => void };
}

const defaultIndexOps: CodeGraphIndexOps = { openIndex, indexProject, syncIndex, getStats, closeIndex };

function statsFor(instance: CodeGraphInstance, indexOps: CodeGraphIndexOps) {
  const stats = indexOps.getStats(instance);
  return {
    files: stats.fileCount ?? stats.files ?? 0,
    nodes: stats.nodeCount ?? stats.nodes ?? 0,
    edges: stats.edgeCount ?? stats.edges ?? 0,
  };
}

export function createCodeGraphWorker(options: CodeGraphWorkerOptions): CodeGraphWorker {
  const { instancePool, resolveFetcher, logger } = options;
  const indexOps = options.indexOps ?? defaultIndexOps;

  return async ({ dir, repoUrl, branch, codeGraphId, setInternalStatus }) => {
    const fetcher = resolveFetcher(repoUrl);

    // There is no last-good version to preserve on the first build.
    if (!existsSync(join(dir, ".git"))) {
      mkdirSync(dir, { recursive: true });
      setInternalStatus("cloning");
      const result = await fetcher.fetch(repoUrl, branch, dir);
      setInternalStatus("indexing");
      const instance = await indexOps.indexProject(dir);
      instancePool.set(codeGraphId, instance);
      return { commitHash: result.version ?? undefined, stats: statsFor(instance, indexOps) };
    }

    const suffix = randomUUID();
    const parent = dirname(dir);
    const name = basename(dir);
    const candidateDir = join(parent, `.${name}.candidate-${suffix}`);
    // Stable name lets startup roll back a promotion interrupted by a process crash.
    const backupDir = `${dir}.previous`;
    let candidateInstance: CodeGraphInstance | undefined;
    let oldIntact = true;

    try {
      if (existsSync(backupDir)) {
        // The canonical directory might be a candidate from a failed rollback.
        // Neither a pool handle nor .git proves that the last-good index survived.
        oldIntact = false;
        throw new Error(`unfinished CodeGraph promotion at ${backupDir}`);
      }
      // Git reset/clean and CodeGraph sync both write in place. Copy-on-write where
      // supported keeps those writes away from the version currently serving queries.
      await cp(dir, candidateDir, { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true });

      let version: string | null;
      try {
        setInternalStatus("fetching");
        const result = await fetcher.sync(repoUrl, branch, candidateDir);
        version = result.version;
        setInternalStatus("indexing");
        candidateInstance = await indexOps.openIndex(candidateDir);
        await indexOps.syncIndex(candidateInstance);
      } catch (incrementalError) {
        logger?.warn(
          `[code-graph] incremental sync failed for ${codeGraphId}, trying a fresh candidate: ${incrementalError instanceof Error ? incrementalError.message : String(incrementalError)}`,
        );
        if (candidateInstance) indexOps.closeIndex(candidateInstance);
        candidateInstance = undefined;
        await rm(candidateDir, { recursive: true, force: true });
        mkdirSync(candidateDir, { recursive: true });
        setInternalStatus("cloning");
        const result = await fetcher.fetch(repoUrl, branch, candidateDir);
        version = result.version;
        setInternalStatus("indexing");
        candidateInstance = await indexOps.indexProject(candidateDir);
      }

      const stats = statsFor(candidateInstance, indexOps);
      indexOps.closeIndex(candidateInstance);
      candidateInstance = undefined;

      // Release SQLite handles before renaming directories (required on Windows).
      // Query routes already gate processing assets, so no new query starts here.
      setInternalStatus("promoting");
      const oldInstance = instancePool.get(codeGraphId);
      if (oldInstance) indexOps.closeIndex(oldInstance);
      instancePool.delete(codeGraphId);

      try {
        await rename(dir, backupDir);
        oldIntact = false;
        await rename(candidateDir, dir);
        const activeInstance = await indexOps.openIndex(dir);
        instancePool.set(codeGraphId, activeInstance);
      } catch (promotionError) {
        try {
          if (existsSync(backupDir)) {
            if (existsSync(dir)) await rm(dir, { recursive: true, force: true });
            await rename(backupDir, dir);
            oldIntact = true;
          }
          if (oldIntact) instancePool.set(codeGraphId, await indexOps.openIndex(dir));
        } catch (restoreError) {
          oldIntact = false;
          throw new AggregateError([promotionError, restoreError], "CodeGraph promotion and rollback both failed");
        }
        throw promotionError;
      }

      return {
        commitHash: version ?? undefined,
        stats,
        // Keep the old snapshot until CodeGraphService commits the new status.
        finalize: () => rm(backupDir, { recursive: true, force: true }),
        rollback: async () => {
          const activeInstance = instancePool.get(codeGraphId);
          if (activeInstance) indexOps.closeIndex(activeInstance);
          instancePool.delete(codeGraphId);
          if (existsSync(dir)) await rm(dir, { recursive: true, force: true });
          await rename(backupDir, dir);
          instancePool.set(codeGraphId, await indexOps.openIndex(dir));
        },
      };
    } catch (err) {
      if (!oldIntact) throw err;
      // The original directory was never modified, or promotion rolled it back.
      // Restore a lazy pool entry only if the on-disk index can actually be opened.
      if (!instancePool.get(codeGraphId)) {
        try { instancePool.set(codeGraphId, await indexOps.openIndex(dir)); }
        catch (openError) {
          throw new AggregateError([err, openError], "CodeGraph refresh failed and the previous index could not be opened");
        }
      }
      throw new PreservedCodeGraphError(err);
    } finally {
      if (candidateInstance) indexOps.closeIndex(candidateInstance);
      try { await rm(candidateDir, { recursive: true, force: true }); }
      catch (err) { logger?.warn(`[code-graph] could not remove candidate for ${codeGraphId}: ${String(err)}`); }
    }
  };
}

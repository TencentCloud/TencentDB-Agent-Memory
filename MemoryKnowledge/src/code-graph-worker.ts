/** Build a replacement CodeGraph without mutating the last successfully indexed checkout. */

import { randomUUID } from "node:crypto";
import { constants, existsSync, mkdirSync } from "node:fs";
import { cp, rename, rm } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

import { CodeGraphHandleCloseError, closeIndex, getStats, indexProject, openIndex, syncIndex, type CodeGraphInstance } from "./engines/code/index.js";
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
  renameDir?: typeof rename;
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
  const renameDir = options.renameDir ?? rename;
  const leakedCandidates = new Map<string, {
    instance: CodeGraphInstance;
    dir: string;
    closed: boolean;
    registered: boolean;
  }>();

  const retainLeakedCandidate = (id: string, instance: CodeGraphInstance, dir: string): void => {
    const entry = { instance, dir, closed: false, registered: false };
    leakedCandidates.set(id, entry);
    if (instancePool.retainUnclosed) {
      try {
        instancePool.retainUnclosed(id, instance, () => { entry.closed = true; });
        entry.registered = true;
      } catch (err) {
        logger?.warn(`[code-graph] could not register unclosed candidate for ${id}: ${String(err)}`);
      }
    }
  };

  return async (context) => {
    const { dir, repoUrl, branch, codeGraphId, hadReadyIndex, preserveUntrustedCanonical, setInternalStatus } = context;

    const leaked = leakedCandidates.get(codeGraphId);
    if (leaked) {
      // A previous close failed, so the process still holds this SQLite handle.
      // Retry closing it before any new build can touch the filesystem.
      try {
        if (leaked.registered) {
          try { await instancePool.pause?.(codeGraphId); }
          finally { instancePool.resume?.(codeGraphId); }
          if (!leaked.closed) throw new Error(`CodeGraph candidate handle is still open: ${leaked.dir}`);
        } else {
          indexOps.closeIndex(leaked.instance);
          leaked.closed = true;
        }
      } catch (err) { throw hadReadyIndex ? new PreservedCodeGraphError(err) : err; }
      leakedCandidates.delete(codeGraphId);
      try { await rm(leaked.dir, { recursive: true, force: true }); }
      catch (err) { logger?.warn(`[code-graph] could not remove closed candidate for ${codeGraphId}: ${String(err)}`); }
    }
    const fetcher = resolveFetcher(repoUrl);

    // Stop new reads and wait for in-flight reads before touching an index.
    // Rollback must work even when the metadata store is the failed component.
    const withPausedIndex = async <T>(phase: string | undefined, action: () => Promise<T>): Promise<T> => {
      if (phase) setInternalStatus(phase);
      try {
        await instancePool.pause?.(codeGraphId);
        return await action();
      }
      finally { instancePool.resume?.(codeGraphId); }
    };

    // There is no last-good version to preserve on the first build.
    if (!hadReadyIndex && !preserveUntrustedCanonical) {
      // An earlier initial build can fail after opening SQLite (for example,
      // while committing metadata). Drain and close that handle before rm.
      await withPausedIndex(undefined, async () => {
        const stale = instancePool.get(codeGraphId);
        if (stale) {
          indexOps.closeIndex(stale);
          instancePool.delete(codeGraphId);
        }
        await rm(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
      });

      let instance: CodeGraphInstance | undefined;
      try {
        setInternalStatus("cloning");
        const result = await fetcher.fetch(repoUrl, branch, dir);
        setInternalStatus("indexing");
        instance = await indexOps.indexProject(dir);
        // Do not expose the handle until all worker-side steps have succeeded.
        const stats = statsFor(instance, indexOps);
        instancePool.set(codeGraphId, instance);
        return {
          commitHash: result.version ?? undefined,
          stats,
          // A metadata commit failure must not leave a failed asset's SQLite
          // handle open. Retry can then safely replace the partial checkout.
          rollback: () => withPausedIndex(undefined, async () => {
            const active = instancePool.get(codeGraphId);
            if (active) {
              indexOps.closeIndex(active);
              instancePool.delete(codeGraphId);
            }
            await rm(dir, { recursive: true, force: true });
          }),
        };
      } catch (err) {
        if (err instanceof CodeGraphHandleCloseError) {
          // indexProject opened SQLite, then its attempt to close on failure
          // also failed. Keep the handle for the next retry; do not unlink it.
          instancePool.set(codeGraphId, err.unclosedInstance);
          throw err;
        }
        if (instance) {
          try { indexOps.closeIndex(instance); }
          catch (closeError) {
            // Retain the handle so a later retry can close it before deleting
            // the directory; unlinking files underneath it is unsafe.
            instancePool.set(codeGraphId, instance);
            throw new AggregateError([err, closeError], "CodeGraph initial build and index close both failed");
          }
        }
        try { await rm(dir, { recursive: true, force: true }); }
        catch (cleanupError) { logger?.warn(`[code-graph] could not remove failed initial build ${codeGraphId}: ${String(cleanupError)}`); }
        throw err;
      }
    }

    if (preserveUntrustedCanonical) {
      const candidateDir = join(dirname(dir), `.${basename(dir)}.candidate-${randomUUID()}`);
      const suspectDir = `${dir}.suspect`;
      let candidateInstance: CodeGraphInstance | undefined;
      let candidateCloseFailed = false;

      const closeServingHandle = (): void => {
        const old = instancePool.get(codeGraphId);
        if (!old) return;
        // Keep it reachable if close fails; deleting the directory would be
        // unsafe while that SQLite connection may still be open.
        indexOps.closeIndex(old);
        instancePool.delete(codeGraphId);
      };

      try {
        if (existsSync(suspectDir)) {
          throw new Error(`CodeGraph suspect snapshot requires recovery: ${suspectDir}`);
        }
        // The canonical directory is potentially the only surviving snapshot,
        // but its status is failed: never expose it as a last-good index.
        await withPausedIndex(undefined, async () => { closeServingHandle(); });
        mkdirSync(candidateDir, { recursive: true });
        setInternalStatus("cloning");
        const fetched = await fetcher.fetch(repoUrl, branch, candidateDir);
        setInternalStatus("indexing");
        candidateInstance = await indexOps.indexProject(candidateDir);
        const stats = statsFor(candidateInstance, indexOps);
        indexOps.closeIndex(candidateInstance);
        candidateInstance = undefined;

        await withPausedIndex("promoting_suspect", async () => {
          closeServingHandle();
          if (!existsSync(dir)) throw new Error(`CodeGraph suspect canonical disappeared: ${dir}`);
          await renameDir(dir, suspectDir);
          try {
            await renameDir(candidateDir, dir);
            const active = await indexOps.openIndex(dir);
            instancePool.set(codeGraphId, active);
          } catch (err) {
            if (err instanceof CodeGraphHandleCloseError) {
              instancePool.set(codeGraphId, err.unclosedInstance);
              // The live handle prevents safe unlinking. Leave .suspect for
              // startup recovery after this process releases SQLite.
              throw err;
            }
            try {
              if (existsSync(dir)) await rm(dir, { recursive: true, force: true });
              await renameDir(suspectDir, dir);
            } catch (restoreError) {
              throw new AggregateError([err, restoreError], "CodeGraph suspect promotion and rollback both failed");
            }
            throw err;
          }
        });

        return {
          commitHash: fetched.version ?? undefined,
          stats,
          finalize: () => rm(suspectDir, { recursive: true, force: true }),
          rollback: () => withPausedIndex(undefined, async () => {
            closeServingHandle();
            if (existsSync(dir)) await rm(dir, { recursive: true, force: true });
            await renameDir(suspectDir, dir);
            // Restored canonical is still untrusted. A failed row cannot serve
            // it, and a later retry will build another fresh candidate.
          }),
        };
      } catch (err) {
        if (err instanceof CodeGraphHandleCloseError && err.unclosedInstance.projectRoot === candidateDir) {
          candidateInstance = err.unclosedInstance;
        }
        throw err;
      } finally {
        if (candidateInstance) {
          const unclosed = candidateInstance;
          try {
            indexOps.closeIndex(unclosed);
            candidateInstance = undefined;
          } catch (err) {
            candidateCloseFailed = true;
            retainLeakedCandidate(codeGraphId, unclosed, candidateDir);
            logger?.warn(`[code-graph] could not close suspect candidate for ${codeGraphId}: ${String(err)}`);
          }
        }
        if (!candidateCloseFailed) {
          try { await rm(candidateDir, { recursive: true, force: true }); }
          catch (err) { logger?.warn(`[code-graph] could not remove suspect candidate for ${codeGraphId}: ${String(err)}`); }
        }
      }
    }

    const suffix = randomUUID();
    const parent = dirname(dir);
    const name = basename(dir);
    const candidateDir = join(parent, `.${name}.candidate-${suffix}`);
    // Stable name lets startup roll back a promotion interrupted by a process crash.
    const backupDir = `${dir}.previous`;
    let candidateInstance: CodeGraphInstance | undefined;
    let candidateCloseFailed = false;
    let oldIntact = true;
    let closeFailed = false;

    // Keep a handle reachable if close() throws. It may still own a SQLite
    // connection, so neither copying nor renaming may proceed after that error.
    const closePooledIndex = (instance: CodeGraphInstance): void => {
      try {
        indexOps.closeIndex(instance);
        instancePool.delete(codeGraphId);
      } catch (err) {
        instancePool.set(codeGraphId, instance);
        closeFailed = true;
        throw err;
      }
    };

    try {
      await withPausedIndex("copying", async () => {
        // If the pool was not hydrated, open and close once to checkpoint WAL.
        const oldInstance = instancePool.get(codeGraphId) ?? await indexOps.openIndex(dir);
        closePooledIndex(oldInstance);
        if (existsSync(backupDir)) {
          // A retired snapshot is disposable only after the canonical index
          // can be reopened. Otherwise it may be the sole surviving copy.
          const verified = await indexOps.openIndex(dir);
          closePooledIndex(verified);
          await rm(backupDir, { recursive: true, force: true });
        }
        // Git reset/clean and CodeGraph sync both write in place. Copy-on-write
        // where supported keeps those writes away from the serving checkout.
        await cp(dir, candidateDir, {
          recursive: true,
          mode: constants.COPYFILE_FICLONE,
          verbatimSymlinks: true,
          filter: (source) => {
            const parts = relative(dir, source).split(sep);
            if (parts[0] !== ".codegraph" || parts.length < 2) return true;
            const name = parts.at(-1) ?? "";
            return name !== "codegraph.lock" && name !== "daemon.pid" && name !== "daemon.sock" && !name.endsWith(".log");
          },
        });
        // Reopen promptly: network fetch and candidate indexing can take a long
        // time, while queries can keep using the unchanged canonical index.
        instancePool.set(codeGraphId, await indexOps.openIndex(dir));
      });
      setInternalStatus("fetching");

      let version: string | null;
      try {
        const result = await fetcher.sync(repoUrl, branch, candidateDir);
        version = result.version;
        setInternalStatus("indexing");
        candidateInstance = await indexOps.openIndex(candidateDir);
        await indexOps.syncIndex(candidateInstance);
      } catch (incrementalError) {
        if (incrementalError instanceof CodeGraphHandleCloseError) {
          // The candidate may still own SQLite. A fresh clone must not rm it.
          throw incrementalError;
        }
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

      await withPausedIndex("promoting", async () => {
        // Release SQLite handles before renaming directories (required on Windows).
        const oldInstance = instancePool.get(codeGraphId);
        if (oldInstance) closePooledIndex(oldInstance);

        try {
          await renameDir(dir, backupDir);
          oldIntact = false;
          await renameDir(candidateDir, dir);
          const activeInstance = await indexOps.openIndex(dir);
          instancePool.set(codeGraphId, activeInstance);
        } catch (promotionError) {
          if (promotionError instanceof CodeGraphHandleCloseError) {
            instancePool.set(codeGraphId, promotionError.unclosedInstance);
            closeFailed = true;
            // The promoted directory is live through this unclosed handle.
            // Leave .previous for restart recovery instead of unlinking it.
            throw promotionError;
          }
          try {
            if (existsSync(backupDir)) {
              if (existsSync(dir)) await rm(dir, { recursive: true, force: true });
              await renameDir(backupDir, dir);
              oldIntact = true;
            }
            if (oldIntact) instancePool.set(codeGraphId, await indexOps.openIndex(dir));
          } catch (restoreError) {
            oldIntact = false;
            throw new AggregateError([promotionError, restoreError], "CodeGraph promotion and rollback both failed");
          }
          throw promotionError;
        }
      });

      return {
        commitHash: version ?? undefined,
        stats,
        // Keep the old snapshot until CodeGraphService commits the new status.
        finalize: () => rm(backupDir, { recursive: true, force: true }),
        rollback: async () => {
          await withPausedIndex(undefined, async () => {
            const activeInstance = instancePool.get(codeGraphId);
            if (activeInstance) closePooledIndex(activeInstance);
            if (existsSync(dir)) await rm(dir, { recursive: true, force: true });
            await renameDir(backupDir, dir);
            instancePool.set(codeGraphId, await indexOps.openIndex(dir));
          });
        },
      };
    } catch (err) {
      if (err instanceof CodeGraphHandleCloseError) {
        if (err.unclosedInstance.projectRoot === candidateDir) {
          candidateInstance = err.unclosedInstance;
        } else if (err.unclosedInstance.projectRoot === dir) {
          instancePool.set(codeGraphId, err.unclosedInstance);
          closeFailed = true;
        }
      }
      if (!oldIntact || closeFailed) throw err;
      // The original directory was never modified, or promotion rolled it back.
      // Restore a lazy pool entry only if the on-disk index can actually be opened.
      if (!instancePool.get(codeGraphId)) {
        try { instancePool.set(codeGraphId, await indexOps.openIndex(dir)); }
        catch (openError) {
          if (openError instanceof CodeGraphHandleCloseError) {
            instancePool.set(codeGraphId, openError.unclosedInstance);
          }
          throw new AggregateError([err, openError], "CodeGraph refresh failed and the previous index could not be opened");
        }
      }
      throw new PreservedCodeGraphError(err);
    } finally {
      if (candidateInstance) {
        const unclosed = candidateInstance;
        try {
          indexOps.closeIndex(unclosed);
          candidateInstance = undefined;
        } catch (err) {
          candidateCloseFailed = true;
          retainLeakedCandidate(codeGraphId, unclosed, candidateDir);
          logger?.warn(`[code-graph] could not close candidate for ${codeGraphId}: ${String(err)}`);
        }
      }
      if (!candidateCloseFailed) {
        try { await rm(candidateDir, { recursive: true, force: true }); }
        catch (err) { logger?.warn(`[code-graph] could not remove candidate for ${codeGraphId}: ${String(err)}`); }
      }
    }
  };
}

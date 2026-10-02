/**
 * Real code-graph worker: fetch/sync via a protocol-specific SourceFetcher + indexing.
 *
 * Extracted from module.ts so the sync/fallback behaviour is unit-testable.
 *
 * Fixes #1516: the incremental-sync catch used to `rmSync` the existing checkout
 * (last known-good checkout + index) BEFORE attempting the fallback fresh clone —
 * a transient remote failure then destroyed the good state, the fresh clone failed
 * too, and the CodeGraph ended up "failed" with an empty directory while query
 * endpoints still returned a successful-looking empty result.
 *
 * Failure semantics after the fix:
 *   - incremental sync fails → the existing checkout/index is PRESERVED and the
 *     fresh clone is staged into a sibling directory;
 *   - staged clone + index succeed → swap into place (rm old + rename staging;
 *     same-volume synchronous sequence, no await in between);
 *   - staged clone also fails → staging removed, error propagates (runBuild marks
 *     the graph "failed"), and the previous good state stays on disk queryable.
 */
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CodeGraphWorker } from "./store/code-graph-service.js";
import type { CodeGraphInstance } from "./engines/code.js";

/** Protocol-specific fetch adapter (resolved per repoUrl; https-only + SSRF-validated upstream). */
export interface CodeGraphFetcherAdapter {
  sync(repoUrl: string, branch: string, dir: string): Promise<{ version: string | null }>;
  fetch(repoUrl: string, branch: string, dir: string): Promise<{ version: string | null }>;
}

export interface CodeGraphWorkerDeps {
  resolveFetcher(repoUrl: string): CodeGraphFetcherAdapter;
  instancePool: {
    get(codeGraphId: string): CodeGraphInstance | undefined;
    set(codeGraphId: string, instance: CodeGraphInstance): void;
  };
  openIndex(dir: string): Promise<CodeGraphInstance>;
  syncIndex(instance: CodeGraphInstance): Promise<unknown>;
  indexProject(dir: string): Promise<CodeGraphInstance>;
  getStats(
    instance: CodeGraphInstance,
  ): { fileCount?: number; files?: number; nodeCount?: number; nodes?: number; edgeCount?: number; edges?: number } | undefined;
  log?: { info?(msg: string): void; warn?(msg: string): void };
}

export function createCodeGraphWorker(deps: CodeGraphWorkerDeps): CodeGraphWorker {
  const { resolveFetcher, instancePool, openIndex, syncIndex, indexProject, getStats, log } = deps;

  return async (ctx) => {
    const { dir, repoUrl, branch, codeGraphId, setInternalStatus } = ctx;

    const fetcher = resolveFetcher(repoUrl);

    const isExistingRepo = existsSync(join(dir, ".git"));
    let didIncrementalSync = false;
    let version: string | null = null;

    if (isExistingRepo) {
      try {
        setInternalStatus("fetching");
        const res = await fetcher.sync(repoUrl, branch, dir);
        version = res.version;

        setInternalStatus("indexing");
        let instance = instancePool.get(codeGraphId);
        if (!instance) {
          instance = await openIndex(dir);
        }
        await syncIndex(instance);
        instancePool.set(codeGraphId, instance);
        didIncrementalSync = true;
      } catch (err) {
        // #1516: incremental failure must NOT destroy the existing checkout/index.
        // The fresh clone below is staged into a sibling directory and swapped in
        // only after it succeeds; if staging fails too, the error propagates and
        // the last known-good state stays on disk, queryable via the old index.
        log?.warn?.(
          `[code-graph] incremental sync failed for ${codeGraphId}, retrying via staged fresh clone (existing checkout preserved): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (!didIncrementalSync) {
      const hasExisting = existsSync(dir);
      const staging = hasExisting ? `${dir}.staging` : dir;
      try {
        if (hasExisting) {
          // Stage the fresh clone away from the live directory; swap in only on success.
          rmSync(staging, { recursive: true, force: true });
          mkdirSync(staging, { recursive: true });
          setInternalStatus("cloning");
          const res = await fetcher.fetch(repoUrl, branch, staging);
          version = res.version;

          setInternalStatus("indexing");
          const instance = await indexProject(staging);
          // Synchronous swap (no await between rm and rename). Same-volume rename
          // after rm: Windows cannot atomically rename over an existing directory,
          // so the tiny non-atomic window covers synchronous statements only.
          rmSync(dir, { recursive: true, force: true });
          renameSync(staging, dir);
          instancePool.set(codeGraphId, instance);
        } else {
          mkdirSync(dir, { recursive: true });
          setInternalStatus("cloning");
          const res = await fetcher.fetch(repoUrl, branch, dir);
          version = res.version;

          setInternalStatus("indexing");
          const instance = await indexProject(dir);
          instancePool.set(codeGraphId, instance);
        }
      } catch (err) {
        if (staging !== dir) {
          try {
            rmSync(staging, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }
        throw err;
      }
    }

    const instance = instancePool.get(codeGraphId);
    const rawStats = instance ? getStats(instance) : undefined;
    const stats = rawStats
      ? { files: rawStats.fileCount ?? rawStats.files ?? 0, nodes: rawStats.nodeCount ?? rawStats.nodes ?? 0, edges: rawStats.edgeCount ?? rawStats.edges ?? 0 }
      : undefined;
    return { commitHash: version ?? undefined, stats };
  };
}

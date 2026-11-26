import { lstat, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { isRepoManifestSource } from "../../source-fetcher/repo-manifest.js";
import type { ISourceFetcher } from "../../source-fetcher/types.js";
import type { CodeGraphBuildContext, CodeGraphBuildResult } from "../../store/code-graph-service.js";
import type { CodeGraphRow } from "../../store/types.js";
import { closeIndex, getStats, indexProject, openIndex, type CodeGraphInstance } from "./bridge.js";

const versionPattern = /^[a-f0-9]{64}$/;
const stagePattern = /^\.repo-stage-[a-zA-Z0-9]{6}$/;
const activeReaders = new Map<string, number>();

export function manifestIndexVersion(row: Pick<CodeGraphRow, "repo_url" | "commit_hash">): string | undefined {
  if (isRepoManifestSource(row.repo_url) && row.commit_hash && versionPattern.test(row.commit_hash)) {
    return row.commit_hash;
  }
}

export async function buildRepoWorkspace(
  ctx: CodeGraphBuildContext,
  fetcher: ISourceFetcher,
): Promise<CodeGraphBuildResult> {
  const { dir, repoUrl, branch, previousCommitHash, setInternalStatus } = ctx;
  await mkdir(dir, { recursive: true });

  // SQLite selects the published workspace. Reclaim directories left by previous
  // syncs or interrupted builds, while preserving the published one and active reads.
  for (const name of await readdir(dir)) {
    if (name === previousCommitHash || (!versionPattern.test(name) && !stagePattern.test(name))) continue;
    const path = join(dir, name);
    if (!activeReaders.has(path)) await rm(path, { recursive: true, force: true });
  }

  const stage = await mkdtemp(join(dir, ".repo-stage-"));
  try {
    const { version } = await fetcher.fetch(repoUrl, branch, stage);
    if (!version || !versionPattern.test(version)) throw new Error("Invalid repo manifest workspace version");
    const snapshot = join(dir, version);

    setInternalStatus("indexing");
    // An unchanged workspace can reuse its complete index.
    const existing = await queryRepoWorkspace(dir, version, (instance) => ({
      commitHash: version, stats: getIndexStats(instance),
    }));
    if (existing) return existing;

    const instance = await indexProject(stage);
    let stats: CodeGraphBuildResult["stats"];
    try {
      stats = getIndexStats(instance);
    } finally {
      closeIndex(instance);
    }
    await rename(stage, snapshot);
    return { commitHash: version, stats };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function queryRepoWorkspace<T>(
  dir: string,
  version: string,
  query: (instance: CodeGraphInstance) => T | Promise<T>,
): Promise<T | undefined> {
  const path = join(dir, version);
  activeReaders.set(path, (activeReaders.get(path) ?? 0) + 1);
  let instance: CodeGraphInstance | undefined;
  try {
    try {
      if (!(await lstat(path)).isDirectory()) return undefined;
      instance = await openIndex(path, { readOnly: true });
    } catch {
      return undefined;
    }
    return await query(instance);
  } finally {
    if (instance) closeIndex(instance);
    const remaining = activeReaders.get(path)! - 1;
    if (remaining) activeReaders.set(path, remaining);
    else activeReaders.delete(path);
  }
}

function getIndexStats(instance: CodeGraphInstance): CodeGraphBuildResult["stats"] {
  const raw = getStats(instance);
  return raw && {
    files: raw.fileCount ?? raw.files ?? 0,
    nodes: raw.nodeCount ?? raw.nodes ?? 0,
    edges: raw.edgeCount ?? raw.edges ?? 0,
  };
}

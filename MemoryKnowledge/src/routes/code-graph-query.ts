import { executeTool } from "../engines/code/index.js";
import { manifestIndexVersion, queryRepoWorkspace } from "../engines/code/repo-workspace.js";
import type { CodeGraphInstancePool } from "../module.js";
import type { CodeGraphRow } from "../store/types.js";
import { isRepoManifestSource } from "../source-fetcher/repo-manifest.js";

export async function queryCodeGraph(
  row: CodeGraphRow,
  dir: string,
  pool: CodeGraphInstancePool,
  toolName: Parameters<typeof executeTool>[1],
  params: Record<string, unknown>,
): Promise<{ text: string; isError: boolean } | undefined> {
  const version = manifestIndexVersion(row);
  if (version) {
    // The selected snapshot determines the project for every manifest query.
    return queryRepoWorkspace(dir, version, (instance) =>
      executeTool(instance, toolName, { ...params, projectPath: undefined }));
  }
  if (row.status !== "ready" || isRepoManifestSource(row.repo_url)) {
    return { text: "", isError: false };
  }

  const instance = pool.get(row.code_graph_id) ?? await pool.loadIfMissing?.(row.code_graph_id, dir);
  return instance && executeTool(instance, toolName, params);
}

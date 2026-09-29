import { verifiedCodeGraphHead } from "./code-graph-recovery.js";
import { SourceVersionProbeError, type ISourceFetcher } from "./source-fetcher/index.js";
import type { CodeGraphVersionProbe } from "./store/code-graph-service.js";

export interface CodeGraphVersionProbeOptions {
  resolveFetcher: (repoUrl: string) => ISourceFetcher;
  verifyHead?: (dir: string) => string | null;
}

/** Build the read-only automatic-sync probe without coupling the service to Git. */
export function createCodeGraphVersionProbe(options: CodeGraphVersionProbeOptions): CodeGraphVersionProbe {
  const verifyHead = options.verifyHead ?? verifiedCodeGraphHead;

  return async (row, dir) => {
    const fetcher = options.resolveFetcher(row.repo_url);
    if (!fetcher.probeVersion) return { kind: "unsupported" };

    const verifiedLocal = verifyHead(dir);
    if (!verifiedLocal) {
      return { kind: "refresh_required", reason: "canonical checkout or index is not verifiable" };
    }

    try {
      const { localVersion, remoteVersion } = await fetcher.probeVersion(row.repo_url, row.branch, dir);
      if (localVersion.toLowerCase() !== verifiedLocal.toLowerCase()) {
        return { kind: "refresh_required", reason: "canonical HEAD changed during version probe" };
      }
      return localVersion.toLowerCase() === remoteVersion.toLowerCase()
        ? { kind: "unchanged", revision: remoteVersion }
        : { kind: "changed", localRevision: localVersion, remoteRevision: remoteVersion };
    } catch (err) {
      if (err instanceof SourceVersionProbeError) {
        if (err.code === "local_unavailable") {
          return { kind: "refresh_required", reason: err.message };
        }
        return { kind: "failed", code: err.code, retryable: true, message: err.message };
      }
      return {
        kind: "failed", code: "remote_error", retryable: true,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  };
}
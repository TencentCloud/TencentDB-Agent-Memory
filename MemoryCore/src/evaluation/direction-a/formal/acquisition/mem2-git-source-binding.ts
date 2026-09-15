import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { sha256 } from "../core/canonical.js";

export const GIT_COMMITTED_BLOB_BYTES = "GIT_COMMITTED_BLOB_BYTES" as const;

export interface CommittedGitSourceBinding {
  sourcePath: string;
  gitBlobOid: string;
  gitBlobSha256: string;
}

function gitText(workingDirectory: string, args: string[]): string {
  return execFileSync("git", args, { cwd: workingDirectory, encoding: "utf8", windowsHide: true }).trim();
}

function repositoryRelativePath(workingDirectory: string, sourcePath: string): { repositoryRoot: string; relativePath: string } {
  const repositoryRoot = path.resolve(gitText(workingDirectory, ["rev-parse", "--show-toplevel"]));
  const absoluteSource = path.resolve(workingDirectory, sourcePath);
  const relativePath = path.relative(repositoryRoot, absoluteSource).replace(/\\/g, "/");
  if (!relativePath || relativePath === ".." || relativePath.startsWith("../") || path.isAbsolute(relativePath)) {
    throw new Error("MEM2_SOURCE_BINDING_PATH_OUTSIDE_REPOSITORY");
  }
  return { repositoryRoot, relativePath };
}

export function readCommittedGitSourceBinding(input: {
  workingDirectory: string;
  sourcePath: string;
  commit: string;
}): CommittedGitSourceBinding {
  const { repositoryRoot, relativePath } = repositoryRelativePath(input.workingDirectory, input.sourcePath);
  const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", relativePath], {
    cwd: repositoryRoot, encoding: "utf8", windowsHide: true,
  });
  if (tracked.status !== 0) throw new Error("MEM2_SOURCE_BINDING_WRONG_OR_UNTRACKED_PATH");
  let bytes: Buffer;
  let gitBlobOid: string;
  try {
    bytes = execFileSync("git", ["show", `${input.commit}:${relativePath}`], {
      cwd: repositoryRoot, encoding: null, windowsHide: true,
    });
    gitBlobOid = gitText(repositoryRoot, ["rev-parse", `${input.commit}:${relativePath}`]);
  } catch {
    throw new Error("MEM2_SOURCE_BINDING_COMMITTED_BLOB_MISSING");
  }
  if (!/^[a-f0-9]{40,64}$/.test(gitBlobOid)) throw new Error("MEM2_SOURCE_BINDING_BLOB_OID_INVALID");
  return { sourcePath: relativePath, gitBlobOid, gitBlobSha256: sha256(bytes) };
}

export function assertCommittedGitSourceBinding(input: {
  workingDirectory: string;
  sourcePath: string;
  expectedCommit: string;
  expectedTree: string;
  expectedSha256: string;
  expectedGitBlobOid?: string;
}): CommittedGitSourceBinding {
  const liveCommit = gitText(input.workingDirectory, ["rev-parse", "HEAD"]);
  const liveTree = gitText(input.workingDirectory, ["rev-parse", "HEAD^{tree}"]);
  if (liveCommit !== input.expectedCommit) throw new Error("MEM2_SOURCE_BINDING_HEAD_DRIFT");
  if (liveTree !== input.expectedTree) throw new Error("MEM2_SOURCE_BINDING_TREE_DRIFT");
  const absoluteSource = path.resolve(input.workingDirectory, input.sourcePath);
  if (!existsSync(absoluteSource) || !statSync(absoluteSource).isFile()) {
    throw new Error("MEM2_SOURCE_BINDING_WORKTREE_FILE_MISSING");
  }
  const { repositoryRoot, relativePath } = repositoryRelativePath(input.workingDirectory, input.sourcePath);
  const clean = spawnSync("git", ["diff", "--quiet", "HEAD", "--", relativePath], {
    cwd: repositoryRoot, windowsHide: true,
  });
  if (clean.status === 1) throw new Error("MEM2_SOURCE_BINDING_TRACKED_SOURCE_DIRTY");
  if (clean.status !== 0) throw new Error("MEM2_SOURCE_BINDING_CLEAN_CHECK_FAILED");
  const binding = readCommittedGitSourceBinding({
    workingDirectory: input.workingDirectory, sourcePath: input.sourcePath, commit: input.expectedCommit,
  });
  if (binding.gitBlobSha256 !== input.expectedSha256) throw new Error("MEM2_SOURCE_BINDING_GIT_BLOB_SHA_DRIFT");
  if (input.expectedGitBlobOid !== undefined && binding.gitBlobOid !== input.expectedGitBlobOid) {
    throw new Error("MEM2_SOURCE_BINDING_GIT_BLOB_OID_DRIFT");
  }
  return binding;
}

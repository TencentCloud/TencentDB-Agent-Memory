import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertCommittedGitSourceBinding, readCommittedGitSourceBinding }
  from "./acquisition/mem2-git-source-binding.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function fixture(): { root: string; commit: string; tree: string; sha: string; oid: string } {
  const root = mkdtempSync(path.join(tmpdir(), "mem2-source-binding-")); roots.push(root);
  const git = (args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  git(["init", "--quiet"]); git(["config", "user.name", "Mem2 Test"]); git(["config", "user.email", "mem2@example.invalid"]);
  writeFileSync(path.join(root, ".gitattributes"), "*.ts text\n", "utf8");
  writeFileSync(path.join(root, "bound.ts"), "export const a = 1;\nexport const b = 2;\n", "utf8");
  writeFileSync(path.join(root, "other.ts"), "export const other = true;\n", "utf8");
  git(["add", ".gitattributes", "bound.ts", "other.ts"]); git(["commit", "--quiet", "-m", "fixture"]);
  const commit = git(["rev-parse", "HEAD"]), tree = git(["rev-parse", "HEAD^{tree}"]);
  const binding = readCommittedGitSourceBinding({ workingDirectory: root, sourcePath: "bound.ts", commit });
  return { root, commit, tree, sha: binding.gitBlobSha256, oid: binding.gitBlobOid };
}

describe("Mem2 committed Git source binding", () => {
  it("accepts a Git-clean CRLF checkout of an LF committed blob", () => {
    const f = fixture(); writeFileSync(path.join(f.root, "bound.ts"), "export const a = 1;\r\nexport const b = 2;\r\n", "utf8");
    expect(assertCommittedGitSourceBinding({ workingDirectory: f.root, sourcePath: "bound.ts", expectedCommit: f.commit,
      expectedTree: f.tree, expectedSha256: f.sha, expectedGitBlobOid: f.oid }).gitBlobSha256).toBe(f.sha);
  });
  it("accepts an LF checkout", () => {
    const f = fixture(); expect(assertCommittedGitSourceBinding({ workingDirectory: f.root, sourcePath: "bound.ts",
      expectedCommit: f.commit, expectedTree: f.tree, expectedSha256: f.sha }).gitBlobSha256).toBe(f.sha);
  });
  it("fails closed on a real tracked-source modification", () => {
    const f = fixture(); writeFileSync(path.join(f.root, "bound.ts"), "export const a = 9;\n", "utf8");
    expect(() => assertCommittedGitSourceBinding({ workingDirectory: f.root, sourcePath: "bound.ts",
      expectedCommit: f.commit, expectedTree: f.tree, expectedSha256: f.sha })).toThrow("TRACKED_SOURCE_DIRTY");
  });
  it("fails closed on a request Git-blob SHA mismatch", () => {
    const f = fixture(); expect(() => assertCommittedGitSourceBinding({ workingDirectory: f.root, sourcePath: "bound.ts",
      expectedCommit: f.commit, expectedTree: f.tree, expectedSha256: "0".repeat(64) })).toThrow("GIT_BLOB_SHA_DRIFT");
  });
  it("fails closed on HEAD or tree drift", () => {
    const f = fixture(); expect(() => assertCommittedGitSourceBinding({ workingDirectory: f.root, sourcePath: "bound.ts",
      expectedCommit: "0".repeat(40), expectedTree: f.tree, expectedSha256: f.sha })).toThrow("HEAD_DRIFT");
    expect(() => assertCommittedGitSourceBinding({ workingDirectory: f.root, sourcePath: "bound.ts",
      expectedCommit: f.commit, expectedTree: "0".repeat(40), expectedSha256: f.sha })).toThrow("TREE_DRIFT");
  });
  it("fails closed on a missing bound source", () => {
    const f = fixture(); rmSync(path.join(f.root, "bound.ts"));
    expect(() => assertCommittedGitSourceBinding({ workingDirectory: f.root, sourcePath: "bound.ts",
      expectedCommit: f.commit, expectedTree: f.tree, expectedSha256: f.sha })).toThrow("WORKTREE_FILE_MISSING");
  });
  it("fails closed on a wrong source path", () => {
    const f = fixture(); writeFileSync(path.join(f.root, "unknown.ts"), "export const unknown = true;\n", "utf8");
    expect(() => assertCommittedGitSourceBinding({ workingDirectory: f.root, sourcePath: "unknown.ts",
      expectedCommit: f.commit, expectedTree: f.tree, expectedSha256: f.sha })).toThrow("WRONG_OR_UNTRACKED_PATH");
  });
});

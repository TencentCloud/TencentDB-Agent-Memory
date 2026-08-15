import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitStorageBackend, buildBranchName, type GitStorageBackendOptions } from "./git-backend.js";
import { StaticGitCredentialProvider } from "./git-credential.js";
import { runGit } from "./git-cli.js";
import { runStorageBackendContractTests } from "./__tests__/storage-backend.contract.js";
import { FakeStateBackend } from "./__tests__/fake-state-backend.js";

async function makeBareRemote(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "storage-git-remote-"));
  await runGit(["init", "--quiet", "--bare"], { cwd: dir });
  return dir;
}

function makeBackend(remoteDir: string, localRootDir: string, overrides: Partial<GitStorageBackendOptions> = {}) {
  return new GitStorageBackend({
    localRootDir,
    remoteUrl: remoteDir,
    credentialProvider: new StaticGitCredentialProvider({ authMethod: "http-token", token: "unused-for-local-remote" }),
    branchNameSeed: { tenantId: "test-tenant", instanceId: randomUUID() },
    stateBackend: new FakeStateBackend(),
    batchWindowMs: 0,
    ...overrides,
  });
}

runStorageBackendContractTests("GitStorageBackend", async () => {
  const remoteDir = await makeBareRemote();
  const localRootDir = await mkdtemp(join(tmpdir(), "storage-git-local-"));
  const backend = makeBackend(remoteDir, localRootDir);
  return {
    backend,
    teardown: async () => {
      await backend.flush().catch(() => {});
      await rm(remoteDir, { recursive: true, force: true });
      await rm(localRootDir, { recursive: true, force: true });
    },
  };
});

describe("GitStorageBackend — backend-specific behavior", () => {
  let remoteDir: string;
  let localRootDir: string;

  beforeEach(async () => {
    remoteDir = await makeBareRemote();
    localRootDir = await mkdtemp(join(tmpdir(), "storage-git-local-"));
  });

  afterEach(async () => {
    await rm(remoteDir, { recursive: true, force: true });
    await rm(localRootDir, { recursive: true, force: true });
  });

  it("reports type 'git'", () => {
    const backend = makeBackend(remoteDir, localRootDir);
    expect(backend.type).toBe("git");
  });

  it("pushes a commit to the remote containing only the written key, no .meta.json sidecar", async () => {
    const backend = makeBackend(remoteDir, localRootDir);
    await backend.putObject("scene_blocks/note.md", "hello", { contentType: "text/markdown", metadata: { a: "b" } });
    await backend.flush();

    const checkoutDir = await mkdtemp(join(tmpdir(), "storage-git-checkout-"));
    try {
      await runGit(["clone", "--quiet", remoteDir, checkoutDir], { cwd: process.cwd() });
      const branches = await runGit(["branch", "-r"], { cwd: checkoutDir });
      const branchName = branches.stdout.trim().split("\n").map((l) => l.replace("origin/", "").trim())[0]!;
      await runGit(["checkout", "--quiet", branchName], { cwd: checkoutDir });
      const lsFiles = await runGit(["ls-files"], { cwd: checkoutDir });
      const files = lsFiles.stdout.trim().split("\n").filter(Boolean);
      expect(files).toContain("scene_blocks/note.md");
      expect(files.some((f) => f.endsWith(".meta.json"))).toBe(false);
      expect(files.some((f) => f.startsWith(".git"))).toBe(false);
    } finally {
      await rm(checkoutDir, { recursive: true, force: true });
    }
  });

  it("metadata does not survive a fresh clone of the same space (accepted limitation)", async () => {
    const seed = { tenantId: "meta-tenant", instanceId: randomUUID() };
    const stateBackend = new FakeStateBackend();
    const backendA = makeBackend(remoteDir, localRootDir, { branchNameSeed: seed, stateBackend });
    await backendA.putObject("persona.md", "v1", { contentType: "text/markdown", metadata: { a: "b" } });
    await backendA.flush();
    const objA = await backendA.getObject("persona.md");
    expect(objA!.contentType).toBe("text/markdown");

    const otherRoot = await mkdtemp(join(tmpdir(), "storage-git-local2-"));
    try {
      const backendB = makeBackend(remoteDir, otherRoot, { branchNameSeed: seed, stateBackend: new FakeStateBackend() });
      const objB = await backendB.getObject("persona.md");
      expect(objB!.content.toString("utf-8")).toBe("v1");
      expect(objB!.contentType).toBeUndefined();
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  it("rejects a key resolving into the .git control directory", async () => {
    const backend = makeBackend(remoteDir, localRootDir);
    await expect(backend.putObject(".git/config", "evil")).rejects.toThrow(/git control directory/i);
    await expect(backend.getObject(".git/HEAD")).rejects.toThrow(/git control directory/i);
  });

  it("initializes a brand-new space with an orphan branch when the remote has no matching branch yet", async () => {
    const backend = makeBackend(remoteDir, localRootDir);
    await backend.putObject("persona.md", "hello");
    await backend.flush();
    const summary = backend.getSyncSummary();
    expect(summary.status).toBe("clean");
    expect(summary.pendingCount).toBe(0);
    expect(summary.lastPushedAt).not.toBeNull();
  });

  it("second space's clone only contains its own branch (single-branch fetch)", async () => {
    const stateBackend = new FakeStateBackend();
    const seedA = { tenantId: "t", instanceId: "space-a" };
    const seedB = { tenantId: "t", instanceId: "space-b" };

    const backendA = makeBackend(remoteDir, localRootDir, { branchNameSeed: seedA, stateBackend });
    await backendA.putObject("persona.md", "a");
    await backendA.flush();

    // backendB clones after space-a's branch already exists on the remote —
    // this is the scenario `--single-branch` matters for.
    const backendB = makeBackend(remoteDir, localRootDir, { branchNameSeed: seedB, stateBackend: new FakeStateBackend() });
    await backendB.putObject("persona.md", "b");
    await backendB.flush();

    const branchNameA = buildBranchName(seedA);
    const branchNameB = buildBranchName(seedB);
    const cloneDirB = join(localRootDir, "clones", branchNameB.replace(/\//g, "_"));

    const remoteRefs = await runGit(["branch", "-r"], { cwd: cloneDirB });
    const refs = remoteRefs.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    expect(refs).toEqual([`origin/${branchNameB}`]);
    expect(refs.some((r) => r.includes(branchNameA))).toBe(false);

    const objInB = await backendB.getObject("persona.md");
    expect(objInB!.content.toString("utf-8")).toBe("b");
  });
});

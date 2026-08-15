import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitStorageBackend, buildBranchName, type GitStorageBackendOptions } from "./git-backend.js";
import { StaticGitCredentialProvider } from "./git-credential.js";
import { gitCheckRefFormat, runGit } from "./git-cli.js";
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
    branchNameSeed: { tenantId: "test-tenant", instanceId: "default-instance" },
    stateBackend: new FakeStateBackend(),
    batchWindowMs: 0,
    ...overrides,
  });
}

describe("GitStorageBackend — crash recovery", () => {
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

  it("recovers a local commit that landed before a crash cut off the push, and completes the push", async () => {
    const seed = { tenantId: "recover", instanceId: "space-1" };

    // Backend A: write, then force the push half of flush() to fail by
    // moving the remote out of the way after commit-but-before-push would
    // run — simulating "process crashed after local commit, before push
    // confirmed", the scenario the WAL + local-commit-trailer scan exist for.
    const backendA = makeBackend(remoteDir, localRootDir, { branchNameSeed: seed, batchWindowMs: 999_999 });
    await backendA.putObject("persona.md", "hello");

    const movedAwayRemote = `${remoteDir}-moved-away`;
    const { rename } = await import("node:fs/promises");
    await rename(remoteDir, movedAwayRemote);
    await expect(backendA.flush()).rejects.toThrow();
    expect(backendA.getSyncSummary().status).toBe("push-failed");
    await rename(movedAwayRemote, remoteDir);

    // Backend B: fresh instance, same localRootDir + same branch seed —
    // simulates a process restart reusing the same on-disk clone.
    const backendB = makeBackend(remoteDir, localRootDir, { branchNameSeed: seed });
    const obj = await backendB.getObject("persona.md");
    expect(obj!.content.toString("utf-8")).toBe("hello");

    await backendB.flush();
    expect(backendB.getSyncSummary().status).toBe("clean");
    expect(backendB.getSyncSummary().pendingCount).toBe(0);

    // Confirm it's actually on the remote now, from an independent checkout.
    const checkoutDir = await mkdtemp(join(tmpdir(), "storage-git-checkout-"));
    try {
      const branchName = buildBranchName(seed);
      await runGit(["clone", "--quiet", "--single-branch", "--branch", branchName, remoteDir, checkoutDir], {
        cwd: process.cwd(),
      });
      const { readFile } = await import("node:fs/promises");
      const content = await readFile(join(checkoutDir, "persona.md"), "utf-8");
      expect(content).toBe("hello");
    } finally {
      await rm(checkoutDir, { recursive: true, force: true });
    }
  });

  it("a metadata write does not permanently block recovery after a restart (Codex checkpoint B #1)", async () => {
    // .meta.json sidecars are never staged (local-only by design) and show
    // up as an untracked file in `git status` forever after — recovery must
    // not mistake that for unexplained dirt, or every space that ever used
    // contentType/metadata would brick itself (recoveryBlocked) on restart.
    const seed = { tenantId: "meta-restart", instanceId: "space-1" };
    const backendA = makeBackend(remoteDir, localRootDir, { branchNameSeed: seed });
    await backendA.putObject("persona.md", "hello", { contentType: "text/markdown", metadata: { a: "b" } });
    await backendA.flush();
    expect(backendA.getSyncSummary().status).toBe("clean");

    const backendB = makeBackend(remoteDir, localRootDir, { branchNameSeed: seed, stateBackend: new FakeStateBackend() });
    await backendB.putObject("scene_blocks/x.md", "y");
    await backendB.flush();
    expect(backendB.getSyncSummary().status).toBe("clean");
    expect(backendB.getSyncSummary().pendingCount).toBe(0);
  });

  it("recovery reapplies a WAL-recorded op whose mutation never reached disk (Codex checkpoint B #2)", async () => {
    // Simulates a crash landing exactly between the WAL append (now
    // write-ahead) and the actual file mutation: hand-write a WAL entry
    // whose content was never applied to the worktree, then start a fresh
    // instance and confirm recovery reapplies (not silently drops) it.
    const seed = { tenantId: "wal-order", instanceId: "space-1" };
    const backendA = makeBackend(remoteDir, localRootDir, { branchNameSeed: seed });
    await backendA.putObject("persona.md", "base");
    await backendA.flush();

    const branchDirName = buildBranchName(seed).replace(/\//g, "_");
    const stateDir = join(localRootDir, "state", branchDirName);
    const { mkdir: mkdirFn, appendFile, readFile: readFileFn } = await import("node:fs/promises");
    const { randomUUID } = await import("node:crypto");
    await mkdirFn(stateDir, { recursive: true });
    const entry = {
      opId: randomUUID(),
      kind: "append",
      key: "records/log.jsonl",
      contentBase64: Buffer.from("line1\n", "utf-8").toString("base64"),
      ts: Date.now(),
    };
    await appendFile(join(stateDir, "pending-ops.jsonl"), `${JSON.stringify(entry)}\n`);

    const backendB = makeBackend(remoteDir, localRootDir, { branchNameSeed: seed, stateBackend: new FakeStateBackend() });
    await backendB.flush();
    expect(backendB.getSyncSummary().status).toBe("clean");

    const checkoutDir = await mkdtemp(join(tmpdir(), "storage-git-checkout-"));
    try {
      const branchName = buildBranchName(seed);
      await runGit(["clone", "--quiet", "--single-branch", "--branch", branchName, remoteDir, checkoutDir], {
        cwd: process.cwd(),
      });
      const content = await readFileFn(join(checkoutDir, "records/log.jsonl"), "utf-8");
      expect(content).toBe("line1\n");
    } finally {
      await rm(checkoutDir, { recursive: true, force: true });
    }
  });
});

describe("GitStorageBackend — push-rejected replay", () => {
  let remoteDir: string;
  let localRootA: string;
  let localRootB: string;

  beforeEach(async () => {
    remoteDir = await makeBareRemote();
    localRootA = await mkdtemp(join(tmpdir(), "storage-git-local-a-"));
    localRootB = await mkdtemp(join(tmpdir(), "storage-git-local-b-"));
  });

  afterEach(async () => {
    await rm(remoteDir, { recursive: true, force: true });
    await rm(localRootA, { recursive: true, force: true });
    await rm(localRootB, { recursive: true, force: true });
  });

  it("replays only the un-landed op after a non-fast-forward rejection, with no duplication", async () => {
    const seed = { tenantId: "replay", instanceId: "space-1" };

    // Two independent "processes" — separate local clones AND separate
    // FakeStateBackend instances (uncoordinated locks), which is exactly
    // the multi-writer scenario that produces a real push rejection.
    const backendA = makeBackend(remoteDir, localRootA, { branchNameSeed: seed, stateBackend: new FakeStateBackend() });
    await backendA.putObject("records/log.jsonl", "");
    await backendA.flush();

    // backendB clones after the base state exists.
    const backendB = makeBackend(remoteDir, localRootB, { branchNameSeed: seed, stateBackend: new FakeStateBackend() });
    await backendB.getObject("records/log.jsonl"); // triggers clone

    // backendA advances the branch first.
    await backendA.appendObject("records/log.jsonl", "fromA\n");
    await backendA.flush();
    expect(backendA.getSyncSummary().status).toBe("clean");

    // backendB, still based on the pre-fromA state, appends and flushes —
    // its first push attempt must be rejected and trigger a replay.
    await backendB.appendObject("records/log.jsonl", "fromB\n");
    await backendB.flush();
    expect(backendB.getSyncSummary().status).toBe("clean");
    expect(backendB.getSyncSummary().pendingCount).toBe(0);

    const checkoutDir = await mkdtemp(join(tmpdir(), "storage-git-checkout-"));
    try {
      const branchName = buildBranchName(seed);
      await runGit(["clone", "--quiet", "--single-branch", "--branch", branchName, remoteDir, checkoutDir], {
        cwd: process.cwd(),
      });
      const { readFile } = await import("node:fs/promises");
      const content = await readFile(join(checkoutDir, "records/log.jsonl"), "utf-8");
      expect(content).toBe("fromA\nfromB\n");

      const log = await runGit(["log", "--oneline", branchName], { cwd: checkoutDir });
      const commitCount = log.stdout.trim().split("\n").filter(Boolean).length;
      // init + base put + fromA + fromB(replayed) = 4 commits, no duplicate/extra commits from replay.
      expect(commitCount).toBe(4);
    } finally {
      await rm(checkoutDir, { recursive: true, force: true });
    }
  });

  it("recovery does not re-apply an op whose trailer is already in the cloned history (lost-ack scenario)", async () => {
    // Simulates: a push actually succeeded on the remote, but the local
    // process crashed/timed out before persisting that fact (WAL never got
    // trimmed). A *fresh* instance clones the space — its local history
    // already contains the pushed commit's "Ops: <id>" trailer — and its WAL
    // is hand-seeded with a pending entry using that exact op id, exactly as
    // if this process had written it but never confirmed the push. Recovery
    // must recognize the op as already-committed (trailer scan) and must
    // not append the content again.
    const seed = { tenantId: "replay", instanceId: "lost-ack" };
    const branchName = buildBranchName(seed);
    const branchDirName = branchName.replace(/\//g, "_");

    const backendA = makeBackend(remoteDir, localRootA, { branchNameSeed: seed });
    await backendA.appendObject("records/log.jsonl", "once\n");
    await backendA.flush();
    expect(backendA.getSyncSummary().status).toBe("clean");

    const realOpId = await extractLastCommitOpId(remoteDir, branchName);
    expect(realOpId).toBeTruthy();

    // Pre-seed a fresh clone dir + a WAL claiming that same op is still
    // pending, without going through the class (which would generate its
    // own random op id and actually append content again).
    const cloneDirD = join(localRootB, "clones", branchDirName);
    const stateDirD = join(localRootB, "state", branchDirName);
    const { mkdir: mkdirFn, writeFile } = await import("node:fs/promises");
    await mkdirFn(stateDirD, { recursive: true });
    await runGit(["clone", "--quiet", "--single-branch", "--branch", branchName, remoteDir, cloneDirD], {
      cwd: process.cwd(),
    });
    const walEntry = {
      opId: realOpId,
      kind: "append",
      key: "records/log.jsonl",
      contentBase64: Buffer.from("once\n", "utf-8").toString("base64"),
      ts: Date.now(),
    };
    await writeFile(join(stateDirD, "pending-ops.jsonl"), `${JSON.stringify(walEntry)}\n`);

    const backendD = makeBackend(remoteDir, localRootB, { branchNameSeed: seed, stateBackend: new FakeStateBackend() });
    await backendD.flush(); // triggers ensureInitialized -> recovery -> a (no-op) flush

    const checkoutDir = await mkdtemp(join(tmpdir(), "storage-git-checkout-"));
    try {
      await runGit(["clone", "--quiet", "--single-branch", "--branch", branchName, remoteDir, checkoutDir], {
        cwd: process.cwd(),
      });
      const { readFile } = await import("node:fs/promises");
      const finalContent = await readFile(join(checkoutDir, "records/log.jsonl"), "utf-8");
      expect(finalContent).toBe("once\n"); // not "once\nonce\n"
    } finally {
      await rm(checkoutDir, { recursive: true, force: true });
    }
  });
});

async function extractLastCommitOpId(remoteDir: string, branchName: string): Promise<string> {
  const checkoutDir = await mkdtemp(join(tmpdir(), "storage-git-extract-"));
  try {
    await runGit(["clone", "--quiet", "--single-branch", "--branch", branchName, remoteDir, checkoutDir], {
      cwd: process.cwd(),
    });
    const { stdout } = await runGit(["log", "-1", "--format=%B"], { cwd: checkoutDir });
    const match = /^Ops: (.+)$/m.exec(stdout);
    return match?.[1]?.trim().split(/\s+/)[0] ?? "";
  } finally {
    await rm(checkoutDir, { recursive: true, force: true });
  }
}

describe("GitStorageBackend — branch name encoding", () => {
  const adversarialSeeds: Array<[string, { tenantId: string; instanceId: string }]> = [
    ["empty tenant and instance", { tenantId: "", instanceId: "" }],
    ["parent traversal chars", { tenantId: "..", instanceId: "../../etc" }],
    ["ref @{ sequence", { tenantId: "a@{b", instanceId: "c@{d" }],
    ["trailing .lock", { tenantId: "foo.lock", instanceId: "bar.lock" }],
    ["unicode", { tenantId: "租户名字", instanceId: "インスタンス" }],
    ["overlong ids", { tenantId: "t".repeat(500), instanceId: "i".repeat(500) }],
    ["slashes", { tenantId: "a/b/c", instanceId: "d/e/f" }],
    ["only reserved chars", { tenantId: "@{~^:?*[\\", instanceId: "@{~^:?*[\\" }],
  ];

  for (const [label, seed] of adversarialSeeds) {
    it(`produces a check-ref-format-valid branch name for ${label}`, async () => {
      const branchName = buildBranchName(seed);
      expect(branchName.length).toBeLessThanOrEqual(200);
      const valid = await gitCheckRefFormat(branchName);
      expect(valid).toBe(true);
    });
  }

  it("does not collide when sanitized tenant/instance concatenation would be ambiguous", () => {
    const a = buildBranchName({ tenantId: "ab", instanceId: "c" });
    const b = buildBranchName({ tenantId: "a", instanceId: "bc" });
    expect(a).not.toBe(b);
  });

  it("is deterministic for the same seed", () => {
    const seed = { tenantId: "tenant-x", instanceId: "instance-y" };
    expect(buildBranchName(seed)).toBe(buildBranchName(seed));
  });
});

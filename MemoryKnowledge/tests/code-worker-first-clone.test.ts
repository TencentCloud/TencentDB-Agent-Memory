import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createKnowledgeModule } from "../src/module.js";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createDb } from "../src/db/client.js";
import { HttpsGitServer } from "./git-transport-fixtures/https-git-server.js";
import { GitSourceFetcher } from "../src/source-fetcher/git-fetcher.js";
import { spawnSync } from "node:child_process";


const {
  fetcherHolder,
  mockOpenIndex,
  mockIndexProject,
  mockSyncIndex,
  mockCloseIndex,
  mockGetStats
} = vi.hoisted(() => ({
  fetcherHolder: { current: null as any },
  mockOpenIndex: vi.fn(),
  mockIndexProject: vi.fn(),
  mockSyncIndex: vi.fn(),
  mockCloseIndex: vi.fn(),
  mockGetStats: vi.fn()
}));

vi.mock("../src/source-fetcher/index.js", () => {
  return {
    SourceFetcherRegistry: class {
      resolve() {
        if (!fetcherHolder.current) throw new Error("Fetcher not injected");
        return fetcherHolder.current;
      }
    }
  };
});

vi.mock("../src/engines/code/index.js", () => ({
  openIndex: mockOpenIndex,
  indexProject: mockIndexProject,
  syncIndex: mockSyncIndex,
  closeIndex: mockCloseIndex,
  getStats: mockGetStats
}));

const isolatedGitEnv: Record<string, string> = {
  PATH: process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

function runFixtureGit(args: string[], cwd: string) {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    env: isolatedGitEnv,
    timeout: 15000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${result.status}): ${result.error?.message || result.stderr?.toString()}`);
  }
  return result;
}

describe("Code Worker First Clone Integration", () => {
  let workDir: string;
  let dbInstance: { db: any, raw: any };
  let gitServer: HttpsGitServer;

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), "first-clone-"));
    dbInstance = createDb({ path: ":memory:" });
    fetcherHolder.current = null;
    vi.clearAllMocks();

    gitServer = new HttpsGitServer({ host: "git.test.local" });
    await gitServer.start();
  });

  afterEach(async () => {
    try {
      if (gitServer) await gitServer.stop();
    } catch {}
    try {
      if (dbInstance?.raw) dbInstance.raw.close();
    } catch {}
    try {
      if (workDir) rmSync(workDir, { recursive: true, force: true });
    } catch {}
  });

  it("performs actual first clone, asserts exact bytes, index init, handle pooling and guard release", async () => {
    let setupCloneDir: string | undefined;

    try {
      // 1. Setup git repo on the test server with explicit isolated init, commit and push to bare master
      const remoteRepoDir = gitServer.createRepoSync("testrepo.git");
      setupCloneDir = mkdtempSync(join(tmpdir(), "setup-clone-"));

      runFixtureGit(["init", "--initial-branch=master"], setupCloneDir);
      runFixtureGit(["config", "user.name", "Test User"], setupCloneDir);
      runFixtureGit(["config", "user.email", "test@test.local"], setupCloneDir);
      runFixtureGit(["config", "core.hooksPath", "/dev/null"], setupCloneDir);

      const binaryContent = Buffer.from("hello world binary content \x00\x01\x02\xff");
      writeFileSync(join(setupCloneDir, "hello.txt"), binaryContent);

      runFixtureGit(["add", "hello.txt"], setupCloneDir);
      runFixtureGit(["commit", "-m", "init"], setupCloneDir);
      runFixtureGit(["remote", "add", "origin", remoteRepoDir], setupCloneDir);
      runFixtureGit(["push", "origin", "master"], setupCloneDir);

      const revParseResult = runFixtureGit(["rev-parse", "HEAD"], setupCloneDir);
      const expectedCommit = revParseResult.stdout.toString().trim().slice(0, 12);

      // 2. Configure real fetcher with synthetic DNS and CA, disabling ssrfCheck only for synthetic test
      const realFetcher = new GitSourceFetcher({
        ssrfCheck: false,
        dnsResolver: async (host) => {
          if (host === "git.test.local") {
            return [{ address: "127.0.0.1", family: 4 }];
          }
          return [];
        },
        trustedCA: join(gitServer.repoDir, "cert.pem")
      });

      // Wrap/decorate real fetch to assert destination is absent when real fetch starts without mocking result
      let fetchCalled = false;
      const originalFetch = realFetcher.fetch.bind(realFetcher);
      realFetcher.fetch = async (sourceUrl: string, branch: string, localPath: string) => {
        fetchCalled = true;
        expect(existsSync(localPath)).toBe(false);
        return originalFetch(sourceUrl, branch, localPath);
      };
      fetcherHolder.current = realFetcher;

      const mod = createKnowledgeModule({
        dataDir: workDir,
        db: dbInstance.db,
        llmConfig: {} as any
      });

      const destDir = join(workDir, "testrepo");
      const repoUrl = `https://git.test.local:${gitServer.port}/testrepo.git`;

      const mockInstance = { projectRoot: destDir, fake: true };
      mockIndexProject.mockImplementation(async (projectPath: string) => {
        expect(existsSync(join(projectPath, "hello.txt"))).toBe(true);
        expect(readFileSync(join(projectPath, "hello.txt"))).toEqual(binaryContent);
        return mockInstance;
      });
      mockGetStats.mockReturnValue({ fileCount: 1, nodeCount: 2, edgeCount: 3 });

      const workerCtx = {
        dir: destDir,
        repoUrl,
        branch: "master",
        codeGraphId: "cg-first",
        setInternalStatus: vi.fn(),
        setPageProgress: vi.fn(),
        taskContext: {} as any,
      } as any;

      expect(existsSync(destDir)).toBe(false);

      // Call worker
      const result = await mod.cgService["worker"](workerCtx);

      expect(fetchCalled).toBe(true);

      // Check stats returned
      expect(result.stats).toEqual({ files: 1, nodes: 2, edges: 3 });
      expect(result.commitHash).toBe(expectedCommit);

      // Assert exact cloned binary bytes exist
      expect(existsSync(join(destDir, "hello.txt"))).toBe(true);
      expect(readFileSync(join(destDir, "hello.txt"))).toEqual(binaryContent);

      // Assert index initialization
      expect(mockIndexProject).toHaveBeenCalledWith(destDir);

      // Assert pooled handle
      expect(mod.instancePool.get("cg-first")).toBe(mockInstance);

      // Assert guard released (can acquire again)
      expect(mod.instancePool.acquireGuard!("cg-first")).toBe(true);
      mod.instancePool.releaseGuard!("cg-first");
    } finally {
      if (setupCloneDir) {
        try { rmSync(setupCloneDir, { recursive: true, force: true }); } catch {}
      }
    }
  });
});

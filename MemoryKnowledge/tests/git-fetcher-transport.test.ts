import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  failBackup: false,
  failSwap: false,
  failRollback: false
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (oldPath: import("node:fs").PathLike, newPath: import("node:fs").PathLike) => {
      const oldP = oldPath.toString();
      const newP = newPath.toString();
      if (fsMocks.failBackup && oldP.includes("checkout") && newP.includes(".backup.")) {
        throw new Error("Injected Backup Fail");
      }
      if (fsMocks.failSwap && oldP.includes(".staging.") && newP.includes("checkout")) {
        throw new Error("Injected Swap Fail");
      }
      if (fsMocks.failRollback && oldP.includes(".backup.") && newP.includes("checkout")) {
        throw new Error("Injected Rollback Fail");
      }
      return actual.renameSync(oldPath, newPath);
    }
  };
});
import { GitSourceFetcher } from "../src/source-fetcher/git-fetcher.js";
import { HttpsGitServer } from "./git-transport-fixtures/https-git-server.js";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, symlinkSync, mkdirSync, chmodSync, lstatSync, renameSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";

describe("GitSourceFetcher HTTPS Transport & Security", () => {
  let server: HttpsGitServer;
  let testRepoDir: string;
  let workDir: string;
  let originalEnv: NodeJS.ProcessEnv;
  let expectedCommitId: string;

  beforeAll(async () => {
    server = new HttpsGitServer({ host: "test.local" });
    await server.start();

    const bareRepo = server.createRepoSync("test-repo.git");
    const cloneDir = mkdtempSync(join(tmpdir(), "git-clone-"));

    const safeEnv = {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      HOME: "/dev/null"
    };

    const runGit = (args: string[]) => {
      const res = spawnSync("git", args, { cwd: cloneDir, env: safeEnv });
      if (res.error || res.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${res.stderr?.toString()}`);
      }
      return res;
    };

    runGit(["init"]);
    writeFileSync(join(cloneDir, "test.txt"), "hello world");
    runGit(["add", "test.txt"]);
    runGit(["config", "user.email", "test@example.com"]);
    runGit(["config", "user.name", "Test User"]);
    runGit(["commit", "-m", "Initial commit"]);
    runGit(["remote", "add", "origin", bareRepo]);
    runGit(["push", "origin", "master"]);

    const revParse = runGit(["rev-parse", "HEAD"]);
    expectedCommitId = revParse.stdout.toString().trim().slice(0, 12);

    testRepoDir = bareRepo;
    rmSync(cloneDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.expectedAuthorization = undefined;
    server.authorizationHeaders = [];
    fsMocks.failBackup = false;
    fsMocks.failSwap = false;
    fsMocks.failRollback = false;
    workDir = mkdtempSync(join(tmpdir(), "git-work-"));
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {}
  });

  it("authenticates clone and sync without storing a token or header in the checkout", async () => {
    const credential = { username: "synthetic-user", password: "synthetic-resource-password" };
    const encoded = Buffer.from(`${credential.username}:${credential.password}`).toString("base64");
    server.expectedAuthorization = `Basic ${encoded}`;
    const fetcher = new GitSourceFetcher({ ssrfCheck: false,
      dnsResolver: async () => [{ address: "127.0.0.1", family: 4 }],
      trustedCA: join(server.repoDir, "cert.pem") });
    const url = `https://test.local:${server.port}/test-repo.git`;
    const destination = join(workDir, "authenticated-checkout");
    const first = await fetcher.fetch(url, "master", destination, credential);
    expect(first.version).toBe(expectedCommitId);
    const second = await fetcher.sync(url, "master", destination, credential);
    expect(second.version).toBe(expectedCommitId);
    expect(server.authorizationHeaders.length).toBeGreaterThanOrEqual(4);
    expect(server.authorizationHeaders.every(h => h === server.expectedAuthorization)).toBe(true);
    const config = readFileSync(join(destination, ".git", "config"), "utf8");
    expect(config).toContain(url);
    expect(config).not.toContain(credential.password);
    expect(config).not.toContain(encoded);
    expect(config).not.toContain("extraHeader");
    expect(readFileSync(join(destination, "test.txt"), "utf8")).toBe("hello world");
  });

  it("removes staging and closes its relay when credential setup is rejected", async () => {
    const fetcher = new GitSourceFetcher({ ssrfCheck: false,
      dnsResolver: async () => [{ address: "127.0.0.1", family: 4 }], trustedCA: join(server.repoDir, "cert.pem") });
    const destination = join(workDir, "invalid-credential-checkout");
    await expect(fetcher.fetch(`https://test.local:${server.port}/test-repo.git`, "master", destination,
      { username: "invalid:username", password: "synthetic-password" })).rejects.toThrow("Invalid Git credential");
    expect(existsSync(destination)).toBe(false);
    expect(readdirSync(workDir).some(name => name.startsWith("invalid-credential-checkout.staging."))).toBe(false);
  });

  it("fails closed with incorrect credentials and removes staging", async () => {
    server.expectedAuthorization = "Basic " + Buffer.from("synthetic-user:expected-password").toString("base64");
    const fetcher = new GitSourceFetcher({ ssrfCheck: false,
      dnsResolver: async () => [{ address: "127.0.0.1", family: 4 }],
      trustedCA: join(server.repoDir, "cert.pem") });
    const destination = join(workDir, "authenticated-checkout");
    await expect(fetcher.fetch(`https://test.local:${server.port}/test-repo.git`, "master", destination,
      { username: "synthetic-user", password: "wrong-password" })).rejects.toThrow("Authenticated Git retrieval failed");
    expect(existsSync(destination)).toBe(false);
    expect(readdirSync(workDir)).toEqual([]);
  });

  it("fetch gets exact content and expected commit", async () => {
    const fetcher = new GitSourceFetcher({
      ssrfCheck: false,
      dnsResolver: async (host) => host === "test.local" ? [{ address: "127.0.0.1", family: 4 }] : [],
      trustedCA: join(server.repoDir, "cert.pem")
    });

    const localPath = join(workDir, "checkout");
    const res = await fetcher.fetch(`https://test.local:${server.port}/test-repo.git`, "master", localPath);

    expect(res.version).toBe(expectedCommitId);
    expect(readFileSync(join(localPath, "test.txt"), "utf-8")).toBe("hello world");
  });

  it("resolver rebinding connects to observed destination", async () => {
    let resolveCalls = 0;
    let alternateHit = false;
    let originalServerHit = false;

    const connectionObserver = () => {
      originalServerHit = true;
    };
    server.server.on("secureConnection", connectionObserver);

    const alternateServer = net.createServer((socket) => {
      alternateHit = true;
      socket.destroy();
    });

    // Attempt to listen on 127.0.0.2 if supported, otherwise just ignore alternate listening
    await new Promise<void>((resolve) => {
      alternateServer.listen(server.port, "127.0.0.2", () => resolve())
        .on("error", () => resolve()); // Ignore EADDRNOTAVAIL
    });

    try {
      const fetcher = new GitSourceFetcher({
        ssrfCheck: false,
        dnsResolver: async (host) => {
          resolveCalls++;
          if (resolveCalls === 1) {
            return [{ address: "127.0.0.1", family: 4 }];
          }
          return [{ address: "127.0.0.2", family: 4 }]; // Alternate target
        },
        trustedCA: join(server.repoDir, "cert.pem")
      });

      const localPath = join(workDir, "checkout");
      const res = await fetcher.fetch(`https://test.local:${server.port}/test-repo.git`, "master", localPath);

      // Exact content assert
      expect(res.version).toBe(expectedCommitId);
      expect(readFileSync(join(localPath, "test.txt"), "utf-8")).toBe("hello world");

      expect(originalServerHit).toBe(true);
      expect(alternateHit).toBe(false);
      expect(resolveCalls).toBe(1);
    } finally {
      server.server.off("secureConnection", connectionObserver);
      await new Promise<void>((resolve) => alternateServer.close(() => resolve()));
    }
  });

  it("redirect refusal with zero request to redirected endpoint", async () => {
    let redirectHit = false;
    let fakeHit = false;
    const redirectServer = http.createServer((req, res) => {
      redirectHit = true;
      res.writeHead(200);
      res.end();
    });
    const rPort = await new Promise<number>((resolve) => {
      redirectServer.listen(0, "127.0.0.1", () => resolve((redirectServer.address() as any).port));
    });

    const fakeGitServer = https.createServer({
      key: server.serverKey, cert: server.serverCert
    }, (req, res) => {
      fakeHit = true;
      res.writeHead(301, { "Location": `http://127.0.0.1:${rPort}/` });
      res.end();
    });
    const fPort = await new Promise<number>((resolve) => {
      fakeGitServer.listen(0, "127.0.0.1", () => resolve((fakeGitServer.address() as any).port));
    });

    try {
      const fetcher = new GitSourceFetcher({
        ssrfCheck: false,
        dnsResolver: async () => [{ address: "127.0.0.1", family: 4 }],
        trustedCA: join(server.repoDir, "cert.pem")
      });

      // simpleGit should throw a response error when encountering a 301 instead of a git output
      await expect(fetcher.fetch(`https://test.local:${fPort}/repo.git`, "master", join(workDir, "chk")))
        .rejects.toThrow(/301|redirect|fatal|not found|HTTP request failed|failed/i);

      expect(fakeHit).toBe(true);
      expect(redirectHit).toBe(false);
    } finally {
      await new Promise<void>((resolve) => fakeGitServer.close(() => resolve()));
      await new Promise<void>((resolve) => redirectServer.close(() => resolve()));
    }
  });

  it("actual self-signed error and wrong-host TLS error without trusted CA", async () => {
    // 1. Without trustedCA, self-signed cert fails
    const fetcherNoCa = new GitSourceFetcher({
      ssrfCheck: false,
      dnsResolver: async () => [{ address: "127.0.0.1", family: 4 }]
    });
    await expect(fetcherNoCa.fetch(`https://test.local:${server.port}/test-repo.git`, "master", join(workDir, "chk1")))
      .rejects.toThrow(/SSL certificate problem|self[- ]signed certificate|unable to get local issuer certificate|server certificate verification failed/i);

    // 2. With trustedCA but wrong hostname
    const fetcherWrongHost = new GitSourceFetcher({
      ssrfCheck: false,
      dnsResolver: async () => [{ address: "127.0.0.1", family: 4 }],
      trustedCA: join(server.repoDir, "cert.pem")
    });
    await expect(fetcherWrongHost.fetch(`https://wrong.local:${server.port}/test-repo.git`, "master", join(workDir, "chk2")))
      .rejects.toThrow(/SSL|certificate|subject name|wrong host/i);
  });

  it("hostile global/environment URL rewrites and credential helper canary", async () => {
    const fetcher = new GitSourceFetcher({
      ssrfCheck: false,
      dnsResolver: async () => [{ address: "127.0.0.1", family: 4 }],
      trustedCA: join(server.repoDir, "cert.pem")
    });

    const canaryPath = join(workDir, "canary-helper.sh");
    writeFileSync(canaryPath, `#!/bin/sh\ntouch "${join(workDir, "canary-hit")}"\nexit 1`);
    chmodSync(canaryPath, 0o755);

    let rewriteHit = false;
    const rewriteServer = http.createServer((req, res) => {
      rewriteHit = true;
      res.writeHead(200);
      res.end();
    });
    const rPort = await new Promise<number>((resolve) => {
      rewriteServer.listen(0, "127.0.0.1", () => resolve((rewriteServer.address() as net.AddressInfo).port));
    });

    try {
      const globalConfigPath = join(workDir, ".gitconfig-evil");
      writeFileSync(globalConfigPath, `[credential]\n  helper = "!\\"${canaryPath}\\""\n[url "http://127.0.0.1:${rPort}/"]\n  insteadOf = https://test.local:${server.port}/`);

      process.env.GIT_CONFIG_GLOBAL = globalConfigPath;

      // Prove canary is executed by global config
      const res = spawnSync("git", ["credential", "fill"], {
         input: "protocol=https\nhost=test.local\n\n",
         env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfigPath, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
         timeout: 2000
      });
      expect(existsSync(join(workDir, "canary-hit"))).toBe(true);
      rmSync(join(workDir, "canary-hit"));

      // Fetch, which should ignore the global config
      await fetcher.fetch(`https://test.local:${server.port}/test-repo.git`, "master", join(workDir, "chk"));

      expect(existsSync(join(workDir, "canary-hit"))).toBe(false);
      expect(rewriteHit).toBe(false);
    } finally {
      await new Promise<void>((resolve) => rewriteServer.close(() => resolve()));
    }
  });

  it("sync ignores malicious stored origin/config", async () => {
    const fetcher = new GitSourceFetcher({
      ssrfCheck: false,
      dnsResolver: async () => [{ address: "127.0.0.1", family: 4 }],
      trustedCA: join(server.repoDir, "cert.pem")
    });

    const localPath = join(workDir, "checkout");
    await fetcher.fetch(`https://test.local:${server.port}/test-repo.git`, "master", localPath);

    // Inject malicious stored origin
    spawnSync("git", ["config", "remote.origin.url", "http://evil.local"], { cwd: localPath });
    spawnSync("git", ["config", "core.hooksPath", "/tmp"], { cwd: localPath });

    const res = await fetcher.sync(`https://test.local:${server.port}/test-repo.git`, "master", localPath);
    expect(res.version).toBe(expectedCommitId);
  });

  it("exact .codegraph byte preservation during sync", async () => {
    const fetcher = new GitSourceFetcher({
      ssrfCheck: false,
      dnsResolver: async () => [{ address: "127.0.0.1", family: 4 }],
      trustedCA: join(server.repoDir, "cert.pem")
    });

    const localPath = join(workDir, "checkout");
    await fetcher.fetch(`https://test.local:${server.port}/test-repo.git`, "master", localPath);

    const cgDir = join(localPath, ".codegraph");
    mkdirSync(cgDir);
    writeFileSync(join(cgDir, "index.db"), "fake bytes");

    await fetcher.sync(`https://test.local:${server.port}/test-repo.git`, "master", localPath);
    expect(readFileSync(join(localPath, ".codegraph", "index.db"), "utf-8")).toBe("fake bytes");
  });

  it("injected backup/swap failures preserve old checkout/index", async () => {
    const fetcher = new GitSourceFetcher({
      ssrfCheck: false,
      dnsResolver: async () => [{ address: "127.0.0.1", family: 4 }],
      trustedCA: join(server.repoDir, "cert.pem")
    });

    const localPath = join(workDir, "checkout");
    await fetcher.fetch(`https://test.local:${server.port}/test-repo.git`, "master", localPath);
    writeFileSync(join(localPath, "preserved.txt"), "important");
    mkdirSync(join(localPath, ".codegraph"));
    writeFileSync(join(localPath, ".codegraph", "index.db"), "index bytes");

    // 1. Test backup failure
    fsMocks.failBackup = true;
    await expect(fetcher.sync(`https://test.local:${server.port}/test-repo.git`, "master", localPath)).rejects.toThrow("Failed to backup old checkout: Error: Injected Backup Fail");
    expect(readFileSync(join(localPath, "preserved.txt"), "utf-8")).toBe("important");
    expect(readFileSync(join(localPath, ".codegraph", "index.db"), "utf-8")).toBe("index bytes");
    fsMocks.failBackup = false;

    // 2. Test swap failure with successful rollback
    fsMocks.failSwap = true;
    await expect(fetcher.sync(`https://test.local:${server.port}/test-repo.git`, "master", localPath)).rejects.toThrow("Directory replacement failed: Error: Injected Swap Fail");
    expect(readFileSync(join(localPath, "preserved.txt"), "utf-8")).toBe("important");
    expect(readFileSync(join(localPath, ".codegraph", "index.db"), "utf-8")).toBe("index bytes");
    fsMocks.failSwap = false;

    // 3. Test swap failure AND rollback failure
    fsMocks.failSwap = true;
    fsMocks.failRollback = true;
    await expect(fetcher.sync(`https://test.local:${server.port}/test-repo.git`, "master", localPath)).rejects.toThrow(/Directory replacement failed and rollback failed\. Recovery location:/);

    // We expect the original to be in the backup location because rollback failed
    const entries = readdirSync(workDir).filter(e => e.includes(".backup."));
    expect(entries.length).toBeGreaterThan(0);
    expect(readFileSync(join(workDir, entries[0], "preserved.txt"), "utf-8")).toBe("important");
    expect(readFileSync(join(workDir, entries[0], ".codegraph", "index.db"), "utf-8")).toBe("index bytes");

    fsMocks.failSwap = false;
    fsMocks.failRollback = false;
  });

  it("rejects local .codegraph symlinks, dangling symlinks, and non-directories", async () => {
    const fetcher = new GitSourceFetcher({
      ssrfCheck: false,
      dnsResolver: async () => [{ address: "127.0.0.1", family: 4 }],
      trustedCA: join(server.repoDir, "cert.pem")
    });

    const localPath = join(workDir, "checkout-local");
    await fetcher.fetch(`https://test.local:${server.port}/test-repo.git`, "master", localPath);

    // Root symlink
    symlinkSync("/etc/passwd", join(localPath, ".codegraph"));
    await expect(fetcher.sync(`https://test.local:${server.port}/test-repo.git`, "master", localPath)).rejects.toThrow("symlink");
    rmSync(join(localPath, ".codegraph"), { force: true });

    // Dangling symlink
    symlinkSync(join(workDir, "nonexistent"), join(localPath, ".codegraph"));
    await expect(fetcher.sync(`https://test.local:${server.port}/test-repo.git`, "master", localPath)).rejects.toThrow("symlink");
    rmSync(join(localPath, ".codegraph"), { force: true });

    // Non-directory (file)
    writeFileSync(join(localPath, ".codegraph"), "fake bytes");
    await expect(fetcher.sync(`https://test.local:${server.port}/test-repo.git`, "master", localPath)).rejects.toThrow("symlink");
    rmSync(join(localPath, ".codegraph"), { force: true });

    // Nested dangling symlink inside codegraph dir
    mkdirSync(join(localPath, ".codegraph"));
    symlinkSync(join(workDir, "nonexistent2"), join(localPath, ".codegraph", "bad_link"));
    await expect(fetcher.sync(`https://test.local:${server.port}/test-repo.git`, "master", localPath)).rejects.toThrow("Invalid entry");
    rmSync(join(localPath, ".codegraph"), { recursive: true, force: true });

    // Permission error (EACCES)
    mkdirSync(join(localPath, ".codegraph"), { mode: 0o000 });
    try {
      // Expect sync to propagate the filesystem error, not a generic symlink error
      await expect(fetcher.sync(`https://test.local:${server.port}/test-repo.git`, "master", localPath)).rejects.toThrow(/EACCES|EPERM/);
    } finally {
      // Restore permissions for cleanup
      chmodSync(join(localPath, ".codegraph"), 0o777);
      rmSync(join(localPath, ".codegraph"), { recursive: true, force: true });
    }
  });

  it("fetch rejects pre-existing destination with exact bytes preserved", async () => {
    const fetcher = new GitSourceFetcher({
      ssrfCheck: false,
      dnsResolver: async () => [{ address: "127.0.0.1", family: 4 }],
      trustedCA: join(server.repoDir, "cert.pem")
    });

    const localPath = join(workDir, "checkout-fetch-fail");
    mkdirSync(localPath);
    writeFileSync(join(localPath, "preserved.txt"), "untouched");

    await expect(fetcher.fetch(`https://test.local:${server.port}/test-repo.git`, "master", localPath)).rejects.toThrow("already exists");
    expect(readFileSync(join(localPath, "preserved.txt"), "utf-8")).toBe("untouched");

    // Also reject dangling symlinks to fetch path and verify destination is untouched
    const nowherePath = join(workDir, "nowhere");
    const linkPath = join(workDir, "checkout-fetch-link");
    symlinkSync(nowherePath, linkPath); // dangling
    await expect(fetcher.fetch(`https://test.local:${server.port}/test-repo.git`, "master", linkPath)).rejects.toThrow("already exists");
    expect(existsSync(nowherePath)).toBe(false); // Prove it didn't create anything at destination

    const existingTarget = join(workDir, "existing-target");
    writeFileSync(existingTarget, "target bytes");
    const linkPath2 = join(workDir, "checkout-fetch-link-2");
    symlinkSync(existingTarget, linkPath2);
    await expect(fetcher.fetch(`https://test.local:${server.port}/test-repo.git`, "master", linkPath2)).rejects.toThrow("already exists");
    expect(readFileSync(existingTarget, "utf-8")).toBe("target bytes");
  });

  it("incoming .codegraph conflict rejection from remote commits", async () => {
    const fetcher = new GitSourceFetcher({
      ssrfCheck: false,
      dnsResolver: async () => [{ address: "127.0.0.1", family: 4 }],
      trustedCA: join(server.repoDir, "cert.pem")
    });

    const localPath = join(workDir, "checkout-incoming");

    // Clear localPath to test incoming conflict
    rmSync(localPath, { recursive: true, force: true });

    // Create actual upstream commits containing conflict entries using local file protocol
    const evilCloneDir = mkdtempSync(join(tmpdir(), "git-evil-clone-"));
    const evilSymlinkCloneDir = mkdtempSync(join(tmpdir(), "git-evil-symlink-clone-"));

    // Create a second bare repo for the symlink test
    const symlinkBareRepo = server.createRepoSync("test-repo-symlink.git");

    const safeEnv = {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      HOME: "/dev/null"
    };

    const runGit = (args: string[], cwd: string) => {
      const res = spawnSync("git", args, { cwd, env: safeEnv, timeout: 5000 });
      if (res.error || res.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed`);
      }
    };

    try {
      runGit(["clone", testRepoDir, "."], evilCloneDir);
      mkdirSync(join(evilCloneDir, ".codegraph"));
      writeFileSync(join(evilCloneDir, ".codegraph", "evil.txt"), "evil");
      runGit(["add", ".codegraph/evil.txt"], evilCloneDir);
      runGit(["config", "user.email", "evil@example.com"], evilCloneDir);
      runGit(["config", "user.name", "Evil User"], evilCloneDir);
      runGit(["commit", "-m", "Evil commit with .codegraph directory"], evilCloneDir);
      runGit(["push", "origin", "master"], evilCloneDir);

      runGit(["init"], evilSymlinkCloneDir);
      writeFileSync(join(evilSymlinkCloneDir, "initial.txt"), "init");
      runGit(["add", "initial.txt"], evilSymlinkCloneDir);
      runGit(["config", "user.email", "evil@example.com"], evilSymlinkCloneDir);
      runGit(["config", "user.name", "Evil User"], evilSymlinkCloneDir);
      runGit(["commit", "-m", "Init"], evilSymlinkCloneDir);
      runGit(["remote", "add", "origin", symlinkBareRepo], evilSymlinkCloneDir);
      runGit(["push", "origin", "master"], evilSymlinkCloneDir);

      symlinkSync(join(workDir, "nowhere"), join(evilSymlinkCloneDir, ".codegraph"));
      runGit(["add", ".codegraph"], evilSymlinkCloneDir);
      runGit(["commit", "-m", "Evil commit with .codegraph dangling symlink"], evilSymlinkCloneDir);
      runGit(["push", "origin", "master"], evilSymlinkCloneDir);
    } finally {
      rmSync(evilCloneDir, { recursive: true, force: true });
      rmSync(evilSymlinkCloneDir, { recursive: true, force: true });
    }

    // 1. Directory conflict without existing index
    await expect(fetcher.sync(`https://test.local:${server.port}/test-repo.git`, "master", localPath)).rejects.toThrow("conflict");

    // 2. Directory conflict with existing index
    mkdirSync(localPath);
    mkdirSync(join(localPath, ".codegraph"));
    writeFileSync(join(localPath, ".codegraph", "existing.txt"), "existing");
    await expect(fetcher.sync(`https://test.local:${server.port}/test-repo.git`, "master", localPath)).rejects.toThrow("conflict");
    rmSync(localPath, { recursive: true, force: true });

    // 3. Dangling symlink conflict without existing index
    await expect(fetcher.sync(`https://test.local:${server.port}/test-repo-symlink.git`, "master", localPath)).rejects.toThrow("conflict");
  });
  it("process deadline is enforced regardless of trickle output", async () => {
    const activeSockets = new Set<net.Socket>();
    const activeIntervals = new Set<NodeJS.Timeout>();
    let hit = false;
    let reqUrl: string | undefined;

    const slowServer = https.createServer({
      key: server.serverKey,
      cert: server.serverCert
    }, (req, res) => {
      hit = true;
      reqUrl = req.url;
      res.writeHead(200, {
        "Content-Type": "application/x-git-upload-pack-advertisement",
        "Cache-Control": "no-cache"
      });
      res.write("001e# service=git-upload-pack\n0000"); // Valid git packet to start

      const interval = setInterval(() => {
        try {
          res.write("0000"); // Keep sending empty packets to avoid idle timeout
        } catch {
          // ignore
        }
      }, 500); // Frequent enough to prevent curl idle timeouts
      activeIntervals.add(interval);

      req.on("close", () => {
        clearInterval(interval);
        activeIntervals.delete(interval);
      });
    });

    slowServer.on("connection", (socket) => {
      activeSockets.add(socket);
      socket.on("close", () => activeSockets.delete(socket));
    });

    const sPort = await new Promise<number>((resolve) => {
      slowServer.listen(0, "127.0.0.1", () => resolve((slowServer.address() as net.AddressInfo).port));
    });

    try {
      const fetcher = new GitSourceFetcher({
        ssrfCheck: false,
        dnsResolver: async () => [{ address: "127.0.0.1", family: 4 }],
        trustedCA: join(server.repoDir, "cert.pem")
      });

      const localPath = join(workDir, "checkout-timeout");

      const startTime = Date.now();
      const fetchPromise = fetcher.fetch(`https://test.local:${sPort}/test-repo.git`, "master", localPath);

      // We use a real explicit wait up to 75s because simple-git timeout is 60s
      await expect(fetchPromise).rejects.toThrow(/timeout|aborted|killed|60000|60 seconds/i);

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeGreaterThanOrEqual(58000); // Should be around 60 seconds
      expect(hit).toBe(true);
      expect(reqUrl).toMatch(/info\/refs/);

    } finally {
      for (const interval of activeIntervals) {
        clearInterval(interval);
      }
      activeIntervals.clear();
      for (const socket of activeSockets) {
        socket.destroy();
      }
      activeSockets.clear();
      await new Promise<void>((resolve) => slowServer.close(() => resolve()));
    }
  }, 75000);
});

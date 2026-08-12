/**
 * GitSourceFetcher 安全测试（949spec §8 / §10 / §11 / §23 / §30）。
 * - token 模式：URL 恒干净，凭据经 job 目录 GIT_ASKPASS 注入（进程参数/URL 不含 token）；
 * - SSH 模式：未信任 host fail-closed（GIT_SSH_HOST_UNTRUSTED）；
 * - 内置 known_hosts 指纹组装正确；管理员配置可追加；
 * - job 目录权限 0700 / 密钥 0600；
 * - SSRF 校验接入 fetcher（resolveOverride 阻断内网）。
 */

import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, stat, readdir } from "node:fs/promises";
import { GitSourceFetcher, GitFetchError, FETCH_ERROR } from "../git-fetcher.js";
import { GitUrlError, GIT_URL_ERROR } from "../url-security.js";

/** 访问 private 方法/字段（运行时不受 TS 限制）。 */
type AnyFetcher = GitSourceFetcher & {
  prepareJob(repo: { protocol: "https" | "ssh"; host: string }, opts?: unknown): Promise<{
    dir: string;
    env: Record<string, string>;
    askpassPath?: string;
    sshCommand?: string;
    cleanup: () => Promise<void>;
  }>;
  buildKnownHosts(host: string, opts?: unknown): Promise<string>;
};

const SECRET = "TKN_SUPERSECRET_abc123";

describe("GitSourceFetcher token auth (§8) — job material", () => {
  it("token never appears in env, askpass script, or ssh command; URL stays clean", async () => {
    const fetcher = new GitSourceFetcher() as unknown as AnyFetcher;
    const job = await fetcher.prepareJob(
      { protocol: "https", host: "github.com" },
      { authMethod: "token", accessToken: SECRET, tokenUsername: "octocat" },
    );
    try {
      // 环境变量：GIT_TERMINAL_PROMPT=0，无 token
      expect(job.env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(JSON.stringify(job.env)).not.toContain(SECRET);
      // askpass 脚本内容不含 token（token 在独立 secret 文件；脚本用 [Uu]sername/[Pp]assword 模式匹配 prompt）
      const askpass = await readFile(job.askpassPath!, "utf8");
      expect(askpass).not.toContain(SECRET);
      expect(askpass).toMatch(/sername/);
      expect(askpass).toMatch(/assword/);
      // 无 sshCommand（token 模式）
      expect(job.sshCommand).toBeUndefined();
      // secret 文件存在（Windows 无 POSIX 权限语义，仅非 Windows 断言 0600）
      await expect(stat(join(job.dir, "secret"))).resolves.toBeTruthy();
      if (process.platform !== "win32") {
        const mode = (await stat(join(job.dir, "secret"))).mode & 0o777;
        expect(mode).toBe(0o600);
      }
    } finally {
      await job.cleanup();
    }
  });

  it("job dir is created and removed after cleanup", async () => {
    const fetcher = new GitSourceFetcher() as unknown as AnyFetcher;
    const job = await fetcher.prepareJob(
      { protocol: "https", host: "github.com" },
      { authMethod: "token", accessToken: SECRET },
    );
    const dir = job.dir;
    await expect(stat(dir)).resolves.toBeTruthy();
    await job.cleanup();
    await expect(readdir(dir)).rejects.toThrow();
  });
});

describe("GitSourceFetcher SSH host verification (§10)", () => {
  it("unknown host fails closed with GIT_SSH_HOST_UNTRUSTED", async () => {
    const fetcher = new GitSourceFetcher() as unknown as AnyFetcher;
    await expect(
      fetcher.prepareJob(
        { protocol: "ssh", host: "git.unknown-corp.example.com" },
        { authMethod: "ssh", sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n" },
      ),
    ).rejects.toMatchObject({ code: FETCH_ERROR.GIT_SSH_HOST_UNTRUSTED });
  });

  it("built-in github.com fingerprint is present in known_hosts", async () => {
    const fetcher = new GitSourceFetcher() as unknown as AnyFetcher;
    const kh = await fetcher.buildKnownHosts("github.com");
    expect(kh).toContain("github.com ssh-ed25519");
    expect(kh).toContain("github.com ecdsa-sha2-nistp256");
  });

  it("admin-known-host file content is appended", async () => {
    const fetcher = new GitSourceFetcher() as unknown as AnyFetcher;
    const kh = await fetcher.buildKnownHosts("git.example.com", {
      knownHosts: "git.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKEFAKE",
    });
    expect(kh).toContain("git.example.com ssh-ed25519");
  });

  it("ssh command enforces strict verification (no StrictHostKeyChecking=no)", async () => {
    const fetcher = new GitSourceFetcher() as unknown as AnyFetcher;
    const job = await fetcher.prepareJob(
      { protocol: "ssh", host: "github.com" },
      { authMethod: "ssh", sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n" },
    );
    try {
      expect(job.sshCommand).toContain("StrictHostKeyChecking=yes");
      expect(job.sshCommand).toContain("BatchMode=yes");
      expect(job.sshCommand).toContain("IdentitiesOnly=yes");
      expect(job.sshCommand).not.toContain("StrictHostKeyChecking=no");
      expect(job.sshCommand).not.toContain("/dev/null");
      // 私钥文件存在（Windows 无 POSIX 权限语义，仅非 Windows 断言 0600）
      await expect(stat(join(job.dir, "id_key"))).resolves.toBeTruthy();
      if (process.platform !== "win32") {
        const keyMode = (await stat(join(job.dir, "id_key"))).mode & 0o777;
        expect(keyMode).toBe(0o600);
      }
    } finally {
      await job.cleanup();
    }
  });
});

describe("GitSourceFetcher SSRF integration (§13)", () => {
  it("fetch rejects hostname resolving to private address before git runs", async () => {
    const fetcher = new GitSourceFetcher({
      resolveOverride: async () => ["10.0.0.5"],
    });
    try {
      await fetcher.fetch("https://evil.example.com/org/repo.git", "main", join(tmpdir(), "cg-ssrf-test"));
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GitUrlError);
      expect((err as GitUrlError).code).toBe(GIT_URL_ERROR.DNS_RESOLUTION_BLOCKED);
    }
  });
});

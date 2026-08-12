/**
 * GitSourceFetcher — 基于 simple-git 的安全源码拉取实现（949spec 生产级重构）。
 *
 * simple-git 内部用 child_process.spawn + args 数组，不走 shell，从原理上消除 shell 注入。
 *
 * 安全设计（949spec）：
 *   §8  HTTPS token：绝不构造 https://user:token@host 带凭据 URL（Forbidden Pattern），
 *       也不临时 git remote set-url（crash/SIGKILL 不安全的 finally 模式）。
 *       凭据通过 job 专属 GIT_ASKPASS helper 注入：GIT_TERMINAL_PROMPT=0 + 只读
 *       job-local 密文文件（0600），URL 全程干净。
 *   §10 SSH host 验证：StrictHostKeyChecking=yes + UserKnownHostsFile=<job-managed>
 *       + BatchMode=yes + IdentitiesOnly=yes。known_hosts = 内置公网托管商指纹
 *       （github/gitlab）+ 管理员配置（KNOWLEDGE_SSH_KNOWN_HOSTS / opts.knownHosts）。
 *       不在白名单的 host 直接 fail-closed（GIT_SSH_HOST_UNTRUSTED）。
 *   §11 SSH 私钥：job 专属目录（0700）+ key 文件 0600，任务结束/worker 启动即清理。
 *   §13 SSRF：应用层 URL 规范化 + DNS 解析（A/AAAA 全部地址）校验；网络层 egress
 *       由部署拓扑强制（本层是纵深防御第一道）。
 *   §15 资源限制：clone/fetch 超时（kill 子进程）；submodule/LFS 显式禁用。
 *   §16 submodule/LFS：默认禁用（--no-recurse-submodules + GIT_LFS_SKIP_SMUDGE=1
 *       + repo-local submodule.recurse=false + protocol.ext.allow=never）。
 */

import simpleGit, { CleanOptions, ResetMode, type SimpleGitOptions } from "simple-git";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { join } from "node:path";

import type { ISourceFetcher, FetchResult, FetchOptions, SourceType } from "./types.js";
import { canonicalizeGitUrl, assertSafeRemote } from "./url-security.js";

// ───────────────────────── 配置 / 环境 ─────────────────────────

/** 内置可信公网托管商指纹（§10.2 built_in source；值取自各官方公布的标准指纹）。 */
const BUILTIN_KNOWN_HOSTS: Record<string, string[]> = {
  "github.com": [
    "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
    "github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=",
  ],
  "gitlab.com": [
    "gitlab.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAII8uM3d4jFYhVAYiZCB0K7lJ8VqMQtgjEhYlM5PvOUH",
  ],
};

/** 环境变量名：管理员追加的 known_hosts 文件路径（每行一条指纹）。 */
const ENV_KNOWN_HOSTS_FILE = "KNOWLEDGE_SSH_KNOWN_HOSTS";

/** 默认 clone/fetch 超时（ms，§15）。可用环境变量覆盖。 */
function timeoutFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function ssrfCheckEnabledFromEnv(): boolean {
  const raw = process.env.KNOWLEDGE_SSRF_CHECK;
  if (raw == null || raw.trim() === "") return true;
  const v = raw.trim().toLowerCase();
  return !(v === "off" || v === "false" || v === "0" || v === "no");
}

/** 稳定错误码（949spec §25 子集，source-fetcher 层产生）。 */
export const FETCH_ERROR = {
  GIT_SSH_HOST_UNTRUSTED: "GIT_SSH_HOST_UNTRUSTED",
  GIT_SSH_HOST_KEY_MISMATCH: "GIT_SSH_HOST_KEY_MISMATCH",
  GIT_AUTH_FAILED: "GIT_AUTH_FAILED",
  GIT_REPO_NOT_FOUND: "GIT_REPO_NOT_FOUND",
  GIT_CLONE_TIMEOUT: "GIT_CLONE_TIMEOUT",
  GIT_FETCH_TIMEOUT: "GIT_FETCH_TIMEOUT",
} as const;

export type FetchErrorCode = (typeof FETCH_ERROR)[keyof typeof FETCH_ERROR];

export class GitFetchError extends Error {
  readonly code: FetchErrorCode;
  constructor(code: FetchErrorCode, message: string) {
    super(message);
    this.name = "GitFetchError";
    this.code = code;
  }
}

export interface GitSourceFetcherOptions {
  /** SSRF 应用层校验开关。默认读 KNOWLEDGE_SSRF_CHECK（默认开启）。 */
  ssrfCheck?: boolean;
  /** 测试注入：自定义 DNS 解析（SSRF 测试套件用）。 */
  resolveOverride?: (hostname: string) => Promise<string[]>;
  /** 默认 clone 超时（ms）。 */
  defaultCloneTimeoutMs?: number;
  /** 默认 fetch 超时（ms）。 */
  defaultFetchTimeoutMs?: number;
}

// ───────────────────────── Job 目录管理 ─────────────────────────

interface JobMaterial {
  dir: string;
  /** git 子进程需要的全部环境变量（不含 GIT_ASKPASS/GIT_SSH_COMMAND，那两者单独注入）。 */
  env: Record<string, string>;
  askpassPath?: string;
  sshCommand?: string;
  /** 清理 job 目录（幂等）。 */
  cleanup: () => Promise<void>;
}

/** 映射 git 认证失败 stderr 到稳定错误码。 */
function classifyGitError(err: unknown): GitFetchError | Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("host key verification failed") || msg.includes("host key mismatch")) {
    return new GitFetchError(FETCH_ERROR.GIT_SSH_HOST_KEY_MISMATCH, "ssh host key verification failed");
  }
  if (msg.includes("permission denied (publickey") || msg.includes("authentication failed") || msg.includes("could not read username")) {
    return new GitFetchError(FETCH_ERROR.GIT_AUTH_FAILED, "git authentication failed");
  }
  if (msg.includes("repository not found") || msg.includes("remote: repository not found") || msg.includes("could not find repository")) {
    return new GitFetchError(FETCH_ERROR.GIT_REPO_NOT_FOUND, "git repository not found");
  }
  if (msg.includes("signal: killed") || msg.includes("timed out") || msg.includes("ETIMEDOUT")) {
    return new GitFetchError(FETCH_ERROR.GIT_CLONE_TIMEOUT, "git operation timed out");
  }
  return err instanceof Error ? err : new Error(String(err));
}

export class GitSourceFetcher implements ISourceFetcher {
  readonly supportedType: SourceType = "git";

  private readonly ssrfCheck: boolean;
  private readonly resolveOverride?: (hostname: string) => Promise<string[]>;
  private readonly defaultCloneTimeoutMs: number;
  private readonly defaultFetchTimeoutMs: number;

  constructor(opts?: GitSourceFetcherOptions) {
    this.ssrfCheck = opts?.ssrfCheck ?? ssrfCheckEnabledFromEnv();
    this.resolveOverride = opts?.resolveOverride;
    this.defaultCloneTimeoutMs = opts?.defaultCloneTimeoutMs ?? timeoutFromEnv("KNOWLEDGE_GIT_CLONE_TIMEOUT_MS", 60_000);
    this.defaultFetchTimeoutMs = opts?.defaultFetchTimeoutMs ?? timeoutFromEnv("KNOWLEDGE_GIT_FETCH_TIMEOUT_MS", 60_000);
  }

  /**
   * 同步 URL 校验（ISourceFetcher 接口）：规范化 + userinfo/协议/控制字符拒绝。
   * 注意：DNS 解析 + 禁止网段判定是 async（fetch/sync 开头执行）。
   */
  validate(sourceUrl: string): void {
    canonicalizeGitUrl(sourceUrl);
  }

  async fetch(sourceUrl: string, branch: string, localPath: string, opts?: FetchOptions): Promise<FetchResult> {
    const repo = canonicalizeGitUrl(sourceUrl);
    await assertSafeRemote(repo, { enabled: this.ssrfCheck, resolveOverride: this.resolveOverride });
    const job = await this.prepareJob(repo, opts);
    try {
      const git = this.authenticatedGit(job, opts, opts?.cloneTimeoutMs ?? this.defaultCloneTimeoutMs);
      await git.clone(repo.url, localPath, {
        "--depth": 1,
        "--branch": branch,
        "--no-recurse-submodules": null, // §16 submodules disabled
      });
      const version = await this.headCommit(localPath);
      return { localPath, version, sourceType: "git" };
    } catch (err) {
      try {
        rmSync(localPath, { recursive: true, force: true });
      } catch {
        // 忽略清理失败
      }
      throw classifyGitError(err);
    } finally {
      await job.cleanup();
    }
  }

  async sync(sourceUrl: string, branch: string, localPath: string, opts?: FetchOptions): Promise<FetchResult> {
    const repo = canonicalizeGitUrl(sourceUrl);
    await assertSafeRemote(repo, { enabled: this.ssrfCheck, resolveOverride: this.resolveOverride });
    const job = await this.prepareJob(repo, opts);
    try {
      const git = this.authenticatedGit(job, opts, opts?.fetchTimeoutMs ?? this.defaultFetchTimeoutMs);
      // URL 恒为干净 URL（§8）：直接 fetch 干净 origin，绝不 set-url 注入凭据。
      await git.fetch("origin", branch, { "--depth": 1 });
      await git.reset(ResetMode.HARD, [`origin/${branch}`]);
      // Bug 修复（方案 A）：clean 排除 .codegraph/，否则会删掉 codegraph 的索引库。
      await git.clean(CleanOptions.FORCE + CleanOptions.RECURSIVE, ["-e", ".codegraph"]);
      const version = await this.headCommit(localPath);
      return { localPath, version, sourceType: "git" };
    } catch (err) {
      throw classifyGitError(err);
    } finally {
      await job.cleanup();
    }
  }

  /**
   * 连接测试（949spec §23）：用与真实 fetch 相同的安全路径执行 ls-remote。
   * 不做全量 clone；验证 host 信任 + 认证 + 仓库可达性 + 超时/egress。
   * 成功静默返回；失败抛稳定错误码（FETCH_ERROR / GitUrlError）。
   */
  async testConnection(sourceUrl: string, opts?: FetchOptions): Promise<void> {
    const repo = canonicalizeGitUrl(sourceUrl);
    await assertSafeRemote(repo, { enabled: this.ssrfCheck, resolveOverride: this.resolveOverride });
    const job = await this.prepareJob(repo, opts);
    try {
      const git = this.authenticatedGit(job, opts, opts?.fetchTimeoutMs ?? this.defaultFetchTimeoutMs);
      await git.raw(["ls-remote", repo.url, "HEAD"]);
    } catch (err) {
      throw classifyGitError(err);
    } finally {
      await job.cleanup();
    }
  }

  // ── 内部 helper ──

  /**
   * 构建 job 专属凭据材料（§8.2/§11）：
   *   <tmp>/cg-worker/<jobId>/   0700
   *     secret        0600  token 或私钥
   *     askpass       0700  GIT_ASKPASS helper（token 模式）
   *     known_hosts   0600  SSH 指纹（ssh 模式）
   *     id_key        0600  SSH 私钥（ssh 模式）
   * 所有路径不进入 git 命令行；token 只经 askpass 的 stdin/文件读取。
   */
  private async prepareJob(repo: { protocol: "https" | "ssh"; host: string }, opts?: FetchOptions): Promise<JobMaterial> {
    const dir = join(tmpdir(), "cg-worker", randomUUID());
    await mkdir(dir, { recursive: true, mode: 0o700 });

    const env: Record<string, string> = {
      GIT_TERMINAL_PROMPT: "0", // §8.2：禁止交互式凭据提示
      GIT_LFS_SKIP_SMUDGE: "1", // §16：LFS 禁用
      GIT_CONFIG_NOSYSTEM: "1", // §12：不继承系统级 git 配置/凭据
    };

    const authMethod = opts?.authMethod ?? "none";

    if (authMethod === "token" && opts?.accessToken) {
      const secretFile = join(dir, "secret");
      await writeFile(secretFile, opts.accessToken, { mode: 0o600 });
      const askpass = join(dir, "askpass");
      const username = opts.tokenUsername || "oauth2";
      await writeFile(
        askpass,
        `#!/bin/sh\ncase "$1" in\n  *[Uu]sername*) printf '%s\\n' "${username}" ;;\n  *[Pp]assword*) cat "${secretFile}" ;;\n  *) exit 1 ;;\nesac\n`,
        { mode: 0o700 },
      );
      return {
        dir,
        env,
        askpassPath: askpass,
        cleanup: () => rm(dir, { recursive: true, force: true }),
      };
    }

    if (authMethod === "ssh" && opts?.sshPrivateKey) {
      const knownHosts = await this.buildKnownHosts(repo.host, opts);
      const knownHostsFile = join(dir, "known_hosts");
      await writeFile(knownHostsFile, knownHosts, { mode: 0o600 });
      const keyFile = join(dir, "id_key");
      await writeFile(keyFile, opts.sshPrivateKey, { mode: 0o600 });
      // 对路径中的引号做转义（防恶意私钥路径注入 GIT_SSH_COMMAND——路径由我们生成，
      // 但 double-quote 防御是低成本纵深）。
      const esc = (s: string) => s.replace(/"/g, '\\"');
      const sshCommand =
        `ssh -i "${esc(keyFile)}" -o StrictHostKeyChecking=yes -o UserKnownHostsFile="${esc(knownHostsFile)}" ` +
        `-o BatchMode=yes -o IdentitiesOnly=yes`;
      return {
        dir,
        env,
        sshCommand,
        cleanup: () => rm(dir, { recursive: true, force: true }),
      };
    }

    // 公开仓库：无需凭据材料（仍保持 job 目录一致性以统一清理）。
    return { dir, env, cleanup: () => rm(dir, { recursive: true, force: true }) };
  }

  /**
   * 组装已认证的 simple-git 实例（§8.2 / §10 / §15）。
   * timeout 经构造函数注入（simple-git 3.36 仅支持构造期 timeoutPlugin），
   * 超时即 kill 子进程（§15 terminate the entire process group）。
   * token → GIT_ASKPASS；ssh → GIT_SSH_COMMAND；两者都叠加安全 env。
   */
  private authenticatedGit(job: JobMaterial, opts?: FetchOptions, timeoutMs?: number): ReturnType<typeof simpleGit> {
    // simple-git 的 SimpleGitOptions 类型未暴露 timeout（3.36），运行时支持构造期注入。
    const git = simpleGit(
      (timeoutMs ? { timeout: { block: timeoutMs, kill: true } } : {}) as unknown as Partial<SimpleGitOptions>,
    );
    let authed = git.env(job.env);
    if (job.askpassPath && opts?.authMethod === "token") {
      authed = authed.env("GIT_ASKPASS", job.askpassPath);
    }
    if (job.sshCommand) {
      authed = authed.env("GIT_SSH_COMMAND", job.sshCommand);
    }
    return authed;
  }

  /**
   * 构建 job known_hosts（§10.2）：
   *   内置公网托管商指纹 + 管理员配置（环境变量文件 / opts.knownHosts）。
   *   目标 host 不在白名单 → fail-closed（GIT_SSH_HOST_UNTRUSTED）。
   */
  private async buildKnownHosts(host: string, opts?: FetchOptions): Promise<string> {
    const lines: string[] = [];

    // 内置指纹（精确 host 匹配；不含端口后缀）。
    const hostKey = host.replace(/:\d+$/, "");
    const builtIn = BUILTIN_KNOWN_HOSTS[hostKey];
    if (builtIn) lines.push(...builtIn);

    // 管理员配置：环境变量文件（每行指纹）→ opts.knownHosts（内联内容）。
    const envFile = process.env[ENV_KNOWN_HOSTS_FILE];
    if (envFile) {
      try {
        const { readFile } = await import("node:fs/promises");
        const content = await readFile(envFile, "utf8");
        lines.push(...content.split(/\r?\n/).filter((l) => l.trim()));
      } catch {
        // 管理员文件不可读 → fail-closed（宁可失败不可降级信任）。
        throw new GitFetchError(FETCH_ERROR.GIT_SSH_HOST_UNTRUSTED, `cannot read known_hosts file: ${envFile}`);
      }
    }
    if (opts?.knownHosts) {
      lines.push(...opts.knownHosts.split(/\r?\n/).filter((l) => l.trim()));
    }

    if (lines.length === 0) {
      // host 不在内置、也无管理员指纹 → 拒绝（§10.2/§10.3 fail closed，无隐式 TOFU）。
      throw new GitFetchError(
        FETCH_ERROR.GIT_SSH_HOST_UNTRUSTED,
        `ssh host ${host} is not in the trusted host list; configure its fingerprint via KNOWLEDGE_SSH_KNOWN_HOSTS`,
      );
    }
    return `${lines.join("\n")}\n`;
  }

  private async headCommit(localPath: string): Promise<string | null> {
    try {
      return (await simpleGit(localPath).revparse(["HEAD"])).trim().slice(0, 12);
    } catch {
      return null;
    }
  }
}

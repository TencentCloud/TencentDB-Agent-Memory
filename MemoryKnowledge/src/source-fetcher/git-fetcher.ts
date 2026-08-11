/**
 * GitSourceFetcher — 基于 simple-git 的源码拉取实现。
 *
 * simple-git 内部用 child_process.spawn + args 数组，不走 shell，从原理上消除 shell 注入。
 *
 * 安全防护（002 §4-5）：
 *   - R1 git hooks：clone/fetch 本就不拉取远端 .git/hooks（hooks 为本地态），故不额外
 *     配置 core.hooksPath（加固版 git 会拒绝该配置，需 allowUnsafeHooksPath）。
 *   - R2 SSRF：只允许 HTTPS/SSH + 内网/环回地址黑名单（对齐项目 security_rules）。
 *   - R3 凭据（005）：token 经 URL 注入、ssh 经 GIT_SSH_COMMAND 注入；clone/sync 后
 *     立即还原 origin 干净 URL 并删除 FETCH_HEAD，防 token 落盘 .git/config 与 .git/FETCH_HEAD。
 *   - Bug 修复（方案 A）：增量 sync 的 git clean 排除 .codegraph/，避免删掉 codegraph 索引库。
 */

import simpleGit, { CleanOptions, ResetMode } from "simple-git";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { ISourceFetcher, FetchResult, FetchOptions, SourceType } from "./types.js";

/**
 * 内网 / 环回 / link-local 地址黑名单（标准网段）：
 *   - 10. / 172.16-31. / 192.168.  → RFC1918 私有网段
 *   - 169.254.                     → link-local（含云元数据 169.254.169.254）
 *   - 127. / 0. / localhost / ::1  → 环回
 *   - fe80:                        → IPv6 link-local
 *
 * 该黑名单可通过环境变量 KNOWLEDGE_SSRF_CHECK=off 关闭（见 GitSourceFetcher 构造）。
 */
const PRIVATE_ADDR_RE =
  /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|127\.|0\.|localhost$|::1$|fe80:)/i;

/**
 * 读取 SSRF 私网黑名单开关。默认开启；
 * 当 KNOWLEDGE_SSRF_CHECK 为 off/false/0/no（大小写不敏感）时关闭。
 */
function ssrfCheckEnabledFromEnv(): boolean {
  const raw = process.env.KNOWLEDGE_SSRF_CHECK;
  if (raw == null || raw.trim() === "") return true;
  const v = raw.trim().toLowerCase();
  return !(v === "off" || v === "false" || v === "0" || v === "no");
}

export interface GitSourceFetcherOptions {
  /**
   * 是否启用 SSRF 私网 / 环回地址黑名单校验。
   * 默认读环境变量 KNOWLEDGE_SSRF_CHECK（默认开启）；显式传入时优先于环境变量。
   */
  ssrfCheck?: boolean;
}

export class GitSourceFetcher implements ISourceFetcher {
  readonly supportedType: SourceType = "git";

  /** SSRF 私网黑名单校验开关（https-only 协议校验始终生效，不受此开关影响）。 */
  private readonly ssrfCheck: boolean;

  constructor(opts?: GitSourceFetcherOptions) {
    this.ssrfCheck = opts?.ssrfCheck ?? ssrfCheckEnabledFromEnv();
  }

  validate(sourceUrl: string): void {
    // HTTPS（公开/带凭据）+ SSH（git@ / ssh://）私有仓库（005 私有仓库鉴权）。
    const isHttps = sourceUrl.startsWith("https://");
    const isSsh = sourceUrl.startsWith("ssh://") || sourceUrl.startsWith("git@");
    if (!isHttps && !isSsh) {
      throw new Error("only supports HTTPS or SSH repos; other protocols are not supported");
    }
    const host = this.extractHost(sourceUrl);
    if (!host) {
      throw new Error(`invalid repo_url: cannot parse host from ${sourceUrl}`);
    }
    // R2: SSRF 防护 —— 禁止指向内网 / 环回地址（可经 KNOWLEDGE_SSRF_CHECK=off 关闭）。
    if (this.ssrfCheck && this.isPrivateAddress(host)) {
      throw new Error(`repo_url must not point to private/loopback address: ${host}`);
    }
  }

  async fetch(sourceUrl: string, branch: string, localPath: string, opts?: FetchOptions): Promise<FetchResult> {
    this.validate(sourceUrl);
    const authUrl = this.buildAuthUrl(sourceUrl, opts);
    let sshKeyPath: string | null = null;
    try {
      // 浅克隆单分支。注：git clone/fetch 不会拉取远端的 .git/hooks（hooks 是本地态），
      // 所以正常仓库 clone 出来不带可执行钩子；此处不再配置 core.hooksPath
      // （加固版 git 会拒绝该配置：需 allowUnsafeHooksPath）。
      sshKeyPath = await this.prepareSshKey(opts);
      let git = simpleGit();
      if (sshKeyPath) git = git.env("GIT_SSH_COMMAND", this.sshCommand(sshKeyPath));
      await git.clone(authUrl, localPath, {
        "--depth": 1,
        "--branch": branch,
      });
      const version = await this.headCommit(localPath);
      return { localPath, version, sourceType: "git" };
    } catch (err) {
      // clone 失败：清理残留目录（.git/config 已含带凭据 URL，且不完整目录会污染下次增量 sync）
      try {
        rmSync(localPath, { recursive: true, force: true });
      } catch {
        // 忽略清理失败
      }
      throw err;
    } finally {
      // 无论成败还原 origin 为干净 URL + 删 FETCH_HEAD（clone 创建目录后即写入 config）
      await this.cleanFetchArtifacts(localPath, sourceUrl, authUrl !== sourceUrl);
      if (sshKeyPath) {
        try {
          await unlink(sshKeyPath);
        } catch {
          // 忽略
        }
      }
    }
  }

  async sync(sourceUrl: string, branch: string, localPath: string, opts?: FetchOptions): Promise<FetchResult> {
    this.validate(sourceUrl);
    const authUrl = this.buildAuthUrl(sourceUrl, opts);
    let sshKeyPath: string | null = null;
    try {
      sshKeyPath = await this.prepareSshKey(opts);
      const git = simpleGit(localPath);
      // 临时把 origin 指向带凭据 URL（fetch 不写 config，用完即还原）；
      // 直接 fetch URL 不会更新 origin/<branch> 的 remote-tracking ref，故用 set-url 方案。
      if (authUrl !== sourceUrl) await git.remote(["set-url", "origin", authUrl]);
      let authedGit: typeof git = git;
      if (sshKeyPath) authedGit = git.env("GIT_SSH_COMMAND", this.sshCommand(sshKeyPath));
      await authedGit.fetch("origin", branch, { "--depth": 1 });
      await authedGit.reset(ResetMode.HARD, [`origin/${branch}`]);
      // Bug 修复（方案 A）：clean 排除 .codegraph/，否则会删掉 codegraph 的索引库，
      // 导致增量 sync 永远失败、每次回退到全量 clone。
      await authedGit.clean(CleanOptions.FORCE + CleanOptions.RECURSIVE, ["-e", ".codegraph"]);
      const version = await this.headCommit(localPath);
      return { localPath, version, sourceType: "git" };
    } finally {
      await this.cleanFetchArtifacts(localPath, sourceUrl, authUrl !== sourceUrl);
      if (sshKeyPath) {
        try {
          await unlink(sshKeyPath);
        } catch {
          // 忽略
        }
      }
    }
  }

  // ── 内部 helper ──

  /**
   * token 方式构造带凭据 URL：https://{tokenUsername ?? "oauth2"}:{token}@host/...
   * （GitHub 任意 username + PAT 密码均接受；Gitee 需真实用户名；GitLab 用 oauth2:）。
   * ssh / 公开仓库返回原 URL。
   */
  private buildAuthUrl(sourceUrl: string, opts?: FetchOptions): string {
    if (opts?.authMethod !== "token" || !opts.accessToken) return sourceUrl;
    try {
      const u = new URL(sourceUrl);
      u.username = opts.tokenUsername || "oauth2";
      u.password = opts.accessToken;
      return u.toString();
    } catch {
      return sourceUrl;
    }
  }

  /** ssh 方式把私钥写入临时文件（0600），返回 key 路径；非 ssh 返回 null。 */
  private async prepareSshKey(opts?: FetchOptions): Promise<string | null> {
    if (opts?.authMethod !== "ssh" || !opts.sshPrivateKey) return null;
    const keyPath = join(tmpdir(), `cg-key-${randomUUID()}`);
    await writeFile(keyPath, opts.sshPrivateKey, { mode: 0o600 });
    return keyPath;
  }

  private sshCommand(keyPath: string): string {
    return `ssh -i "${keyPath}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;
  }

  /**
   * 凭据不留盘：还原 origin 为干净 URL + 删除 FETCH_HEAD（其内容含带凭据 URL）。
   * 幂等：目录不存在/无 .git 时静默跳过。
   */
  private async cleanFetchArtifacts(localPath: string, cleanUrl: string, authed: boolean): Promise<void> {
    if (!authed) return;
    try {
      await simpleGit(localPath).remote(["set-url", "origin", cleanUrl]);
    } catch {
      // 目录不存在或非 git 仓库，忽略
    }
    try {
      await unlink(join(localPath, ".git", "FETCH_HEAD"));
    } catch {
      // 不存在，忽略
    }
  }

  private async headCommit(localPath: string): Promise<string | null> {
    try {
      return (await simpleGit(localPath).revparse(["HEAD"])).trim().slice(0, 12);
    } catch {
      return null;
    }
  }

  private extractHost(url: string): string {
    try {
      // git@host:path 形式的 SCP-like SSH URL 先规范化为 ssh://host/path
      const normalized = url.startsWith("git@") ? `ssh://${url.replace(/^git@/, "").replace(":", "/")}` : url;
      return new URL(normalized).hostname;
    } catch {
      return "";
    }
  }

  private isPrivateAddress(host: string): boolean {
    return PRIVATE_ADDR_RE.test(host);
  }
}

/**
 * GitSourceFetcher — 基于 simple-git 的源码拉取实现。
 *
 * simple-git 内部用 child_process.spawn + args 数组，不走 shell，从原理上消除 shell 注入。
 *
 * 安全防护（002 §4-5）：
 *   - R1 git hooks：clone/fetch 本就不拉取远端 .git/hooks（hooks 为本地态），故不额外
 *     配置 core.hooksPath（加固版 git 会拒绝该配置，需 allowUnsafeHooksPath）。
 *   - R2 SSRF：只允许 public HTTPS + 内网/环回地址黑名单（对齐项目 security_rules）。
 *   - Bug 修复（方案 A）：增量 sync 的 git clean 排除 .codegraph/，避免删掉 codegraph 索引库。
 */

import simpleGit, { CleanOptions, ResetMode } from "simple-git";
import type { ISourceFetcher, FetchResult, SourceType } from "./types.js";

/**
 * 识别 git 认证 / 权限类错误（simple-git 无 TTY，git 交互式询问 Username/Password
 * 会变成 `could not read Username for '...': No such device or address`）。
 *
 * 这类错误对用户极具误导性：本质是仓库需要认证（401/403），却被 git 表述成
 * 「无法读取用户名」。用这里集中识别，再在 worker 层按是否带凭据转成人类可读提示。
 */
export function isGitAuthError(raw: string): boolean {
  const msg = raw.toLowerCase();
  return (
    msg.includes("could not read username") ||
    msg.includes("could not read password") ||
    msg.includes("authentication failed") ||
    msg.includes("permission denied") ||
    msg.includes("returned error: 401") ||
    msg.includes("returned error: 403") ||
    msg.includes("could not read from remote repository") ||
    msg.includes("unable to access") ||
    msg.includes("remote: you are not allowed")
  );
}

/** 把 git 认证错误转成面向用户的提示。needsCredential = clone 时是否已注入凭据。 */
export function explainGitAuthError(raw: string, needsCredential: boolean): string {
  const brief = raw.split("\n").find((l) => l.trim())?.trim() ?? raw.trim();
  if (needsCredential) {
    return (
      `访问令牌无效或已过期，无法拉取仓库（git: ${brief}）。` +
      `请在仓库详情里重新填写访问令牌。`
    );
  }
  return (
    `该仓库需要身份认证，无法以「公开」方式克隆（git: ${brief}）。` +
    `请删除后重新注册，来源选择对应的代码平台并填写访问令牌。`
  );
}

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
    // 第一版：仅支持 public HTTPS 仓库（SSH / 私有仓库鉴权见文档 005）。
    if (!sourceUrl.startsWith("https://")) {
      throw new Error(
        "first version only supports public HTTPS repos; SSH/private repo support coming soon",
      );
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

  async fetch(sourceUrl: string, branch: string, localPath: string): Promise<FetchResult> {
    this.validate(sourceUrl);
    // 浅克隆单分支。注：git clone/fetch 不会拉取远端的 .git/hooks（hooks 是本地态），
    // 所以正常仓库 clone 出来不带可执行钩子；此处不再配置 core.hooksPath
    // （加固版 git 会拒绝该配置：需 allowUnsafeHooksPath）。
    await simpleGit().clone(sourceUrl, localPath, {
      "--depth": 1,
      "--branch": branch,
    });
    const version = await this.headCommit(localPath);
    return { localPath, version, sourceType: "git" };
  }

  async sync(sourceUrl: string, branch: string, localPath: string): Promise<FetchResult> {
    this.validate(sourceUrl);
    const git = simpleGit(localPath);
    await git.fetch("origin", branch, { "--depth": 1 });
    await git.reset(ResetMode.HARD, [`origin/${branch}`]);
    // Bug 修复（方案 A）：clean 排除 .codegraph/，否则会删掉 codegraph 的索引库，
    // 导致增量 sync 永远失败、每次回退到全量 clone。
    await git.clean(CleanOptions.FORCE + CleanOptions.RECURSIVE, ["-e", ".codegraph"]);
    const version = await this.headCommit(localPath);
    return { localPath, version, sourceType: "git" };
  }

  // ── 内部 helper ──

  private async headCommit(localPath: string): Promise<string | null> {
    try {
      return (await simpleGit(localPath).revparse(["HEAD"])).trim().slice(0, 12);
    } catch {
      return null;
    }
  }

  private extractHost(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  }

  private isPrivateAddress(host: string): boolean {
    return PRIVATE_ADDR_RE.test(host);
  }
}

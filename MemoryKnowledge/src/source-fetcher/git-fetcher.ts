/**
 * GitSourceFetcher — 基于 simple-git 的源码拉取实现（公开仓库 + 私有仓库）。
 *
 * simple-git 内部用 child_process.spawn + args 数组，不走 shell，从原理上消除 shell 注入。
 *
 * 安全防护（002 §4-5）：
 *   - R1 git hooks：clone/fetch 本就不拉取远端 .git/hooks（hooks 为本地态），故不额外
 *     配置 core.hooksPath（加固版 git 会拒绝该配置，需 allowUnsafeHooksPath）。
 *   - R2 SSRF：协议白名单 + 内网/环回地址黑名单，可经 `KNOWLEDGE_GIT_ALLOWED_HOSTS`
 *     白名单放行企业内网 Git 服务（对齐项目 security_rules）。
 *   - R3 URL 内嵌凭证：`https://user:token@host/...` 一律拒绝 —— 该写法会把 token
 *     落到 .git/config、git stderr 与所有回显错误信息的地方，改用凭证管理。
 *   - R4 认证注入：见 git-auth.ts（子进程 env 注入，不进 URL / argv / .git/config）。
 *   - Bug 修复（方案 A）：增量 sync 的 git clean 排除 .codegraph/，避免删掉 codegraph 索引库。
 */

import simpleGit, { CleanOptions, ResetMode } from "simple-git";

import { buildGitAuthEnv, type GitAuthEnvOptions } from "./git-auth.js";
import {
  hasEmbeddedCredentials,
  isAllowedHost,
  isPrivateHost,
  parseGitUrl,
  type ParsedGitUrl,
} from "./git-url.js";
import { sanitizeGitError } from "../utils/sanitize.js";
import type { FetchOptions, FetchResult, ISourceFetcher, SourceType } from "./types.js";

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
  /**
   * 允许访问内网 / 私有地址的 host 白名单。命中即跳过 SSRF 黑名单 ——
   * 企业内网 GitLab 场景必须显式在这里声明，而不是关掉整个 SSRF 校验。
   * 白名单条目只写 host，不写端口；`*.corp.example.com` 为单层 label 通配。
   */
  allowedHosts?: readonly string[];
  /** SSH 严格 host key 校验（StrictHostKeyChecking=yes）；默认 false = accept-new。 */
  strictHostKey?: boolean;
  /** 持久 known_hosts 文件路径（固定单一路径，绝不按 host 拼接）。 */
  knownHostsPath?: string;
  /** 非致命提示出口。 */
  onWarn?: (message: string) => void;
}

export class GitSourceFetcher implements ISourceFetcher {
  readonly supportedType: SourceType = "git";

  /** SSRF 私网黑名单校验开关。 */
  private readonly ssrfCheck: boolean;
  private readonly allowedHosts: readonly string[];
  private readonly authOptions: GitAuthEnvOptions;

  constructor(opts?: GitSourceFetcherOptions) {
    this.ssrfCheck = opts?.ssrfCheck ?? ssrfCheckEnabledFromEnv();
    this.allowedHosts = opts?.allowedHosts ?? [];
    this.authOptions = {
      strictHostKey: opts?.strictHostKey,
      knownHostsPath: opts?.knownHostsPath,
      onWarn: opts?.onWarn,
    };
  }

  /**
   * 校验 sourceUrl。检查顺序（有依赖，不要调换）：
   *   1. 可解析（含 host 字符白名单 —— 这是命令注入的第一道防线）
   *   2. 协议白名单（http 仅在内网白名单命中时放行）
   *   3. 拒绝 URL 内嵌凭证
   *   4. host 白名单命中 → 放行
   *   5. SSRF 黑名单
   */
  validate(sourceUrl: string): void {
    const parsed = this.requireParsed(sourceUrl);

    if (parsed.protocol === "http" && !this.isAllowlisted(parsed.host)) {
      throw new Error(
        "repo_url must use https:// (plain http:// is only accepted for hosts listed in KNOWLEDGE_GIT_ALLOWED_HOSTS)",
      );
    }

    if (hasEmbeddedCredentials(sourceUrl)) {
      throw new Error(
        "repo_url must not embed credentials (https://user:token@host/...). " +
          "Register a git credential and pass its credential_id instead.",
      );
    }

    if (this.isAllowlisted(parsed.host)) return;

    if (this.ssrfCheck && isPrivateHost(parsed.host)) {
      throw new Error(
        `repo_url must not point to private/loopback address: ${parsed.host} ` +
          `(add it to KNOWLEDGE_GIT_ALLOWED_HOSTS if it is a trusted internal git server)`,
      );
    }
  }

  async fetch(
    sourceUrl: string,
    branch: string,
    localPath: string,
    options?: FetchOptions,
  ): Promise<FetchResult> {
    this.validate(sourceUrl);

    // 浅克隆单分支。注：git clone/fetch 不会拉取远端的 .git/hooks（hooks 是本地态），
    // 所以正常仓库 clone 出来不带可执行钩子；此处不再配置 core.hooksPath
    // （加固版 git 会拒绝该配置：需 allowUnsafeHooksPath）。
    const plan = options?.auth ? buildGitAuthEnv(options.auth, this.authOptions) : null;
    try {
      const git = plan ? simpleGit({ unsafe: plan.unsafe }).env(plan.env) : simpleGit();
      await git.clone(sourceUrl, localPath, {
        "--depth": 1,
        "--branch": branch,
      });
      const version = await this.headCommit(localPath);
      return { localPath, version, sourceType: "git" };
    } catch (err) {
      throw new Error(this.sanitize(err, plan?.secrets));
    } finally {
      plan?.cleanup();
    }
  }

  async sync(
    sourceUrl: string,
    branch: string,
    localPath: string,
    options?: FetchOptions,
  ): Promise<FetchResult> {
    this.validate(sourceUrl);

    // 每次新建实例：simple-git 的 env 是**实例态**，复用一个实例会把上一次的
    // 凭证带给下一次调用。
    const plan = options?.auth ? buildGitAuthEnv(options.auth, this.authOptions) : null;
    try {
      const git = plan ? simpleGit(localPath, { unsafe: plan.unsafe }).env(plan.env) : simpleGit(localPath);
      await git.fetch("origin", branch, { "--depth": 1 });
      await git.reset(ResetMode.HARD, [`origin/${branch}`]);
      // Bug 修复（方案 A）：clean 排除 .codegraph/，否则会删掉 codegraph 的索引库，
      // 导致增量 sync 永远失败、每次回退到全量 clone。
      await git.clean(CleanOptions.FORCE + CleanOptions.RECURSIVE, ["-e", ".codegraph"]);
      const version = await this.headCommit(localPath);
      return { localPath, version, sourceType: "git" };
    } catch (err) {
      throw new Error(this.sanitize(err, plan?.secrets));
    } finally {
      plan?.cleanup();
    }
  }

  /** 解析一次并缓存，避免 validate/fetch 各解析一遍时结果不一致。 */
  parse(sourceUrl: string): ParsedGitUrl | null {
    return parseGitUrl(sourceUrl);
  }

  /**
   * 只读连通性探测（`git ls-remote --heads`）—— 凭证校验用，不落盘、不建目录。
   *
   * 刻意**不**按分支过滤：新仓库可能还没有目标分支，用 `--exit-code <branch>`
   * 会把「凭证有效」误报成失败。这里只回答「凭证 + 网络能否读到 refs」。
   */
  async probe(
    sourceUrl: string,
    branch: string | undefined,
    options?: FetchOptions,
  ): Promise<{ ok: boolean; error?: string; note?: string }> {
    this.validate(sourceUrl);

    const plan = options?.auth ? buildGitAuthEnv(options.auth, this.authOptions) : null;
    try {
      const git = plan ? simpleGit({ unsafe: plan.unsafe }).env(plan.env) : simpleGit();
      const out = await git.raw(["ls-remote", "--heads", sourceUrl]);
      if (branch && out && !out.split("\n").some((line) => line.trim().endsWith(`refs/heads/${branch}`))) {
        return { ok: true, note: `branch '${branch}' not found on remote (the credential itself works)` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: this.sanitize(err, plan?.secrets) };
    } finally {
      plan?.cleanup();
    }
  }

  // ── 内部 helper ──

  private requireParsed(sourceUrl: string): ParsedGitUrl {
    const parsed = parseGitUrl(sourceUrl);

    if (!parsed) {
      const embedded = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(sourceUrl.trim())
        ? ""
        : " (scp-like URLs must look like git@host:path)";
      throw new Error(
        `invalid repo_url${embedded}: only https://, ssh:// and scp-like (git@host:path) are supported`,
      );
    }

    return parsed;
  }

  private isAllowlisted(host: string): boolean {
    return isAllowedHost(host, this.allowedHosts);
  }

  private sanitize(err: unknown, secrets?: string[]): string {
    const msg = err instanceof Error ? err.message : String(err);
    return sanitizeGitError(msg, secrets);
  }

  private async headCommit(localPath: string): Promise<string | null> {
    try {
      return (await simpleGit(localPath).revparse(["HEAD"])).trim().slice(0, 12);
    } catch {
      return null;
    }
  }
}

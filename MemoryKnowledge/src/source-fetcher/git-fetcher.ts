/**
 * GitSourceFetcher — 基于 simple-git 的源码拉取实现。
 *
 * simple-git 内部用 child_process.spawn + args 数组，不走 shell，从原理上消除 shell 注入。
 *
 * 安全防护（002 §4-5）：
 *   - R1 git hooks：clone/fetch 本就不拉取远端 .git/hooks（hooks 为本地态），故不额外
 *     配置 core.hooksPath（加固版 git 会拒绝该配置，需 allowUnsafeHooksPath）。
 *   - R2 SSRF：HTTPS 与 SSH 均做内网/环回地址黑名单（对齐项目 security_rules）。
 *   - Bug 修复（方案 A）：增量 sync 的 git clean 排除 .codegraph/，避免删掉 codegraph 索引库。
 *
 * SSH 支持（2026-10-10）：协议白名单从 https-only 放开到 https + ssh(`git@` / `ssh://`)；
 * 私钥经 `GIT_SSH_COMMAND` 注入，仅活在子进程 env 里，不落盘、不进日志。
 */

import { simpleGit, CleanOptions, ResetMode, type SimpleGit } from "simple-git";
import type { ISourceFetcher, FetchResult, SourceType, GitFetchOptions } from "./types.js";
import { isSshUrl, parseSshHost, buildSshCommand } from "./ssh-options.js";

/**
 * 放行 `GIT_SSH_COMMAND`（simple-git ≥3.36 的 CVE 防护要求显式声明）。
 *
 * 见 `gitFor()` 注释：命令串全部由受控字段拼装，无不可信输入，故可安全开启。
 * 单独抽成常量是为了让「这里开了 unsafe 开关」在代码里只有一处、易于审计。
 */
const UNSAFE_SSH_COMMAND = { allowUnsafeSshCommand: true } as const;

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
    msg.includes("remote: you are not allowed") ||
    // ── SSH 特有 ──
    msg.includes("permission denied (publickey)") ||
    msg.includes("host key verification failed") ||
    msg.includes("no more authentication methods available")
  );
}

/**
 * 从 git 原文里挑出**真正的失败原因**。
 *
 * 不能只取第一行：git 输出以 `Cloning into '<path>'...` 开头，
 * 那是进度信息不是错误。只取首行会让所有失败都显示成"Cloning into ..."，
 * 真实原因被吞掉（曾导致分支不存在被误报成 SSH 认证失败）。
 *
 * 取法：优先最后一条 `fatal:` / `error:` 行；没有就退回最后一条非空行。
 */
function pickGitErrorLine(raw: string): string {
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const fatal = lines.filter((l) => /^(fatal|error)/i.test(l));
  return (fatal.length > 0 ? fatal[fatal.length - 1] : lines[lines.length - 1]) ?? raw.trim();
}

/** 把 git 认证错误转成面向用户的提示。needsCredential = clone 时是否已注入凭据。 */
export function explainGitAuthError(raw: string, needsCredential: boolean): string {
  const brief = pickGitErrorLine(raw);
  // SSH 认证失败（公钥未配置 / 未被授权）另行提示，引导用户去配公钥。
  if (isSshAuthError(raw)) {
    return (
      `SSH 认证失败，无法拉取仓库（git: ${brief}）。` +
      `请确认已在代码平台添加本服务的 SSH 公钥（可在注册弹窗重新获取），且该公钥有该仓库的读权限。`
    );
  }
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
 * 是否为「远端没有该分支」。
 *
 * git 的原文（`Could not find remote branch main to clone` /
 * `Remote branch main not found in upstream origin`）不含任何可行动信息，
 * 用户看到只会以为仓库坏了，实际改个分支名就好。
 */
export function isRemoteBranchMissingError(raw: string): boolean {
  const msg = raw.toLowerCase();
  const patterns = [
    "could not find remote branch",
    "remote branch", // 与下面的 not found 配合判定
    "couldn't find remote ref",
    "could not find remote ref",
  ];
  const matched = patterns.filter((p) => msg.includes(p));
  if (matched.length === 0) return false;
  // "remote branch" 单独出现不足以判定（正常信息里也有），需同时出现 not found。
  if (matched.length === 1 && matched[0] === "remote branch") {
    return msg.includes("not found");
  }
  return true;
}

/** 是否为 SSH 认证类错误（区别于 HTTPS 的令牌失效）。 */
export function isSshAuthError(raw: string): boolean {
  const msg = raw.toLowerCase();
  return (
    msg.includes("permission denied (publickey)") ||
    msg.includes("host key verification failed") ||
    msg.includes("no more authentication methods available")
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

  /** SSRF 私网黑名单校验开关（协议白名单始终生效，不受此开关影响）。 */
  private readonly ssrfCheck: boolean;

  constructor(opts?: GitSourceFetcherOptions) {
    this.ssrfCheck = opts?.ssrfCheck ?? ssrfCheckEnabledFromEnv();
  }

  validate(sourceUrl: string): void {
    // 协议白名单：HTTPS（公开 / 私有仓 URL 注入令牌）+ SSH（GIT_SSH_COMMAND 注入私钥）。
    // 其它协议（file://、ftp://、git:// 明文协议等）一律拒绝。
    if (!this.isAllowedProtocol(sourceUrl)) {
      throw new Error(
        "repo_url must use https:// , git@host:path or ssh:// scheme",
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

  async fetch(sourceUrl: string, branch: string, localPath: string, opts?: GitFetchOptions): Promise<FetchResult> {
    this.validate(sourceUrl);
    // 浅克隆单分支。注：git clone/fetch 不会拉取远端的 .git/hooks（hooks 是本地态），
    // 所以正常仓库 clone 出来不带可执行钩子；此处不再配置 core.hooksPath
    // （加固版 git 会拒绝该配置：需 allowUnsafeHooksPath）。
    // clone 到尚未存在的目标目录，故不设 baseDir（与改造前一致：simpleGit() 无 cwd）。
    try {
      await this.gitFor(sourceUrl, undefined, opts).clone(sourceUrl, localPath, {
        "--depth": 1,
        "--branch": branch,
      });
    } catch (err) {
      // 「远端没有这个分支」是最常见的注册失败原因（前端默认填 main，
      // 而不少仓库默认分支仍是 master）。git 的原文没有可行动信息，
      // 这里列一下远端实际分支，用户改一个名字就能过。
      throw await this.explainBranchError(err, sourceUrl, branch, opts);
    }
    const version = await this.headCommit(localPath);
    return { localPath, version, sourceType: "git" };
  }

  /**
   * clone 失败且疑似「分支不存在」时，列出远端真实分支再抛。
   *
   * 只在命中的情况下额外发一次 `git ls-remote --heads`（仅 SSH/HTTPS 读操作，
   * 无副作用）；其它错误原样抛出，不改变既有行为。
   */
  private async explainBranchError(
    err: unknown,
    sourceUrl: string,
    branch: string,
    opts?: GitFetchOptions,
  ): Promise<unknown> {
    const raw = err instanceof Error ? err.message : String(err);
    if (!isRemoteBranchMissingError(raw)) return err;

    let available: string[] = [];
    try {
      const out = await this.gitFor(sourceUrl, undefined, opts).listRemote(["--heads", sourceUrl]);
      available = (out ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.replace(/^[0-9a-f]+\s+refs\/heads\//, ""))
        .filter(Boolean);
    } catch {
      // 列不出来就只给基础提示，不掩盖原始错误。
    }

    const brief = pickGitErrorLine(raw);
    const hint =
      available.length > 0
        ? `该仓库不存在分支「${branch}」（git: ${brief}）。远端可用分支：${available.slice(0, 20).join("、")}${available.length > 20 ? " 等" : ""}。请改用其中任一分支重新注册。`
        : `该仓库不存在分支「${branch}」（git: ${brief}）。请确认分支名后重新注册。`;
    return new Error(hint);
  }

  async sync(sourceUrl: string, branch: string, localPath: string, opts?: GitFetchOptions): Promise<FetchResult> {
    this.validate(sourceUrl);
    // ★ 增量同步同样要带 SSH 私钥：`git fetch origin` 走的还是 ssh 传输，
    //   缺 GIT_SSH_COMMAND 会因为拿不到 key 而认证失败。
    const git = this.gitFor(sourceUrl, localPath, opts); // baseDir = 已存在的仓库目录
    await git.fetch("origin", branch, { "--depth": 1 });
    await git.reset(ResetMode.HARD, [`origin/${branch}`]);
    // Bug 修复（方案 A）：clean 排除 .codegraph/，否则会删掉 codegraph 的索引库，
    // 导致增量 sync 永远失败、每次回退到全量 clone。
    await git.clean(CleanOptions.FORCE + CleanOptions.RECURSIVE, ["-e", ".codegraph"]);
    const version = await this.headCommit(localPath);
    return { localPath, version, sourceType: "git" };
  }

  // ── 内部 helper ──

  /**
   * 构造 simple-git 实例，必要时带上 `GIT_SSH_COMMAND`。
   *
   * 只有 SSH 类 URL 才注入；HTTPS 下实例与改造前完全一致（不引入任何副作用）。
   *
   * ⚠ `unsafe.allowUnsafeSshCommand` 是**必须**的，不是可选项：
   *   simple-git ≥3.36 为修 CVE（`-c core.sshCommand` / env 注入可执行任意命令）
   *   内置了 block-unsafe-operations 插件，凡是子进程 env 里出现 `GIT_SSH_COMMAND`
   *   就一律拦截并抛：
   *     Use of "GIT_SSH_COMMAND" is not permitted without enabling allowUnsafeSshCommand
   *   该插件按 `config.unsafe[category] === true` 放行，故这里显式声明。
   *
   * 为什么这里是安全的（即为什么可以放心开这个开关）：
   *   - 命令串由 `buildSshCommand()` 用**受控字段**拼装 —— 私钥路径与 known_hosts
   *     路径都来自本服务 `ssh-key/` 模块按 username 白名单生成的绝对路径，
   *     不含任何用户输入的 URL / 分支名 / repo 名。
   *   - 开关只在「SSH URL + 有 ssh opts」分支下开，HTTPS 请求永不触碰。
   *   （真正需要防的是"把不可信输入拼进 ssh 命令"，那由 ssh-options.ts 保证。）
   *
   * @param localPath 仓库工作目录。clone 时目标目录尚不存在，传 undefined；
   *                  sync / 读版本时传实际目录作 baseDir。
   */
  private gitFor(sourceUrl: string, localPath?: string, opts?: GitFetchOptions): SimpleGit {
    if (!isSshUrl(sourceUrl) || !opts?.ssh) {
      return localPath ? simpleGit(localPath) : simpleGit();
    }
    // 放行开关只在这一个分支里开，作用域最小。
    const git = localPath
      ? simpleGit(localPath, { unsafe: UNSAFE_SSH_COMMAND })
      : simpleGit({ unsafe: UNSAFE_SSH_COMMAND });
    // simple-git 无 options.env：用链式 env() 注入，语义等价且是官方支持写法。
    return git.env({ GIT_SSH_COMMAND: buildSshCommand(opts.ssh) });
  }

  /** 协议白名单：https / ssh（scp 写法与 ssh:// 标准写法）。 */
  private isAllowedProtocol(url: string): boolean {
    const v = (url ?? "").trim();
    return v.startsWith("https://") || isSshUrl(v);
  }

  private async headCommit(localPath: string): Promise<string | null> {
    try {
      return (await simpleGit(localPath).revparse(["HEAD"])).trim().slice(0, 12);
    } catch {
      return null;
    }
  }

  /** HTTPS 用 URL 解析；SSH 用专用解析器（new URL 处理不了 `git@host:path`）。 */
  private extractHost(url: string): string {
    if (isSshUrl(url)) return parseSshHost(url);
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

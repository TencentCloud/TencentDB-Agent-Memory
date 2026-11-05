/**
 * SourceFetcher 接口层 — 协议无关的源码拉取与安全校验抽象。
 *
 * 职责：把"从某个 source（git/local/ftp）拉取代码到本地目录"抽象成统一接口，
 * 安全校验（协议白名单 + SSRF 防护）集中在各实现的 validate() 里。
 * 具体实现（如 GitSourceFetcher）依赖 simple-git，但该依赖不泄漏到本接口层。
 */

import type { SshFetchOptions } from "./ssh-options.js";

export type SourceType = "git" | "local" | "ftp";

export interface FetchResult {
  /** 源码落盘的本地目录（绝对路径）。 */
  localPath: string;
  /** 当前版本标识（git 为 commit hash 前 12 位；取不到为 null）。 */
  version: string | null;
  /** 源协议类型。 */
  sourceType: SourceType;
}

/**
 * 拉取选项（协议特有）。
 *
 * 设为**可选**是为了向后兼容既有调用与单测——HTTPS 公开仓/私有仓传 undefined，
 * 行为与改造前完全一致。
 */
export interface GitFetchOptions {
  /**
   * SSH 拉取凭证。存在即注入 `GIT_SSH_COMMAND`（私钥路径 + known_hosts）。
   * 仅当 sourceUrl 是 `git@` / `ssh://` 时有意义；HTTPS 下被忽略。
   */
  ssh?: SshFetchOptions;
}

/**
 * 源码拉取器接口。实现者负责：
 *   1. 校验 sourceUrl 安全性（协议白名单、SSRF 等）
 *   2. 拉取/同步源码到 localPath
 *   3. 返回版本标识
 *
 * 实现：
 *   - GitSourceFetcher：simple-git；支持 public/private HTTPS 与 SSH（GIT_SSH_COMMAND）
 *   - LocalSourceFetcher / FtpSourceFetcher：未来扩展
 */
export interface ISourceFetcher {
  /** 首次拉取：把源码下载到 localPath。 */
  fetch(sourceUrl: string, branch: string, localPath: string, opts?: GitFetchOptions): Promise<FetchResult>;

  /** 增量同步：更新已存在的 localPath 到最新版本。 */
  sync(sourceUrl: string, branch: string, localPath: string, opts?: GitFetchOptions): Promise<FetchResult>;

  /** 校验 sourceUrl 是否合法（协议白名单 + SSRF 防护）。非法则 throw。 */
  validate(sourceUrl: string): void;

  /** 支持的协议类型。 */
  readonly supportedType: SourceType;
}

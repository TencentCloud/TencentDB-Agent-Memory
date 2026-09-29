/**
 * SourceFetcher 接口层 — 协议无关的源码拉取与安全校验抽象。
 *
 * 职责：把"从某个 source（git/local/ftp）拉取代码到本地目录"抽象成统一接口，
 * 安全校验（协议白名单 + SSRF 防护）集中在各实现的 validate() 里。
 * 具体实现（如 GitSourceFetcher）依赖 simple-git，但该依赖不泄漏到本接口层。
 */

import type { GitAuthMaterial } from "./git-auth.js";

export type SourceType = "git" | "local" | "ftp";

/**
 * 单次拉取的可选参数。
 *
 * `auth` 为缺省时按匿名访问处理 —— 公开仓库的行为与未支持凭证时逐字节一致。
 * 凭证材料由调用方（worker）在每次拉取前解析注入，fetcher 不持有、不缓存。
 */
export interface FetchOptions {
  /** 私有仓库的认证材料；缺省 = 匿名。 */
  auth?: GitAuthMaterial;
}

export interface FetchResult {
  /** 源码落盘的本地目录（绝对路径）。 */
  localPath: string;
  /** 当前版本标识（git 为 commit hash 前 12 位；取不到为 null）。 */
  version: string | null;
  /** 源协议类型。 */
  sourceType: SourceType;
}

/**
 * 源码拉取器接口。实现者负责：
 *   1. 校验 sourceUrl 安全性（协议白名单、SSRF 等）
 *   2. 拉取/同步源码到 localPath
 *   3. 返回版本标识
 *
 * 实现：
 *   - GitSourceFetcher：simple-git，支持公开 HTTPS + 私有仓库（HTTPS Token / SSH 私钥）
 *   - LocalSourceFetcher / FtpSourceFetcher：未来扩展
 */
export interface ISourceFetcher {
  /** 首次拉取：把源码下载到 localPath。 */
  fetch(sourceUrl: string, branch: string, localPath: string, options?: FetchOptions): Promise<FetchResult>;

  /** 增量同步：更新已存在的 localPath 到最新版本。 */
  sync(sourceUrl: string, branch: string, localPath: string, options?: FetchOptions): Promise<FetchResult>;

  /** 校验 sourceUrl 是否合法（协议白名单 + SSRF 防护）。非法则 throw。 */
  validate(sourceUrl: string): void;

  /**
   * 只读连通性探测（凭证校验用），不落盘。
   * 可选实现：不支持的 fetcher 可以不提供，调用方需判空。
   */
  probe?(
    sourceUrl: string,
    branch: string | undefined,
    options?: FetchOptions,
  ): Promise<{ ok: boolean; error?: string; note?: string }>;

  /** 支持的协议类型。 */
  readonly supportedType: SourceType;
}

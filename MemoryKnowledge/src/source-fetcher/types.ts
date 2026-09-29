/**
 * SourceFetcher 接口层 — 协议无关的源码拉取与安全校验抽象。
 *
 * 职责：把"从某个 source（git/local/ftp）拉取代码到本地目录"抽象成统一接口，
 * 安全校验（协议白名单 + SSRF 防护）集中在各实现的 validate() 里。
 * 具体实现（如 GitSourceFetcher）依赖 simple-git，但该依赖不泄漏到本接口层。
 */

export type SourceType = "git" | "local" | "ftp";

export interface FetchResult {
  /** 源码落盘的本地目录（绝对路径）。 */
  localPath: string;
  /** 当前版本标识（git 为完整 commit hash；取不到为 null）。 */
  version: string | null;
  /** 源协议类型。 */
  sourceType: SourceType;
}

export interface SourceVersionProbeResult {
  localVersion: string;
  remoteVersion: string;
}

export type SourceVersionProbeErrorCode =
  | "timeout"
  | "network"
  | "ref_not_found"
  | "remote_error"
  | "local_unavailable";

export class SourceVersionProbeError extends Error {
  readonly code: SourceVersionProbeErrorCode;
  readonly retryable: true;

  constructor(code: SourceVersionProbeErrorCode, message: string) {
    super(message);
    this.name = "SourceVersionProbeError";
    this.code = code;
    this.retryable = true;
  }
}

/**
 * 源码拉取器接口。实现者负责：
 *   1. 校验 sourceUrl 安全性（协议白名单、SSRF 等）
 *   2. 拉取/同步源码到 localPath
 *   3. 返回版本标识
 *
 * 实现：
 *   - GitSourceFetcher：simple-git，第一版仅 public HTTPS（SSH/私有仓库鉴权见文档 005）
 *   - LocalSourceFetcher / FtpSourceFetcher：未来扩展
 */
export interface ISourceFetcher {
  /** 首次拉取：把源码下载到 localPath。 */
  fetch(sourceUrl: string, branch: string, localPath: string): Promise<FetchResult>;

  /** 增量同步：更新已存在的 localPath 到最新版本。 */
  sync(sourceUrl: string, branch: string, localPath: string): Promise<FetchResult>;

  /**
   * Optional bounded read-only version probe. Implementations without a reliable
   * probe intentionally omit this method and retain the full-refresh behavior.
   */
  probeVersion?: (sourceUrl: string, branch: string, localPath: string) => Promise<SourceVersionProbeResult>;

  /** 校验 sourceUrl 是否合法（协议白名单 + SSRF 防护）。非法则 throw。 */
  validate(sourceUrl: string): void;

  /** 支持的协议类型。 */
  readonly supportedType: SourceType;
}

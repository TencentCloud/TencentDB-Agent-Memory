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
  /** 当前版本标识（git 为 commit hash 前 12 位；取不到为 null）。 */
  version: string | null;
  /** 源协议类型。 */
  sourceType: SourceType;
}

/** 私有仓库认证配置（GitSourceFetcher 消费；公开仓库可不传）。 */
export interface FetchOptions {
  /** none=公开仓库；token=经 GIT_ASKPASS 注入（URL 恒干净）；ssh=私钥经 GIT_SSH_COMMAND 注入。 */
  authMethod?: "none" | "token" | "ssh";
  /** authMethod=token 时必填：access token 原文（仅 worker 内存，绝不落库/URL/日志）。 */
  accessToken?: string;
  /** 用户名（Gitee 需真实用户名；GitHub/GitLab 省略时用 oauth2）。 */
  tokenUsername?: string;
  /** authMethod=ssh 时必填：SSH 私钥 PEM 原文（写入 job 专属目录 0600，用完即删）。 */
  sshPrivateKey?: string;
  /** 托管提供商（github/gitlab/gitea/generic）：用于内置 known_hosts 指纹选择与观测。 */
  provider?: "github" | "gitlab" | "gitea" | "generic";
  /** 管理员配置的 known_hosts 内容（追加到 job known_hosts；SSH 时生效）。 */
  knownHosts?: string;
  /** 资源限制（§15）：clone/fetch 超时（毫秒）。缺省读环境变量或内置默认。 */
  cloneTimeoutMs?: number;
  fetchTimeoutMs?: number;
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
  fetch(sourceUrl: string, branch: string, localPath: string, opts?: FetchOptions): Promise<FetchResult>;

  /** 增量同步：更新已存在的 localPath 到最新版本。 */
  sync(sourceUrl: string, branch: string, localPath: string, opts?: FetchOptions): Promise<FetchResult>;

  /** 校验 sourceUrl 是否合法（协议白名单 + SSRF 防护）。非法则 throw。 */
  validate(sourceUrl: string): void;

  /** 支持的协议类型。 */
  readonly supportedType: SourceType;
}

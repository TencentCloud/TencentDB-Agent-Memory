/**
 * ssh-key —— 每用户 SSH 密钥对的存取抽象。
 *
 * 与 HTTPS 私有仓的凭据体系（source-auth/，凭据挂**资源** + URL 注入令牌）正交：
 * 这里的密钥挂**用户**，clone 时通过 `GIT_SSH_COMMAND` 注入。
 *
 * 设计文档：MemoryPanel/docs/design/2026-10-10-codegraph-ssh-clone.md
 */

/** 一把密钥的描述（对外只可发 `publicKey`，其余字段仅 KS 进程内使用）。 */
export interface SshKeyInfo {
  /** 私钥绝对路径。**绝不**出现在 HTTP 响应与日志里。 */
  keyPath: string;
  /** 公钥绝对路径。 */
  pubPath: string;
  /** known_hosts 绝对路径（StrictHostKeyChecking=accept-new 的落点）。 */
  knownHostsPath: string;
  /** 公钥内容（`ssh-rsa AAAA...`）—— 唯一允许外发的字段。 */
  publicKey: string;
  /** 本次调用是否新建。false = 复用既有密钥。 */
  created: boolean;
}

export interface ISshKeyStore {
  /**
   * 取（必要时生成）该用户在当前 service 下的密钥对。
   *
   * 幂等：已存在则直接读回，不重新生成。并发同一 key 只会执行一次 ssh-keygen
   * （实现内用 in-flight Promise 去重）。
   */
  ensure(serviceId: string, username: string): Promise<SshKeyInfo>;

  /**
   * 只读：取已存在的密钥；不存在返回 null（**不生成**）。
   * 供 worker 在 clone 前解析私钥路径用（拿不到要抛可懂错误，不能静默新建）。
   */
  get(serviceId: string, username: string): SshKeyInfo | null;
}

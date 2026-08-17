/**
 * SecretStore — 凭据存储抽象（949spec §5.3 / §7）。
 *
 * 设计原则：凭据是"短生命周期的执行能力"，不是普通应用数据。
 *   - CodeGraph 元数据表只存 credentialRef / version，绝不落明文；
 *   - 明文只允许在执行时由 worker 在隔离环境内短暂解析；
 *   - 轮换（rotate）产生新版本、吊销（revoke）立即失效；
 *   - 队列/日志/API 只出现引用，不出现明文。
 *
 * 实现：
 *   - EnvelopeSecretStore（自托管，§6）：AES-256-GCM 信封加密，见 envelope-store.ts。
 *   - 外部 Secret Manager（云/企业）可依此接口实现（Tencent SM / Vault / KMS）。
 */

/** 凭据认证方式（与 CodeGraph authMethod 对齐，但仅含需保护的两种）。 */
export type CredentialAuthMethod = "token" | "ssh";

/** 凭据生命周期状态（949spec §5.2 CodeGraphCredentialBinding.status）。 */
export type CredentialStatus = "active" | "invalid" | "revoked";

/** 已知 Git 托管提供商（用于 fingerprint / 观测 / 内置 known_hosts 选择）。 */
export type CredentialProvider = "github" | "gitlab" | "gitea" | "generic";

/** 创建凭据的输入。secret 只在调用栈内短暂存在，随后加密落库。 */
export interface CreateSecretInput {
  serviceId: string;
  teamId: string;
  codeGraphId: string;
  authMethod: CredentialAuthMethod;
  /** access token 原文或 SSH 私钥 PEM 原文。 */
  secret: string;
  /** token 方式：用户名（Gitee 需真实用户名；GitHub/GitLab 可省略走 oauth2）。 */
  username?: string;
  provider?: CredentialProvider;
}

/** 创建/轮换后的不可变引用（可安全入队、入库、记日志）。 */
export interface SecretReference {
  credentialRef: string;
  credentialVersion: number;
  /** 不泄露明文内容的安全指纹（SHA256 截断），用于 UI 展示"已配置"。 */
  fingerprint?: string;
}

/** 执行期解析出的明文凭据 —— 只允许存在于 worker 内存，禁止落任何持久化介质。 */
export interface ResolvedSecret {
  credentialRef: string;
  version: number;
  authMethod: CredentialAuthMethod;
  secret: string;
  username?: string;
}

/** 轮换输入：新明文 + 可选用户名。版本号由实现自增。 */
export interface RotateSecretInput {
  secret: string;
  username?: string;
}

/** 凭据状态查询结果（元数据 only，不含明文）。 */
export interface SecretStatusInfo {
  credentialRef: string;
  version: number;
  status: CredentialStatus;
  authMethod: CredentialAuthMethod;
  fingerprint?: string;
  provider?: CredentialProvider;
  lastValidatedAt?: string;
  lastAuthFailureAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** 凭据生命周期接口（949spec §5.3）。 */
export interface SecretStore {
  /** 创建凭据并返回引用。 */
  createSecret(input: CreateSecretInput): Promise<SecretReference>;
  /** 按引用解析明文；version 缺省为最新可用（active 中版本号最大者）。 */
  getSecret(ref: string, options?: { version?: number }): Promise<ResolvedSecret | null>;
  /** 轮换：产生新版本；旧版本保留但不再默认解析。 */
  rotateSecret(ref: string, input: RotateSecretInput): Promise<SecretReference>;
  /** 吊销：之后新任务按 latest 解析不会拿到被吊销版本。 */
  revokeSecret(ref: string): Promise<void>;
  /** 删除：彻底移除（仅用于清理已无引用的凭据）。 */
  deleteSecret(ref: string): Promise<void>;
  /** 查询元数据状态（无明文）。 */
  getStatus(ref: string): Promise<SecretStatusInfo | null>;
  /** 记录一次认证结果（成功/失败），更新 last_validated_at / last_auth_failure_at。 */
  recordAuthResult(ref: string, ok: boolean): Promise<void>;
}

/**
 * code-source —— codegraph 外部来源的抽象。
 *
 * 两个正交维度：
 *   - **Provider（代码平台）** → `providers/<id>.ts`：平台常量 + 选一种 AuthMethod
 *   - **AuthMethod（认证方式）** → `auth-methods/<kind>.ts`：表单/落库/URL 注入
 *
 * 新增平台：写一个 provider 常量选好 authMethod 即可，不动认证层
 * 新增认证方式：写一个 AuthMethod 实现类即可，不动平台层
 */

import type { AuthMethod, AuthMethodKind } from "./auth-methods/types.js";

/** 前端下拉展示用的来源元数据（KS 下发给 Panel，含表单驱动信息）。 */
export interface CodeSourceMeta {
  id: string;
  /** 认证方式类型，前端据此渲染凭据表单。 */
  auth_method: AuthMethodKind;
  /** 该方式的表单字段清单（前端根据这个动态渲染 input）。 */
  form_fields: ReadonlyArray<{ name: string; secret: boolean; required: boolean }>;
  /** 令牌申请指引（拼好的完整 URL；由部署配的站点根 + provider 站内路径拼成）。 */
  token_doc_url?: string;
}

/** 凭据 payload（内部数据，不落库、不出进程）。 */
export interface CredentialPayload {
  secret: string;
  username?: string;
}

/**
 * 平台 provider 契约。
 *
 * 一个平台文件 = 一个常量：
 *   - `id`：来源 id，与部署 `CODE_SOURCE_ENABLED`、i18n `code.source.<id>` 对应
 *   - `authMethod`：从 `auth-methods/` 里选一个（bearer / basic / 未来自定义...）
 *   - `cloneUsername`：仅 bearer 场景用（平台协议规定的占位用户名）
 *   - `sitePaths`：站内页面相对路径
 *
 * **禁止在 provider 里写认证逻辑**——那属于 AuthMethod 的职责。
 */
export interface ICodeSourceProvider {
  readonly id: string;
  readonly authMethod: AuthMethod;
  /** bearer 场景的 basic-auth 占位用户名；basic 场景无需。 */
  readonly cloneUsername?: string;
  readonly sitePaths: {
    /** 令牌 / 账户申请页。 */
    tokenDoc?: string;
  };
  /** 可选：覆盖 AuthMethod 的默认 clone URL 拼法（一般不用）。 */
  applyToCloneUrl?(repoUrl: string, cred: CredentialPayload): string;
  /** 可选：覆盖通用 git 错误映射。 */
  explainCloneError?(rawStderr: string, needsCredential: boolean): string | null;
}

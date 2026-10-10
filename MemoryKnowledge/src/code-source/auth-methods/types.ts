/**
 * AuthMethod —— 一种认证方式的完整封装。
 *
 * 一个 AuthMethod = 一个 kind + 表单元数据 + 结构化 Git 认证 + 落库转换。
 *
 * 新增一种认证方式（如 token-header、oauth-pkce）：
 *   1. 在 `auth-methods/<kind>.ts` 建文件，导出一个实现该接口的常量
 *   2. 在 `auth-methods/index.ts` 的 AUTH_METHODS 数组加一行
 *   3. Provider 里选用 `authMethod: <kindConst>`
 *
 * 没了。存储层、凭据 API、注入入口、前端表单驱动全部由此接口的字段驱动，
 * 不需要动 provider 文件、不需要动 registry、不需要写任何 switch。
 */

import type { CredentialPayload } from "../types.js";
import type { GitSecret } from "../../store/git-credential-store.js";

/** 认证方式类别（判别联合，加成员时全仓 kind 引用点会强制编译报错）。 */
export type AuthMethodKind = "bearer" | "basic";

/** 前端凭据表单里一个字段的描述（i18n key 由前端根据 name 拼）。 */
export interface CredentialFormField {
  /** 字段名，作为 payload key（见 `AuthMethod.buildCredential` 消费）。 */
  name: "secret" | "username";
  /** 是否密码框（type=password）。 */
  secret: boolean;
  /** 是否必填。 */
  required: boolean;
}

/**
 * 认证方式契约。
 *
 * 一个方式的所有决策——表单长什么样、凭据落成什么形状、Git 认证如何生成——
 * 都在这里。业务代码只调这些方法，不判 kind。
 */
export interface AuthMethod {
  readonly kind: AuthMethodKind;

  /** 前端凭据表单：字段清单（决定"要不要显示 username 输入框"）。 */
  readonly formFields: readonly CredentialFormField[];

  /**
   * 前端提交的表单值 → 落库前的凭据形态。
   *
   * 允许方式自己做校验（如"basic 必须同时给 username 和 password"），
   * 通不过就抛错。
   *
   * 注意：不含 provider_id / kind 这些 registry 层已知信息，只管表单值本身。
   */
  buildCredential(form: Record<string, string | undefined>): {
    secret: string;
    username?: string;
  };

  /** Resolve transport authentication without putting secrets into a URL. */
  toGitAuth(cred: CredentialPayload, cloneUsername?: string): Extract<GitSecret, { kind: "https" }>;

  /**
   * @deprecated Compatibility helper only; runtime Git operations use toGitAuth.
   * 把凭据注入 clone URL。
   *
   * 参数 `cloneUsername` 是 provider 侧声明的占位用户名（各平台不同，
   * 由 provider 自行提供，具体取值不在本文档固化），仅 bearer 用；
   * basic 忽略它，一律用 cred.username。
   */
  buildCloneUrl(repoUrl: string, cred: CredentialPayload, cloneUsername?: string): string;
}

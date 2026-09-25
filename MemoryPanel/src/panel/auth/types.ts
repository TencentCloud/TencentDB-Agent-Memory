import type { Context } from 'hono';

export type AuthMethod = 'user_key' | 'idp';
export type ProviderType = 'woa' | 'oidc' | 'oauth2';

/**
 * Provider 与 Panel 的交互形态。
 *
 * - `header-injected`：上游网关代替我方完成 SSO，回跳时把身份写进请求头。
 *   典型：WOA / iOA / TOF。Provider 只需实现 `authenticateFromHeaders`。
 * - `redirect-oauth2`：我方生成 authorize URL、用户浏览器回调带 code，
 *   我方拿 code 换 token、再拉 userinfo。典型：GitHub / 自建 OIDC。
 *   Provider 需实现 `prepareAuthorize` + `authenticateFromCallback`（本 PR 未落地）。
 *
 * 用一个字段收敛能力形态，Service 侧按 `kind` 类型收敛决定走哪一路，
 * 避免在 Service 里按 provider id 硬分支。
 */
export type ProviderKind = 'header-injected' | 'redirect-oauth2';

export interface ExternalIdentity {
  providerId: string;
  subject: string;
  loginName: string;
  displayName?: string;
  email?: string;
  staffId?: string;
  departmentId?: string;
  departmentName?: string;
  claims: Record<string, unknown>;
}

export interface PanelAuthContext {
  method: AuthMethod;
  instanceId: string;
  userId?: string;
  userKey?: string;
  providerId?: string;
  externalSubject?: string;
}

/**
 * 所有 IdP Provider 共有的最小契约。
 *
 * Provider **只**负责「外部协议 → 内部统一 `ExternalIdentity`」的转换，
 * 不感知：
 *   - Core meta API（`user/create`、`user/find-by-external` 等由 Service 侧编排）
 *   - Panel Session / Cookie / Pending 流程（Service 侧）
 *   - Instance Registry（Service 侧）
 *
 * 具体产生 identity 的入口由子接口给出（header-injected / redirect-oauth2）。
 */
export interface AuthProvider {
  readonly id: string;
  readonly type: ProviderType;
  readonly kind: ProviderKind;
  /**
   * 前端登录菜单展示名。允许运行时读取，替代硬编 `'WOA / iOA'`。
   * 与 `id` 分离：id 用于路由/存储稳定键，displayName 可随部署本地化。
   */
  readonly displayName: string;
  /**
   * 写入 Core `meta_users.auth_provider` 的外部域标识。
   * 与 `external_id` 组成账号反查键；每个 Provider 有且仅有一个域。
   */
  readonly authProviderDomain: string;
  buildLoginUrl(callbackUrl: string): string;
  buildLogoutUrl(returnTo: string): string;
}

/**
 * 网关注入头模式的 Provider（WOA / iOA / TOF）。
 *
 * 特征：ingress 中间件按 `ingressHeaderName` 识别归属，命中即调
 * `authenticateFromHeaders` 归一为 `ExternalIdentity`。
 */
export interface HeaderInjectedProvider extends AuthProvider {
  readonly kind: 'header-injected';
  /** ingress 中间件按此头名识别请求归属，如 'x-tai-identity'。**无内置默认**。 */
  readonly ingressHeaderName: string;
  authenticateFromHeaders(
    headers: Record<string, string | undefined>,
  ): Promise<ExternalIdentity | null>;
}

/**
 * OAuth2 / OIDC 模式的 Provider（本 PR 尚未落地实现，接口先立位）。
 *
 * 特征：我方通过 `prepareAuthorize` 生成 authorize URL；用户浏览器回到 callback
 * 带 code + state 时，Service 侧调 `authenticateFromCallback` 换 token + userinfo。
 *
 * 参见 `MemoryPanel/docs/design/2026-09-07-auth-provider-abstraction.md` §六。
 */
export interface RedirectOAuth2Provider extends AuthProvider {
  readonly kind: 'redirect-oauth2';
  prepareAuthorize(input: {
    state: string;
    redirectUri: string;
    nonce?: string;
  }): Promise<{ url: string; codeVerifier?: string }>;
  authenticateFromCallback(input: {
    code: string;
    redirectUri: string;
    codeVerifier?: string;
    expectedNonce?: string;
  }): Promise<ExternalIdentity | null>;
}

export interface AuthRouteContext {
  request: Context;
  instanceId: string;
  returnTo: string;
}


import { createHash, timingSafeEqual } from 'node:crypto';
import { compactDecrypt } from 'jose';
import type { HeaderInjectedProvider, ExternalIdentity } from './types.js';

interface TaiIdentity {
  loginname?: string;
  LoginName?: string;
  staffid?: number | string;
  StaffId?: number | string;
  staffname?: string;
  StaffName?: string;
  chinesename?: string;
  chineseName?: string;
  deptid?: number | string;
  DeptId?: number | string;
  deptname?: string;
  DeptName?: string;
  expiration?: string;
  Expiration?: string;
  [key: string]: unknown;
}

export interface WoaProviderConfig {
  enabled: boolean;
  appToken: string;
  safeMode: boolean;
  requireSignature: boolean;
  appUrl: string;
  loginUrl: string;
  logoutUrl: string;
  paasId: string;
  /**
   * Core `meta_users.auth_provider` 写入域标识（对齐 `PanelAuthConfig.woa.authProvider`）。
   * 建号 / 反查用同一值；构造 Provider 时由 Service 层从 config 注入。
   * 兼容：老调用方未传时视为 'local'（与 Core 默认对齐），行为等价。
   */
  authProvider?: string;
}

function validAppToken(token: string): boolean {
  return Buffer.byteLength(token, 'utf8') === 32;
}

export class WoaProvider implements HeaderInjectedProvider {
  readonly id = 'woa';
  readonly type = 'woa' as const;
  readonly kind = 'header-injected' as const;
  readonly displayName = 'WOA / iOA';
  readonly authProviderDomain: string;
  /**
   * 上游网关注入身份的请求头名。
   *
   * 硬编字面量（不做默认值 fallback）：这是 WOA/iOA 网关的固定协议头，
   * 换协议就换 Provider 类，而不是把它变成配置。
   */
  readonly ingressHeaderName = 'x-tai-identity';

  constructor(private readonly config: WoaProviderConfig) {
    if (config.enabled && !validAppToken(config.appToken)) {
      throw new Error('PANEL_AUTH_WOA_APP_TOKEN must be exactly 32 UTF-8 bytes when WOA auth is enabled');
    }
    if (config.enabled && !config.appUrl) {
      throw new Error('PANEL_AUTH_WOA_APP_URL is required when WOA auth is enabled');
    }
    if (config.enabled) {
      // APP_URL 是**我方**面板的对外地址（WOA 认证后回跳到这里），不是 WOA 的站点，
      // 因此不能套用"WOA 只注册 https"的约束：内网/本地部署用 http 是合法的。
      // 这里只校验它必须是绝对 URL —— WOA 需要把浏览器重定向回来，相对路径无法回跳。
      try {
        new URL(config.appUrl);
      } catch {
        throw new Error('PANEL_AUTH_WOA_APP_URL must be a valid absolute URL');
      }
    }
    this.authProviderDomain = config.authProvider?.trim() || 'local';
  }

  /**
   * `HeaderInjectedProvider` 契约的入口。
   *
   * 保留 `authenticate` 作为等价别名（老测试/兼容用），二者内部同一实现。
   */
  async authenticateFromHeaders(
    headers: Record<string, string | undefined>,
  ): Promise<ExternalIdentity | null> {
    return this.doAuthenticate(headers);
  }

  /** @deprecated 使用 `authenticateFromHeaders`。保留以兼容既有测试与调用点。 */
  async authenticate(headers: Record<string, string | undefined>): Promise<ExternalIdentity | null> {
    return this.doAuthenticate(headers);
  }

  private async doAuthenticate(
    headers: Record<string, string | undefined>,
  ): Promise<ExternalIdentity | null> {
    const normalized = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
    );
    const identityHeader = normalized[this.ingressHeaderName];
    let identity: TaiIdentity | null = null;
    if (identityHeader) {
      const signature = normalized.signature;
      if ((!signature && this.config.requireSignature) || (signature && !this.verifySignature(normalized))) {
        return null;
      }
      identity = await this.decryptIdentity(identityHeader);
    }
    if (!identity && !this.config.safeMode) identity = this.readPlainIdentity(normalized);
    if (!identity) return null;

    const loginName = this.stringValue(identity.loginname ?? identity.LoginName);
    const staffId = this.stringValue(identity.staffid ?? identity.StaffId);
    const subject = staffId || loginName;
    if (!subject) return null;
    return {
      providerId: this.id,
      subject,
      loginName: loginName || subject,
      displayName: this.stringValue(identity.chinesename ?? identity.chineseName ?? identity.staffname ?? identity.StaffName),
      staffId,
      departmentId: this.stringValue(identity.deptid ?? identity.DeptId),
      departmentName: this.stringValue(identity.deptname ?? identity.DeptName),
      claims: identity,
    };
  }

  /**
   * 取必须由配置提供的 URL。
   *
   * 不设内置默认值：WOA 的登录/登出地址属于内网基础设施信息，硬编码进源码既是信息暴露，
   * 也让"忘记配置"退化成静默错误（跳到错误地址、无任何报错，极难排查）。
   * 显式抛错，让漏配在启动/建链时立刻暴露。
   */
  private requiredUrl(value: string, envKey: string): string {
    const trimmed = (value ?? '').trim();
    if (!trimmed) {
      throw new Error(`${envKey} is required when WOA auth is enabled (no built-in default)`);
    }
    try {
      new URL(trimmed);
    } catch {
      throw new Error(`${envKey} must be a valid absolute URL`);
    }
    return trimmed;
  }

  buildLoginUrl(callbackUrl: string): string {
    const base = this.requiredUrl(this.config.loginUrl, 'PANEL_AUTH_WOA_LOGIN_URL');
    const query = [`oauth=true`, `url=${encodeURIComponent(callbackUrl)}`];
    if (this.config.paasId) query.push(`appkey=${encodeURIComponent(this.config.paasId)}`);
    return `${base}${base.includes('?') ? '&' : '?'}${query.join('&')}`;
  }

  buildLogoutUrl(returnTo: string): string {
    const base = this.requiredUrl(this.config.logoutUrl, 'PANEL_AUTH_WOA_LOGOUT_URL');
    const query = ['oauth=true'];
    if (this.config.paasId) query.push(`appkey=${encodeURIComponent(this.config.paasId)}`);
    query.push(`url=${encodeURIComponent(returnTo)}`);
    return `${base}${base.includes('?') ? '&' : '?'}${query.join('&')}`;
  }

  private async decryptIdentity(header: string): Promise<TaiIdentity | null> {
    try {
      const { plaintext } = await compactDecrypt(header, Buffer.from(this.config.appToken, 'utf8'));
      const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
      if (!parsed || typeof parsed !== 'object') return null;
      const identity = parsed as TaiIdentity;
      const expiration = identity.expiration ?? identity.Expiration;
      if (expiration) {
        const expiry = Date.parse(expiration);
        if (!Number.isFinite(expiry) || expiry < Date.now() - 5 * 60 * 1000) return null;
      }
      return identity;
    } catch {
      return null;
    }
  }

  private verifySignature(headers: Record<string, string | undefined>): boolean {
    const timestamp = headers.timestamp;
    const signature = headers.signature;
    if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
    const timestampNumber = Number(timestamp);
    if (!Number.isSafeInteger(timestampNumber) || Math.abs(Math.floor(Date.now() / 1000) - timestampNumber) > 180) {
      return false;
    }
    const extHeaders = this.config.safeMode
      ? [headers['x-rio-seq'] ?? '', '', '', '']
      : [headers['x-rio-seq'] ?? '', headers.staffid ?? '', headers.staffname ?? '', headers['x-ext-data'] ?? ''];
    const source = `${timestamp}${this.config.appToken}${extHeaders.join(',')}${timestamp}`;
    const expected = createHash('sha256').update(source).digest('hex').toUpperCase();
    const actual = signature.toUpperCase();
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
  }

  private readPlainIdentity(headers: Record<string, string | undefined>): TaiIdentity | null {
    const staffId = headers.staffid;
    const staffName = headers.staffname;
    if (!staffId && !staffName) return null;
    return { staffid: staffId, staffname: staffName, loginname: staffName || staffId };
  }

  private stringValue(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    const text = String(value).trim();
    return text || undefined;
  }
}


import type { AuthProvider, HeaderInjectedProvider, ProviderKind, RedirectOAuth2Provider } from './types.js';

export class AuthProviderRegistry {
  private readonly providers = new Map<string, AuthProvider>();

  register(provider: AuthProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`duplicate auth provider: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
  }

  get(id: string): AuthProvider | null {
    return this.providers.get(id) ?? null;
  }

  list(): AuthProvider[] {
    return [...this.providers.values()];
  }

  /**
   * 按能力形态筛选 Provider。
   *
   * 用于 ingress 中间件（`header-injected` 类需要按头名匹配）与 callback 路由
   * （`redirect-oauth2` 类需要用 state → 定位 provider）的场景。
   */
  listByKind(kind: 'header-injected'): HeaderInjectedProvider[];
  listByKind(kind: 'redirect-oauth2'): RedirectOAuth2Provider[];
  listByKind(kind: ProviderKind): AuthProvider[] {
    return this.list().filter((p) => p.kind === kind);
  }
}


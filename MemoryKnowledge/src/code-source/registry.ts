/**
 * CodeSourceRegistry —— provider 注册中心。
 *
 * 职责：
 *   1. 按 `CODE_SOURCE_ENABLED` 从内置 provider 集合中挑选启用的
 *   2. 提供 `get(id)` 让业务层拿到 provider 实例
 *   3. 提供 `list()` 生成前端下拉 + 表单驱动用的元数据（含认证方式的表单字段清单）
 *
 * **注册中心不感知任何具体平台或认证方式**——两者都只在各自目录里。
 *
 * 部署配置：
 *   CODE_SOURCE_ENABLED=<id1>,<id2>
 *   CODE_SOURCE_<UPPER_ID>_SITE_BASE_URL=...
 */

import { BUILTIN_PROVIDERS } from "./providers/index.js";
import type { CodeSourceMeta, ICodeSourceProvider } from "./types.js";
import { bearerAuthMethod } from "./auth-methods/bearer.js";

function env(key: string): string | undefined {
  const v = process.env[key];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

function envKey(id: string, suffix: string): string {
  return `CODE_SOURCE_${id.toUpperCase().replace(/-/g, "_")}_${suffix}`;
}

function joinSitePath(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function enabledIds(): string[] {
  const raw = env("CODE_SOURCE_ENABLED");
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 由 provider + 部署配置生成前端表单驱动元数据。
 *
 * 令牌页 URL = 部署配的站点根 + provider 内置的站内路径。
 * 站点根未配置 → 不展示「如何获取令牌？」入口。
 */
function toMeta(provider: ICodeSourceProvider): CodeSourceMeta {
  const siteBase = env(envKey(provider.id, "SITE_BASE_URL"));
  const tokenPath = provider.sitePaths.tokenDoc;
  const tokenDocUrl =
    siteBase && tokenPath ? joinSitePath(siteBase, tokenPath) : siteBase ?? undefined;
  return {
    id: provider.id,
    auth_method: provider.authMethod.kind,
    form_fields: provider.authMethod.formFields,
    token_doc_url: tokenDocUrl,
  };
}

export class CodeSourceRegistry {
  private readonly providers = new Map<string, ICodeSourceProvider>();

  /**
   * @param ids 显式启用列表（测试注入用）；不传 → 从 `CODE_SOURCE_ENABLED` 读
   * @param builtins 内置 provider（测试注入用）；不传 → 用 BUILTIN_PROVIDERS
   */
  constructor(ids?: string[], builtins: readonly ICodeSourceProvider[] = BUILTIN_PROVIDERS) {
    const enabledSet = new Set(ids ?? enabledIds());
    for (const p of builtins) {
      if (enabledSet.has(p.id)) this.providers.set(p.id, p);
    }
    // 声明启用但未内置 → 占位（bearer 默认，需 register() 补齐真正实现）
    for (const id of enabledSet) {
      if (!this.providers.has(id)) {
        this.providers.set(id, {
          id,
          authMethod: bearerAuthMethod,
          sitePaths: {},
        });
      }
    }
  }

  register(provider: ICodeSourceProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): ICodeSourceProvider | undefined {
    return this.providers.get(id);
  }

  list(): CodeSourceMeta[] {
    return Array.from(this.providers.values()).map(toMeta);
  }
}

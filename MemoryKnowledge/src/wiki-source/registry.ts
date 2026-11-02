/**
 * WikiSourceRegistry —— wiki provider 注册中心。
 *
 * 与 CodeSourceRegistry 对称：注册中心不感知任何具体平台，
 * 平台差异只在 `providers/<id>/` 里。
 *
 * 部署配置（同名模式）：
 *   WIKI_SOURCE_ENABLED=iwiki
 *   WIKI_SOURCE_<UPPER_ID>_<ENDPOINT_SUFFIX>=https://...  # 服务端点（后缀由 provider 声明，默认 MCP_URL）
 *   WIKI_SOURCE_<UPPER_ID>_SITE_BASE_URL=https://.../     # 站点根（拼令牌页）
 *
 * 展示名不做成配置：前端按 `wiki.source.<id>` 走 i18n。
 *
 * 注册中心**不感知任何具体平台**：内置清单来自 providers/index.ts，
 * 端点配置名由 provider 自行声明 → 接入 REST 型平台无需改本文件。
 */

import type { SourceContext, WikiSourceMeta, WikiSourceProvider } from "./types.js";
import { BUILTIN_PROVIDERS } from "./providers/index.js";

/** 端点配置名后缀的默认值：MCP 协议型。 */
const DEFAULT_ENDPOINT_SUFFIX = "MCP_URL";

function env(key: string): string | undefined {
  const v = process.env[key];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

function envKey(id: string, suffix: string): string {
  return `WIKI_SOURCE_${id.toUpperCase().replace(/-/g, "_")}_${suffix}`;
}

function joinSitePath(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function enabledIds(): string[] {
  const raw = env("WIKI_SOURCE_ENABLED");
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 解析令牌申请页地址。
 *
 * - provider 声明 `tokenUrlEnv` → **直接用该 env 的完整 URL**，不拼接。
 *   该 env 名是**全局的**（如 `TAI_PAT_URL`），不按来源加前缀 ——
 *   这样多个来源可以指向同一个令牌页，改地址只改一处。
 * - provider 声明 `path` → 拼到部署配的 `WIKI_SOURCE_<ID>_SITE_BASE_URL`。
 *
 * 地址一律来自部署配置：**不在代码里硬编码内网域名**。
 */
function resolveTokenDocUrl(provider: WikiSourceProvider): string | undefined {
  const tokenDoc = provider.sitePaths.tokenDoc;

  // 完整 URL（不拼接）：多个来源共用同一令牌页时用它。
  if (tokenDoc && "tokenUrlEnv" in tokenDoc) return env(tokenDoc.tokenUrlEnv);

  if (tokenDoc && "path" in tokenDoc) {
    const siteBase = env(envKey(provider.id, "SITE_BASE_URL"));
    return siteBase ? joinSitePath(siteBase, tokenDoc.path) : undefined;
  }
  return undefined;
}

function toMeta(provider: WikiSourceProvider): WikiSourceMeta {
  return {
    id: provider.id,
    auth_method: provider.authMethod.kind,
    form_fields: provider.authMethod.formFields,
    token_doc_url: resolveTokenDocUrl(provider),
  };
}

export class WikiSourceRegistry {
  private readonly providers = new Map<string, WikiSourceProvider>();

  constructor(
    ids?: string[],
    builtins: readonly WikiSourceProvider[] = BUILTIN_PROVIDERS,
  ) {
    const enabledSet = new Set(ids ?? enabledIds());
    const known = new Set(builtins.map((p) => p.id));
    // 启用未内置的 id 属配置错误：立即抛错，不静默塞占位
    const unknown = [...enabledSet].filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new Error(
        `WIKI_SOURCE_ENABLED contains unknown source(s): ${unknown.join(", ")}. ` +
          `Available: ${[...known].join(", ") || "(none)"}.`,
      );
    }
    for (const p of builtins) {
      if (enabledSet.has(p.id)) this.providers.set(p.id, p);
    }
  }

  register(provider: WikiSourceProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): WikiSourceProvider | undefined {
    return this.providers.get(id);
  }

  list(): WikiSourceMeta[] {
    return Array.from(this.providers.values()).map(toMeta);
  }

  /**
   * 构造拉取上下文：把部署配的服务端点 + 传入凭据组合成 SourceContext。
   *
   * 端点配置名由 provider 声明（`endpointEnvSuffix`，默认 `MCP_URL`），
   * 因此 MCP 型与 REST 型平台都适用，注册中心不假设具体协议。
   *
   * 未配端点 → 抛错（内网基础设施必须显式配置，无内置默认）。
   */
  contextFor(
    id: string,
    secret: string,
    username?: string,
  ): { provider: WikiSourceProvider; ctx: SourceContext } {
    const provider = this.get(id);
    if (!provider) throw new Error(`wiki source provider '${id}' is not registered`);
    const suffix = provider.endpointEnvSuffix ?? DEFAULT_ENDPOINT_SUFFIX;
    const key = envKey(id, suffix);
    const endpoint = env(key);
    if (!endpoint) {
      throw new Error(
        `missing ${key}: endpoint must be configured explicitly (declared by provider '${id}')`,
      );
    }
    return {
      provider,
      ctx: { secret, username, endpoint },
    };
  }
}

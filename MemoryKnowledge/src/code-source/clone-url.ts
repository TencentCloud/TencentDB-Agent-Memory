/**
 * clone-url —— URL basic-auth 底层工具 + provider-aware 派发入口。
 *
 * 分层：
 *   - `injectBasicAuth`：纯粹的 `https://<user>:<pass>@host/...` 编码，无业务
 *   - `buildCloneUrl`：入口。provider.applyToCloneUrl 覆盖 → 走 provider；
 *     否则委托给 provider.authMethod.buildCloneUrl（bearer/basic 分别处理）
 */

import type { CredentialPayload, ICodeSourceProvider } from "./types.js";

export class CloneUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloneUrlError";
  }
}

/**
 * 底层 URL basic-auth 编码工具（无业务，不判 kind）。
 *
 * 输入 `{user, pass}` 与仓库 URL → 输出 `https://<user>:<pass>@host/...`。
 * user / pass 都做 URL 编码；只放行 https。
 */
export function injectBasicAuth(
  repoUrl: string,
  auth: { user: string; pass: string },
): string {
  const cleanUrl = stripCredentials(repoUrl);
  const url = tryParse(cleanUrl);
  if (!url) throw new CloneUrlError(`invalid repo URL: ${repoUrl}`);
  if (url.protocol !== "https:") {
    throw new CloneUrlError(`repo URL must be https:// (got ${url.protocol}//)`);
  }
  if (!auth.user) throw new CloneUrlError("basic-auth user is required");
  if (!auth.pass) throw new CloneUrlError("basic-auth pass is required");
  url.username = encodeURIComponent(auth.user);
  url.password = encodeURIComponent(auth.pass);
  return url.toString();
}

/**
 * 把 URL 里的凭据剥掉（clone 完成后落回 .git/config 用的干净地址）。
 * 幂等：干净地址传进来原样返回。
 */
export function stripCredentials(repoUrl: string): string {
  const url = tryParse(repoUrl);
  if (!url) return repoUrl;
  url.username = "";
  url.password = "";
  return url.toString();
}

function tryParse(s: string): URL | null {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

/**
 * provider-aware 派发入口。
 *
 * 优先级：
 *   1. `provider.applyToCloneUrl`（provider 完全接管）
 *   2. `provider.authMethod.buildCloneUrl`（默认，按认证方式分派）
 */
export function buildCloneUrl(
  provider: ICodeSourceProvider,
  repoUrl: string,
  cred: CredentialPayload,
): string {
  if (provider.applyToCloneUrl) {
    return provider.applyToCloneUrl(repoUrl, cred);
  }
  return provider.authMethod.buildCloneUrl(repoUrl, cred, provider.cloneUsername);
}

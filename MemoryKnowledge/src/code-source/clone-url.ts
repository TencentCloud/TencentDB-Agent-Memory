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
 *
 * ⚠ **SSH 地址必须原样返回**：`git@` / `ssh://git@` 里的 `git` 是 SSH 登录用户，
 * 不是凭据。用 `new URL()` 清空 username 会把它一并删掉，变成
 * `ssh://host:2222/path.git` —— GitLab/GitHub 的 SSH 端点只接受 `git` 用户，
 * 于是 clone 必然认证失败（表现为"SSH 认证失败"但公钥其实没问题）。
 *
 * 不 import source-fetcher 的 isSshUrl 以避免循环依赖（source-fetcher ← code-source），
 * 这里用同规则的本地判定。
 */
export function stripCredentials(repoUrl: string): string {
  const v = (repoUrl ?? "").trim();
  // SSH：scp 写法 `git@host:path` 与标准 `ssh://` 写法都没有 HTTP 凭据可剥。
  if (v.startsWith("git@") || v.startsWith("ssh://")) return repoUrl;

  const url = tryParse(v);
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

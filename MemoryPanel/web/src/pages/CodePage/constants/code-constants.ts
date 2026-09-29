/**
 * code-constants —— Code 资产页的常量、类型与纯工具函数。
 * 从 CodeSourcesPanel.tsx 拆出。
 *
 * 通用资产类型与 formatShortTime 已收敛到 @/lib/asset-common，此处 re-export
 * 保持原有 import 路径不变。
 */
export type { SubView, ViewMode, StatusFilter, ScopeTab } from '@/lib/asset-common';
export { formatShortTime } from '@/lib/asset-common';

/** HTTPS and SSH URLs without embedded secrets. Server validates again before use. */
export function normalizeGitUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value || /[\\\s\x00-\x1f\x7f]/.test(value)) return null;
  const scp = /^([a-zA-Z0-9_-]+)@([a-zA-Z0-9.-]+):([^?#]+)$/.exec(value);
  try {
    const url = new URL(scp ? `ssh://${scp[1]}@${scp[2]}/${scp[3]}` : value);
    if (!['https:', 'ssh:'].includes(url.protocol) || !url.hostname || !url.pathname || url.pathname === '/' || url.search || url.hash || url.password) return null;
    if (url.protocol === 'https:' && url.username) return null;
    if (url.protocol === 'ssh:' && !/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(url.username)) return null;
    return scp ? `${scp[1]}@${url.hostname}:${scp[3]}` : url.toString();
  } catch { return null; }
}

export function isValidGitUrl(raw: string): boolean { return normalizeGitUrl(raw) !== null; }

export function isSshGitUrl(raw: string): boolean {
  const normalized = normalizeGitUrl(raw);
  return normalized !== null && !normalized.startsWith('https:');
}

export function credentialMatchesRepo(credential: { kind: 'https' | 'ssh'; hostname: string | null }, repoUrl: string): boolean {
  const normalized = normalizeGitUrl(repoUrl);
  if (!normalized) return false;
  if (credential.kind === 'ssh') return !normalized.startsWith('https:');
  return normalized.startsWith('https:') && new URL(normalized).hostname.replace(/\.$/, '') === credential.hostname;
}

/**
 * 从 Git URL 提取可读的仓库名称。
 *
 * repo_name 可能为空（旧数据），此时回退到 URL 会显得很长。
 * 这里从 URL 中提取最后两段路径作为 `namespace/repo` 格式：
 *   https://gitlab.example.com/namespace/repo.git → namespace/repo
 *   https://github.com/org/project.git → org/project
 *   https://git.woa.com/group/sub/repo.git → sub/repo
 * 如果只有一段路径，直接返回该段（去掉 .git 后缀）。
 * 解析失败时返回原始 URL（保底）。
 */
export function formatRepoName(repoName: string, repoUrl: string): string {
  if (repoName && !repoName.startsWith('http')) return repoName;
  const url = repoName || repoUrl;
  if (!url) return '';
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
    if (segments.length >= 2) return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
    if (segments.length === 1) return segments[0];
  } catch {
    // fallback
  }
  return url;
}

/**
 * code-constants —— Code 资产页的常量、类型与纯工具函数。
 * 从 CodeSourcesPanel.tsx 拆出。
 *
 * 通用资产类型与 formatShortTime 已收敛到 @/lib/asset-common，此处 re-export
 * 保持原有 import 路径不变。
 */
export type { SubView, ViewMode, StatusFilter, ScopeTab } from '@/lib/asset-common';
export { formatShortTime } from '@/lib/asset-common';

/**
 * Code Graph 注册入口的轻量校验。
 *
 * 后端 SourceFetcherRegistry 才是最终校验边界；UI 不再要求 URL 必须以 .git 结尾。
 * 当前允许：
 *   - HTTPS Git 地址（是否带 .git 均可）；
 *   - /workspace/repos 下的容器本地路径；
 *   - file:///workspace/repos/... 路径。
 *
 * 保留非空/无空格检查，SSH 仍由调用方提示当前不支持。
 * 函数名暂保持不变以避免无意义扩大改动面。
 */
export function isValidGitHttpUrl(raw: string): boolean {
  const value = raw.trim();
  if (!value || /\s/.test(value)) return false;

  if (value === '/workspace/repos' || value.startsWith('/workspace/repos/')) return true;
  if (
    value === 'file:///workspace/repos' ||
    value.startsWith('file:///workspace/repos/')
  ) {
    return true;
  }

  return /^https:\/\/[^\s]+$/i.test(value);
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

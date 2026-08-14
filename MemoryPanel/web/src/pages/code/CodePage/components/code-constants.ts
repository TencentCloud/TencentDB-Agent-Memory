/**
 * code-constants —— Code 资产页的常量、类型与纯工具函数。
 * 从 CodeSourcesPanel.tsx 拆出。
 */
export type SubView = 'list' | 'detail';
export type ViewMode = 'card' | 'list';
export type StatusFilter = 'all' | 'ready' | 'processing' | 'error';
export type ScopeTab = 'team' | 'fixed';

export function formatShortTime(iso?: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 校验是否为合法的 HTTP(S) Git 仓库地址（正则匹配）。
 * 要求：http/https 协议、host 含点（真实域名）、路径不含空格且以 .git 结尾。
 * 用正则而非 URL 解析 —— new URL() 会接受路径中的空格（如 /a b/repo.git），
 * 且不强制 .git 后缀，均不符合 code graph 注册的严格约束。
 * SSH（git@...）不在此判定为 true —— 由调用方单独提示"暂不支持 SSH"。
 */
const GIT_HTTP_URL_RE = /^https?:\/\/[^\s/]+\.[^\s/]+\/[^\s]+\.git$/i;
export function isValidGitHttpUrl(raw: string): boolean {
  return GIT_HTTP_URL_RE.test(raw.trim());
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

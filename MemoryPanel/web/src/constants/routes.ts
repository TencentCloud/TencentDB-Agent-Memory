/**
 * 路由 path ↔ PageId 映射与激活页解析（纯常量 + 纯函数，无 React / DOM 依赖）。
 *
 * ConsoleLayout（菜单、标签栏）与 KeepAlivePages（页面保活缓存键）共用同一份映射，
 * 避免两处各写一套 startsWith 规则导致「标签高亮的是 A、缓存帧却按 B 存」。
 * 只用 type-only import，保证父包 vitest（node 环境）可以直接导入本模块做单测。
 */
import type { PageId } from './menu';

/** 路由 path → PageId（顺序无关：解析时按「最长前缀」匹配） */
export const PATH_TO_PAGE: Readonly<Record<string, PageId>> = {
  '/': 'workbench_board',
  '/wiki': 'wiki',
  '/code': 'code',
  '/skills': 'skills',
  '/memory': 'chat_memory',
  '/analytics': 'analytics',
  '/team/members': 'team_members',
  '/team/agents': 'team_agents',
  '/team/api-keys': 'api_keys',
};

/** PageId → 路由 path */
export const PAGE_TO_PATH: Readonly<Record<PageId, string>> = Object.fromEntries(
  Object.entries(PATH_TO_PAGE).map(([path, id]) => [id, path]),
) as Record<PageId, string>;

/** 未知路径回落页（与旧逻辑一致：落到工作台） */
export const FALLBACK_PAGE: PageId = 'workbench_board';

/** 使用说明独立页路径：不占标签页，也不进保活缓存 */
export const GUIDE_PATH = '/guide';

/**
 * 归一化 pathname：补前导 `/`、折叠重复 `/`、去掉尾部 `/`（根路径除外）、
 * 剥离误带的 `?query` / `#hash`。
 */
export function normalizePathname(pathname: string): string {
  let p = (pathname ?? '').split(/[?#]/, 1)[0] ?? '';
  p = p.trim().replace(/\/{2,}/g, '/');
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p || '/';
}

export function isGuidePath(pathname: string): boolean {
  return normalizePathname(pathname) === GUIDE_PATH;
}

/**
 * pathname → 激活 PageId。
 *
 * 按段边界做最长前缀匹配：`/wiki` 与 `/wiki/xxx` 命中 wiki，但 `/wikis` 不会；
 * `/team/members` 不会被 `/team` 之类的短前缀抢走。未知路径回落到工作台。
 */
export function resolveActivePage(pathname: string): PageId {
  const p = normalizePathname(pathname);
  let best: { len: number; id: PageId } | null = null;
  for (const [path, id] of Object.entries(PATH_TO_PAGE)) {
    if (path === '/') continue;
    if (p === path || p.startsWith(`${path}/`)) {
      if (!best || path.length > best.len) best = { len: path.length, id };
    }
  }
  return best ? best.id : FALLBACK_PAGE;
}

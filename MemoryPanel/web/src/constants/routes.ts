/**
 * 路由 path ↔ PageId 映射。
 *
 * 从 ConsoleLayout 抽出：多标签页保活（KeepAlivePages）需要按 pathname 缓存页面帧，
 * 与 ConsoleLayout 共用同一份映射，避免两处各写一份导致不一致。
 *
 * 注意：这里只放纯常量，不引入 React，避免与 layouts 形成循环依赖。
 */
import type { PageId } from '@/constants/menu';

/** 路由 path → PageId */
export const PATH_TO_PAGE: Record<string, PageId> = {
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
export const PAGE_TO_PATH: Record<PageId, string> = Object.fromEntries(
  Object.entries(PATH_TO_PAGE).map(([path, id]) => [id, path]),
) as Record<PageId, string>;

/**
 * 当前 pathname 归属的 PageId。
 *
 * 子路由（如将来出现 `/wiki/xxx`）按前缀归到同一页签；
 * 未命中任何已知 path 时回落到工作台（与既有行为一致）。
 */
export function resolveActivePage(pathname: string): PageId {
  const match = Object.entries(PATH_TO_PAGE).find(
    ([path]) => path !== '/' && pathname.startsWith(path),
  );
  return match ? match[1] : 'workbench_board';
}

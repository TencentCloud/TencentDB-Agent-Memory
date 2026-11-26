/**
 * KeepAlivePages — 多标签页「保活」渲染容器。
 *
 * 背景（为什么需要它）：
 *   原实现是 `<main key={location.pathname}><Outlet /></main>` —— key 绑定
 *   pathname，任何页签切换都会让整棵页面树卸载重挂载，页面内所有 useState
 *   （列表滚动位置、当前 Agent、选中资产、二级 tab …）全部丢失，用户切回来
 *   看起来像"自动聚焦回默认视图，进度没了"。
 *
 * 做法：
 *   - 用 `useOutlet()` 拿到当前路由元素，首次访问时按 pathname 存进 Map；
 *   - 所有已打开的页签常驻渲染，非激活帧用 `visibility: hidden` 隐藏
 *     （不用 display:none：隐藏帧会失去布局盒，图谱/虚拟化等读尺寸的组件
 *     在切回瞬间会拿到 0×0，且每次显隐都要整子树 relayout，列表高度会跳）；
 *   - 每个帧是独立的滚动容器（见 tea-override.css 的 `._memory-page-frame`），
 *     所以隐藏/显示天然保留滚动位置；
 *   - 关闭页签（从 `pages` 移除）即丢弃该帧，语义是"关标签 = 重置页面"；
 *   - `/guide`（使用说明）为独立页，不进入缓存，也不占用页签栏。
 *
 * 副作用约束：
 *   页面常驻后，隐藏页里的定时轮询会继续跑（白白消耗请求、还会干扰日志）。
 *   页面内需要用 `usePageActive()` 判断自己是否可见，并据此暂停轮询。
 */
import { createContext, useContext, useRef, type ReactNode } from 'react';
import { useOutlet } from 'react-router-dom';
import { resolveActivePage } from '@/constants/routes';
import type { PageId } from '@/constants/menu';

interface PageFrameContextValue {
  /** 本帧对应的 pathname */
  framePath: string;
  /** 当前激活的 pathname */
  activePath: string;
}

/**
 * 默认 null 而不是「空字符串」：没有 Provider（独立渲染 / 单测 / 未来其他壳层）
 * 时按「激活」处理，避免页面误以为自己在后台而整个不加载数据。
 */
const PageFrameContext = createContext<PageFrameContextValue | null>(null);

/** 当前页面是否处于激活（可见）状态。后台页面应据此暂停轮询类副作用。 */
export function usePageActive(): boolean {
  const ctx = useContext(PageFrameContext);
  if (!ctx) return true;
  return ctx.framePath === ctx.activePath;
}

export interface KeepAlivePagesProps {
  /** 已打开的页签（顺序即渲染顺序） */
  pages: PageId[];
  /** 当前路由 pathname */
  activePath: string;
  /** 是否处于独立页（/guide）—— 独立页不进缓存、不常驻 */
  isGuide?: boolean;
}

export function KeepAlivePages({ pages, activePath, isGuide = false }: KeepAlivePagesProps) {
  const outlet = useOutlet();
  const cacheRef = useRef(new Map<string, ReactNode>());

  // 关闭的页签直接丢帧。放在 render 期做（幂等），避免 effect 里删完不触发重渲染。
  // 用 resolveActivePage 归一化再比对：将来若出现 /wiki/123 这类子路由，
  // 它的 PageId 仍是 wiki，不能因为 pathname 与 PAGE_TO_PATH 不相等就误删。
  const alivePages = new Set(pages);
  for (const key of [...cacheRef.current.keys()]) {
    if (!alivePages.has(resolveActivePage(key))) cacheRef.current.delete(key);
  }

  if (isGuide) {
    return (
      <div className="_memory-frames">
        <main className="_memory-page-frame _memory-page-frame--active" data-frame-active="true">
          <PageFrameContext.Provider value={{ framePath: activePath, activePath }}>
            {outlet}
          </PageFrameContext.Provider>
        </main>
      </div>
    );
  }

  // 首次访问该 path 才写入。`useOutlet()` 每次 render 都返回新的元素对象，
  // 若无条件覆盖，缓存里的元素会被换成"新的" —— 虽然 React 仍按 key 复用
  // 组件实例，但会让"只在首次写入"的语义失效，也更容易在后续重构中误伤。
  if (!cacheRef.current.has(activePath)) {
    cacheRef.current.set(activePath, outlet);
  }

  return (
    <div className="_memory-frames">
      {[...cacheRef.current.entries()].map(([path, element]) => {
        const active = path === activePath;
        return (
          <main
            key={path}
            className={`_memory-page-frame${active ? ' _memory-page-frame--active' : ''}`}
            data-frame-active={active ? 'true' : 'false'}
            // 隐藏帧对辅助技术不可见（visibility:hidden 已移出 tab 焦点顺序，这里补语义）
            aria-hidden={active ? undefined : true}
          >
            <PageFrameContext.Provider value={{ framePath: path, activePath }}>
              {element}
            </PageFrameContext.Provider>
          </main>
        );
      })}
    </div>
  );
}

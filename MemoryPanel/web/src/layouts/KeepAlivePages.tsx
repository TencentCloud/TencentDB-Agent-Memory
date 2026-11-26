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
 *   - 用 `useOutlet()` 拿到当前路由元素，首次访问时按 PageId 存进缓存；
 *   - 渲染顺序直接跟随 `pages`（已打开页签），常驻挂载，非激活帧用
 *     `visibility: hidden` 隐藏 —— 不用 display:none：隐藏帧会失去布局盒，
 *     图谱 / 虚拟化等读尺寸的组件在切回瞬间会拿到 0×0，且每次显隐都要整子树
 *     relayout，列表高度会跳；
 *   - 每个帧是独立滚动容器（见 tea-override.css 的 `._memory-page-frame`），
 *     所以隐藏 / 显示天然保留滚动位置；
 *   - 关闭页签（从 `pages` 移除）即丢弃该帧，语义是"关标签 = 重置页面"；
 *   - `/guide`（使用说明）为独立页：不进入缓存、不占页签栏，但**不销毁**
 *     已有帧 —— 用户看完说明点回任意页签，之前的进度仍在。
 *
 * 副作用约束：
 *   页面常驻后，隐藏页里的定时轮询会继续跑（白白消耗请求、还会干扰观测）。
 *   页面内用 `usePageActive()`（lib/page-active）判断自己是否可见。
 */
import { memo, useRef, type ReactNode } from 'react';
import { useOutlet } from 'react-router-dom';
import { resolveActivePage } from '@/constants/routes';
import type { PageId } from '@/constants/menu';
import { PageFrameActiveContext } from '@/lib/page-active';

export interface KeepAlivePagesProps {
  /** 已打开的页签（顺序即渲染顺序） */
  pages: PageId[];
  /** 当前路由 pathname */
  activePath: string;
  /** 是否处于独立页（/guide）—— 独立页不参与缓存与页签帧 */
  isGuide?: boolean;
}

/**
 * 单帧：memo 包裹，只有自己的 active 变化才重渲染。
 * 帧内是重量级页面（图谱 / 大表格），切页签时不该被父级连带重渲染。
 *
 * 隐藏只用 `visibility: hidden`（CSS class），**不加 aria-hidden**：
 *   - visibility:hidden 已把整棵子树移出无障碍树，无需再补 aria-hidden；
 *   - 实测（Chrome）：给仍持有焦点的子树直接加 aria-hidden 会报
 *     "Blocked aria-hidden on an element because its descendant retained focus"。
 *     React 的 effect 在 DOM 变更之后才跑，事后补 blur 已经来不及 —— 所以
 *     不要写这种"事后守卫"，让浏览器自己处理。
 *   - 实测：visibility:hidden 生效后 activeElement 会自动回到 body，
 *     不需要手写焦点迁移。
 */
const Frame = memo(function Frame({ element, active }: { element: ReactNode; active: boolean }) {
  return (
    <main
      className={`_memory-page-frame${active ? ' _memory-page-frame--active' : ''}`}
      data-frame-active={active ? 'true' : 'false'}
    >
      {/* 值只放布尔：页签切换时若把 pathname 塞进 context，所有常驻页面的
          context 值都会换新引用，隐藏页也跟着重渲染。 */}
      <PageFrameActiveContext.Provider value={active}>{element}</PageFrameActiveContext.Provider>
    </main>
  );
});

export function KeepAlivePages({ pages, activePath, isGuide = false }: KeepAlivePagesProps) {
  const outlet = useOutlet();
  const activePage = resolveActivePage(activePath);

  // 元素缓存：只在首次访问该页时写入。`useOutlet()` 每次 render 都返回新的
  // 元素对象，无条件覆盖虽不影响实例复用，但会让"只在首次写入"的语义失效。
  // 用 ref 而非 state：`pages` / `activePath` 的变化已经驱动了重渲染（正是新增
  // 页签那一刻），这里不需要再额外触发一次，也就不会出现"render 期 setState →
  // 返回 null → 帧被卸载"的抖动。
  const cacheRef = useRef(new Map<PageId, ReactNode>());

  if (!isGuide && outlet != null && !cacheRef.current.has(activePage)) {
    cacheRef.current.set(activePage, outlet);
  }

  // 关闭的页签丢帧（"关标签 = 重置"）。按 PageId 比对：/skills 与 /skills/
  // 是同一个页面，不能因为 pathname 字面不同就当成两帧。
  const livePages = new Set(pages);
  for (const key of [...cacheRef.current.keys()]) {
    if (!livePages.has(key)) cacheRef.current.delete(key);
  }

  // ConsoleLayout 是「先用 effect 把新页 append 进 openPages」，所以新页的首帧
  // pages 里还没有它。这里补一下，避免首帧闪白（下一帧 pages 就到了）。
  const renderOrder: PageId[] =
    !isGuide && activePage && !pages.includes(activePage) ? [...pages, activePage] : pages;

  return (
    <div className="_memory-frames">
      {renderOrder.map((page) => {
        const element = cacheRef.current.get(page);
        if (element == null) return null;
        return (
          <Frame
            key={page}
            element={element}
            // /guide 时把所有页签帧都标为非激活（隐藏但不销毁），回来后恢复
            active={!isGuide && page === activePage}
          />
        );
      })}
      {isGuide && (
        <main className="_memory-page-frame _memory-page-frame--active" data-frame-active="true">
          <PageFrameActiveContext.Provider value={true}>{outlet}</PageFrameActiveContext.Provider>
        </main>
      )}
    </div>
  );
}

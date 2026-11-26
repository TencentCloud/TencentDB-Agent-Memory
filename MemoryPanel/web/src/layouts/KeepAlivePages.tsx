/**
 * KeepAlivePages —— 标签页级页面保活。
 *
 * 背景：ConsoleLayout 过去用 `<main key={pathname}><Outlet /></main>` 渲染页面，
 * 每次切换标签都会整棵卸载重挂载，页面里的滚动位置、二级 tab、选中项、agent 选择等
 * useState 全部归零。这里改为：
 *
 * - 用 `useOutlet()` 取当前路由元素，按 PageId 缓存；已打开标签页的帧常驻挂载。
 *   激活帧每次渲染都用最新的 outlet 元素刷新缓存（类型不变 → React 复用实例、状态保留，
 *   路由上下文也保持最新）；隐藏帧沿用上次的元素引用，配合 memo 跳过重渲染。
 * - 非激活帧：`visibility: hidden` + `pointer-events: none` + `aria-hidden` + DOM `inert`。
 *   不用 display:none —— 隐藏帧保留布局盒，图谱/图表等读尺寸的组件切回时不会拿到 0×0，
 *   也不会触发整子树重新布局导致高度跳变。inert 让隐藏帧里的控件无法被 Tab/脚本聚焦、
 *   不进入页内查找；aria-hidden 作为不支持 inert 的旧浏览器上的无障碍兜底
 *   （visibility:hidden 本身也会把元素移出 Tab 序列）。
 * - 每个帧是自己的滚动容器，各页 scrollTop 天然独立保留，无需手动记录/恢复。
 * - 关闭标签页 → 从缓存丢弃（关闭 = 重置）；重新打开即全新挂载。
 * - `/guide` 激活时：已缓存帧全部保持挂载但隐藏，Guide 单独渲染在一个不缓存的帧里；
 *   从 Guide 返回后原页面进度仍在。
 * - 每个帧通过 PageActiveContext 下发 active，供轮询类 hook 在隐藏时暂停。
 */
import { memo, useLayoutEffect, useRef, type ReactElement, type ReactNode } from 'react';
import { useOutlet } from 'react-router-dom';
import type { PageId } from '@/constants/menu';
import { PageActiveContext } from '@/lib/page-active';
import { frameVisibility, retainedPageIds } from '@/layouts/keepalive-state';

const GUIDE_FRAME_KEY = '__guide__';

interface KeepAliveFrameProps {
  frameKey: string;
  active: boolean;
  element: ReactNode;
}

const KeepAliveFrame = memo(function KeepAliveFrame({ frameKey, active, element }: KeepAliveFrameProps) {
  const ref = useRef<HTMLDivElement>(null);
  const vis = frameVisibility(active);

  // React 18 不识别 inert 属性（布尔值会被告警并丢弃），这里直接写 DOM property。
  useLayoutEffect(() => {
    if (ref.current) ref.current.inert = vis.inert;
  }, [vis.inert]);

  return (
    <div
      ref={ref}
      className={`_memory-keepalive-frame${active ? ' _memory-keepalive-frame--active' : ''}`}
      data-keepalive-page={frameKey}
      aria-hidden={vis['aria-hidden']}
      style={vis.style}
    >
      <PageActiveContext.Provider value={active}>
        <main className="_memory-page-frame">{element}</main>
      </PageActiveContext.Provider>
    </div>
  );
});

export function KeepAlivePages({
  activePage,
  openPages,
  isGuide,
}: {
  activePage: PageId;
  openPages: readonly PageId[];
  isGuide: boolean;
}) {
  const outlet = useOutlet();
  // 缓存写在 ref 上并在渲染期同步裁剪/追加：结果只由 (openPages, activePage, outlet)
  // 决定，重复渲染（StrictMode / 被丢弃的并发渲染）是幂等的。
  const cacheRef = useRef<Map<PageId, ReactElement>>(new Map());
  const cache = cacheRef.current;

  const cachedActive: PageId | null = isGuide ? null : activePage;
  const keep = new Set(retainedPageIds([...cache.keys()], openPages, cachedActive));
  for (const id of [...cache.keys()]) {
    if (!keep.has(id)) cache.delete(id);
  }
  if (cachedActive && outlet) {
    // Map.set 覆盖已有键不改变插入顺序 → 帧的 DOM 顺序稳定
    cache.set(cachedActive, outlet);
  }

  return (
    <div className="_memory-keepalive-host">
      {[...cache.entries()].map(([id, element]) => (
        <KeepAliveFrame key={id} frameKey={id} active={id === cachedActive} element={element} />
      ))}
      {isGuide && outlet && (
        <KeepAliveFrame key={GUIDE_FRAME_KEY} frameKey={GUIDE_FRAME_KEY} active element={outlet} />
      )}
    </div>
  );
}

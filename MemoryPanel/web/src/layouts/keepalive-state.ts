/**
 * 页面保活的纯逻辑（无 React / DOM 依赖，便于在父包 vitest node 环境单测）。
 *
 * KeepAlivePages 只负责把这里算出的结果落到 React 元素与 DOM 属性上。
 */
import type { PageId } from '../constants/menu';

/**
 * 计算本轮渲染应保留的缓存键（保持 `cachedIds` 原有顺序，即首次访问顺序）。
 *
 * - 已打开的标签页 → 保留（切走时常驻、隐藏）；
 * - 当前激活页 → 保留（导航刚发生、ConsoleLayout 还没把它追加进 openPages 的那一帧）；
 * - 其余（标签页已关闭）→ 丢弃：关闭标签 = 重置页面，重开即全新挂载。
 *
 * `/guide` 激活时 activePage 传 null：Guide 不进缓存，但已打开的标签页帧全部保留。
 */
export function retainedPageIds(
  cachedIds: readonly PageId[],
  openPages: readonly PageId[],
  activePage: PageId | null,
): PageId[] {
  const open = new Set(openPages);
  return cachedIds.filter((id) => open.has(id) || id === activePage);
}

/** 帧在 DOM 上的可见性属性（激活帧不带任何隐藏属性）。 */
export interface FrameVisibility {
  /** 非激活帧：从无障碍树中隐藏（inert 不可用的旧浏览器上的兜底） */
  'aria-hidden': true | undefined;
  /** 非激活帧：DOM inert，阻止 Tab / 程序化聚焦、点击与页内查找 */
  inert: boolean;
  style: {
    /** 用 visibility 而非 display:none：隐藏帧仍保留布局盒，切回时不发生尺寸跳变 */
    visibility: 'visible' | 'hidden';
    pointerEvents: 'auto' | 'none';
    zIndex: number;
  };
}

export function frameVisibility(active: boolean): FrameVisibility {
  return {
    'aria-hidden': active ? undefined : true,
    inert: !active,
    style: {
      visibility: active ? 'visible' : 'hidden',
      pointerEvents: active ? 'auto' : 'none',
      zIndex: active ? 1 : 0,
    },
  };
}

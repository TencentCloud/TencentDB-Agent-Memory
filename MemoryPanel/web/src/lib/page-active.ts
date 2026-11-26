/**
 * page-active —— 页面帧可见性上下文。
 *
 * 背景：多标签页保活（`layouts/KeepAlivePages`）让已打开的页签常驻 DOM，
 * 隐藏页里的定时轮询会继续跑。页面内需要知道自己是否在前台，才能暂停这些副作用。
 *
 * 放在 lib/ 而不是 layouts/：消费方是 pages/**\/hooks，若从 layouts 导入会形成
 * 「业务页 → 布局层」的反向依赖；lib 是两边都可依赖的公共层。
 *
 * 值是**布尔**而非对象：页签切换时 activePage 会变，若 context 值是
 * `{ framePage, activePage }` 这类对象，每个帧的值都会换新引用，所有常驻页面
 * （含大量隐藏页）都会跟着重渲染。布尔只在「本帧自己切换显隐」时变，
 * 未受影响的帧完全跳过。
 */
import { createContext, useContext } from 'react';

/**
 * 默认 null：没有 Provider 时（单测、Storybook、未来别的壳层）按「激活」处理，
 * 避免页面误以为自己在后台而整个不加载数据。
 */
export const PageFrameActiveContext = createContext<boolean | null>(null);

/** 当前页面是否处于激活（可见）状态。后台页面应据此暂停轮询类副作用。 */
export function usePageActive(): boolean {
  return useContext(PageFrameActiveContext) ?? true;
}

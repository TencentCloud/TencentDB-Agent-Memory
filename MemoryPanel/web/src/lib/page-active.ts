/**
 * page-active —— 页面保活下的「当前帧是否激活」信号。
 *
 * KeepAlivePages 让已打开的标签页常驻挂载，隐藏页里的定时轮询因此会继续跑。
 * 需要「只在可见时轮询」的 hook 读 `usePageActive()`，在 false 时跳过/暂停定时器。
 *
 * 默认值为 true：不在 KeepAlivePages 下渲染的组件（登录页、弹窗 portal 外层等）
 * 行为与改造前完全一致。
 */
import { createContext, useContext } from 'react';

export const PageActiveContext = createContext<boolean>(true);
PageActiveContext.displayName = 'PageActiveContext';

export function usePageActive(): boolean {
  return useContext(PageActiveContext);
}

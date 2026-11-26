/**
 * atomic-head-keyboard —— L2 原子条目标题行（div[role=button]）的键盘分发规则。
 *
 * 背景（#1708）：L2 标题行本身是可点击展开区（role=button），内部又嵌了真实控件
 * （「更多操作」三点按钮、chevron）。Enter/Space 按下时，若焦点在内部按钮上，
 * keydown 会冒泡到行上；行若照常 preventDefault + 折叠整行，内部按钮的原生
 * 键盘激活就被吞掉（菜单打不开，反而折叠整行）。
 *
 * 规则：行只处理「焦点在它自己身上」时的 Enter/Space。
 *
 * 抽成纯函数是为了能在 node 环境下直接单测，不必引入 jsdom / testing-library。
 * 入参刻意只依赖最小结构 `{ key, target, currentTarget }`，与 React / DOM 解耦。
 */

/** 触发按钮激活的按键（与浏览器原生行为一致：Enter 与 Space）。 */
export function isActivationKey(key: string): boolean {
  return key === 'Enter' || key === ' ';
}

/** keydown 事件里判定「行该不该处理」所需要的最小结构。 */
export interface KeyTargetLike {
  key: string;
  /** 事件实际发起元素（真实 DOM 里是 e.target）。 */
  target: unknown;
  /** 绑定了处理函数的元素（真实 DOM 里是 e.currentTarget）。 */
  currentTarget: unknown;
}

/**
 * L2 标题行（自身 role=button 的容器）是否应响应这次 keydown。
 *
 * - 非 Enter/Space：不处理（返回 false）。
 * - 事件来自内部子元素（e.target !== e.currentTarget）：不处理，把原生键盘
 *   激活让给内部真实控件；这是 #1708 的自身焦点守卫。
 * - 事件由行自身发起：处理（返回 true）。
 */
export function shouldHandleRowKeydown(e: KeyTargetLike): boolean {
  if (!isActivationKey(e.key)) return false;
  return e.target === e.currentTarget;
}

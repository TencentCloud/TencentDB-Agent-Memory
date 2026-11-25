/**
 * 资源开关保存的按 key 在途跟踪。
 *
 * 设置弹窗里的开关（Wiki / Code / Skill / ChatMemory）可以并发保存。此前用一个
 * `savingKey` 记录“正在保存的那一项”，任一请求先返回就把它置空，仍在保存中的其他
 * 开关会提前恢复可操作，用户可以重复提交。
 *
 * 这里把单个 key 换成按 key 独立记录：每个请求只在自身结束时释放，互不影响。
 *
 * 该模块不依赖 React：组件需要 DOM 才能测，而本仓的测试设施跑在 node 环境，
 * 所以把并发相关的逻辑抽出来单独覆盖。
 */

export interface ToggleSaver<K extends string> {
  /**
   * 发起一次保存。
   * 同一 key 已有请求在途时返回 null —— 本次不发起请求，调用方应静默忽略；
   * 否则返回本次请求，成功或失败都会自动释放在途标记。
   */
  toggle(key: K, value: boolean): Promise<unknown> | null;
}

export function createToggleSaver<K extends string>(
  save: (key: K, value: boolean) => Promise<unknown>,
): ToggleSaver<K> {
  const inFlight = new Set<K>();

  return {
    toggle(key, value) {
      if (inFlight.has(key)) return null;

      inFlight.add(key);
      try {
        return save(key, value).finally(() => inFlight.delete(key));
      } catch (e) {
        // save 若同步抛错，.finally 挂不上，这里手动释放，否则该 key 会永久拒绝提交
        inFlight.delete(key);
        return Promise.reject(e);
      }
    },
  };
}

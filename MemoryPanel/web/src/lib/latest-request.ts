/**
 * latest-request —— 「只有最新一次请求才能写状态」的竞态保护（纯逻辑，无 React 依赖）。
 *
 * 用法：每次发起请求前调用 guard.begin() 拿到 ticket；响应回来时仅当
 * ticket.isCurrent() 为 true 才写入状态。再次 begin() 或 cancel()（团队切换 /
 * 组件卸载时调用）都会让之前所有 ticket 失效，过期的成功或失败都被静默丢弃。
 */

export interface RequestTicket {
  /** 该请求是否仍是最新一次、且未被取消 */
  isCurrent(): boolean;
}

export interface LatestRequestGuard {
  /** 开始一次新请求，并使之前的请求全部失效 */
  begin(): RequestTicket;
  /** 使所有进行中的请求失效（切换 / 卸载时调用） */
  cancel(): void;
}

export function createLatestRequestGuard(): LatestRequestGuard {
  let seq = 0;
  return {
    begin() {
      const id = ++seq;
      return { isCurrent: () => id === seq };
    },
    cancel() {
      seq++;
    },
  };
}

export interface LatestRequestHandlers<T> {
  onStart?: () => void;
  onSuccess: (data: T) => void;
  onError: (err: unknown) => void;
  onSettled?: () => void;
}

/**
 * 以 guard 保护执行一次请求：仅当该请求仍是最新时才回调 onSuccess / onError /
 * onSettled；过期请求的结果（包括失败）不会触达任何回调。
 */
export async function runLatestRequest<T>(
  guard: LatestRequestGuard,
  request: () => Promise<T>,
  handlers: LatestRequestHandlers<T>,
): Promise<void> {
  const ticket = guard.begin();
  handlers.onStart?.();
  try {
    const data = await request();
    if (ticket.isCurrent()) handlers.onSuccess(data);
  } catch (err) {
    if (ticket.isCurrent()) handlers.onError(err);
  } finally {
    if (ticket.isCurrent()) handlers.onSettled?.();
  }
}

/** 模板加载中（数据可能仍属于上一个团队）时不可编辑 */
export function canEditTemplate(loading: boolean): boolean {
  return !loading;
}

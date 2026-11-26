/**
 * toggle-save-state — 按开关键独立协调「乐观更新 + 异步保存」的纯逻辑。
 *
 * 不依赖 React / DOM，便于用受控 Promise 单测（见 MemoryPanel/tests/toggle-save-state.test.ts）。
 *
 * 约定：
 * - 每个 key 有独立的在途标记；同一 key 在途时 submit 直接返回 'busy'，不调用 save。
 * - 请求结束（成功 / 失败 / save 同步抛错）只释放自己这个 key 的在途标记与错误提示。
 * - 失败回滚前确认：该请求仍是此 key 最新一次请求，且当前值仍是本次写入的值；
 *   否则视为过期响应，不回滚、不写错误提示。
 */

export type ToggleSaveResult =
  | { status: 'saved' }
  | { status: 'failed'; message: string }
  /** 响应已过期（被更新的操作覆盖），未回滚、未写错误提示。 */
  | { status: 'stale' }
  /** 同一 key 仍在保存中，本次提交被拒绝，未调用 save。 */
  | { status: 'busy' };

export interface ToggleSaveHooks<K extends string> {
  /** 读取 key 的当前值（必须是最新值，React 中用 ref 而不是闭包里的 state）。 */
  getValue(key: K): boolean;
  setValue(key: K, value: boolean): void;
  setSaving(key: K, saving: boolean): void;
  /** message 为 null 表示清除该 key 的失败提示。 */
  setError(key: K, message: string | null): void;
}

export interface ToggleSaver<K extends string> {
  submit(key: K, next: boolean, save: () => Promise<unknown>): Promise<ToggleSaveResult>;
  isSaving(key: K): boolean;
}

function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createToggleSaver<K extends string>(hooks: ToggleSaveHooks<K>): ToggleSaver<K> {
  const inFlight = new Set<K>();
  const latestSeq = new Map<K, number>();
  let seqCounter = 0;

  async function submit(key: K, next: boolean, save: () => Promise<unknown>): Promise<ToggleSaveResult> {
    if (inFlight.has(key)) return { status: 'busy' };

    const seq = ++seqCounter;
    const previous = hooks.getValue(key);
    inFlight.add(key);
    latestSeq.set(key, seq);
    hooks.setValue(key, next);
    hooks.setSaving(key, true);
    hooks.setError(key, null);

    try {
      // await 包在 try 内：save() 同步抛错也会进入 catch / finally。
      await save();
      if (latestSeq.get(key) !== seq) return { status: 'stale' };
      return { status: 'saved' };
    } catch (e) {
      const isCurrent = latestSeq.get(key) === seq && hooks.getValue(key) === next;
      if (!isCurrent) return { status: 'stale' };
      const message = toMessage(e);
      hooks.setValue(key, previous);
      hooks.setError(key, message);
      return { status: 'failed', message };
    } finally {
      if (latestSeq.get(key) === seq) {
        inFlight.delete(key);
        hooks.setSaving(key, false);
      }
    }
  }

  return {
    submit,
    isSaving: (key) => inFlight.has(key),
  };
}

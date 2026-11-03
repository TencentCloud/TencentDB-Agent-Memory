/**
 * 回归测试：issue #1936 — 并发保存资源开关时，单值 savingKey 过早清除
 * 另一开关的保存状态。
 *
 * 覆盖验收标准：
 * 1. 两个并发保存请求各自保持 saving 状态，直到自身请求结束；
 * 2. 任一请求先完成（快慢两种顺序）都不提前解除另一项的保存状态；
 * 3. 同一项保存未完成时不能重复提交；
 * 4. 成功 / 失败都正确恢复对应开关的状态，失败提示仅归属于对应开关；
 * 5. 过期的失败响应不回滚已经更新的操作；
 * 6. 以受控 Promise 复现并防止“提前清除保存状态”回归。
 *
 * 运行：在 MemoryPanel 目录执行 `npm test`（vitest run，node 环境，无真实后端）。
 */
import { describe, expect, it } from 'vitest';
import { AssetToggleSaver } from '../web/src/lib/assetToggleSaver';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason?: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const WIKI = 'llm_wiki.enabled';
const CODE = 'code_graph.enabled';

/**
 * 测试驱动器：与 SettingsDialog.handleToggle 相同的状态流转
 * （begin 防重提 → 乐观更新 → isLatest 防过期回滚 → finish 按项清除保存状态）。
 */
function createHarness() {
  const saver = new AssetToggleSaver();
  const state = {
    enabled: { [WIKI]: true, [CODE]: true } as Record<string, boolean>,
    /** 已实际发起的保存请求（重复提交不会进入此列表），含协调器分配的请求标识 */
    requests: [] as Array<{ key: string; next: boolean; requestId: number }>,
    /** 失败提示归属的开关键 */
    failures: [] as string[],
  };

  /** 返回 true 表示已提交；false 表示保存中被拒绝（禁止重提）。 */
  async function handleToggle(key: string, next: boolean, request: Promise<void>): Promise<boolean> {
    const requestId = saver.begin(key);
    if (requestId === null) return false;
    const previous = state.enabled[key];
    state.enabled[key] = next;
    state.requests.push({ key, next, requestId });
    try {
      await request;
      if (!saver.isLatest(key, requestId)) return true;
    } catch {
      if (!saver.isLatest(key, requestId)) return true; // 过期失败响应不回滚
      state.enabled[key] = previous;
      state.failures.push(key);
    } finally {
      saver.finish(key, requestId);
    }
    return true;
  }

  return { saver, state, handleToggle };
}

describe('资源开关并发保存（issue #1936）', () => {
  it('并发保存各自保持 saving 状态，Wiki 先完成不提前解除 Code 的保存状态', async () => {
    const { saver, handleToggle } = createHarness();
    const dWiki = deferred();
    const dCode = deferred();

    const pWiki = handleToggle(WIKI, false, dWiki.promise);
    const pCode = handleToggle(CODE, false, dCode.promise);

    // 两项并发保存中，各自独立保持 saving 状态
    expect(saver.isSaving(WIKI)).toBe(true);
    expect(saver.isSaving(CODE)).toBe(true);

    // Wiki 先完成：仅 Wiki 解除，Code 仍在保存中（原 bug 此处会把 Code 提前解锁）
    dWiki.resolve();
    await pWiki;
    expect(saver.isSaving(WIKI)).toBe(false);
    expect(saver.isSaving(CODE)).toBe(true);

    dCode.resolve();
    await pCode;
    expect(saver.isSaving(CODE)).toBe(false);
  });

  it('快慢顺序反转：Code 先完成不提前解除 Wiki 的保存状态', async () => {
    const { saver, handleToggle } = createHarness();
    const dWiki = deferred();
    const dCode = deferred();

    const pWiki = handleToggle(WIKI, false, dWiki.promise);
    const pCode = handleToggle(CODE, false, dCode.promise);

    dCode.resolve();
    await pCode;
    expect(saver.isSaving(CODE)).toBe(false);
    expect(saver.isSaving(WIKI)).toBe(true);

    dWiki.resolve();
    await pWiki;
    expect(saver.isSaving(WIKI)).toBe(false);
  });

  it('同一项保存未完成时禁止重复提交', async () => {
    const { saver, state, handleToggle } = createHarness();
    const dFirst = deferred();

    const pFirst = handleToggle(CODE, false, dFirst.promise);
    expect(saver.isSaving(CODE)).toBe(true);

    // 保存中再次提交同一项：被拒绝，不产生新请求、不改变状态
    const submitted = await handleToggle(CODE, true, deferred().promise);
    expect(submitted).toBe(false);
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0]).toMatchObject({ key: CODE, next: false });
    expect(state.enabled[CODE]).toBe(false);
    expect(saver.isSaving(CODE)).toBe(true);

    // 第一次请求结束后才允许再次提交
    dFirst.resolve();
    await pFirst;
    expect(saver.isSaving(CODE)).toBe(false);
    const dSecond = deferred();
    const pSecond = handleToggle(CODE, true, dSecond.promise);
    dSecond.resolve();
    expect(await pSecond).toBe(true);
    expect(state.requests).toHaveLength(2);
    expect(state.enabled[CODE]).toBe(true);
  });

  it('成功 / 失败均正确恢复对应项状态，失败提示仅归属对应开关', async () => {
    const { saver, state, handleToggle } = createHarness();
    const dWiki = deferred();
    const dCode = deferred();

    const pWiki = handleToggle(WIKI, false, dWiki.promise);
    const pCode = handleToggle(CODE, false, dCode.promise);

    // Wiki 成功、Code 失败
    dWiki.resolve();
    dCode.reject(new Error('network'));
    await Promise.all([pWiki, pCode]);

    // 两项都恢复可操作
    expect(saver.isSaving(WIKI)).toBe(false);
    expect(saver.isSaving(CODE)).toBe(false);
    // 成功项保持新值，失败项回滚到原值
    expect(state.enabled[WIKI]).toBe(false);
    expect(state.enabled[CODE]).toBe(true);
    // 失败提示仅归属 Code，不影响 Wiki
    expect(state.failures).toEqual([CODE]);
  });

  it('过期的失败响应不回滚已经更新的操作，也不清除新请求的保存状态', async () => {
    const { saver, state, handleToggle } = createHarness();

    // 第一次保存成功（code: true → false），随后用户再次切换（false → true）
    const dFirst = deferred();
    const pFirst = handleToggle(CODE, false, dFirst.promise);
    dFirst.resolve();
    await pFirst;
    expect(state.enabled[CODE]).toBe(false);

    const dSecond = deferred();
    const pSecond = handleToggle(CODE, true, dSecond.promise);
    expect(state.enabled[CODE]).toBe(true);

    // 构造过期响应场景：第一次请求的标识已非该键最新请求
    const staleRequestId = state.requests[0].requestId; // 第一次 handleToggle 的实际请求标识
    expect(saver.isLatest(CODE, staleRequestId)).toBe(false);
    // 过期失败到达时组件直接 return，不回滚 enabled；finish 也不清除新请求状态
    expect(state.enabled[CODE]).toBe(true);
    expect(saver.finish(CODE, staleRequestId)).toBe(false);
    expect(saver.isSaving(CODE)).toBe(true);

    // 新请求正常结束：状态保留新值、保存状态被正确清除
    dSecond.resolve();
    await pSecond;
    expect(state.enabled[CODE]).toBe(true);
    expect(saver.isSaving(CODE)).toBe(false);
    expect(state.failures).toEqual([]);
  });

  it('失败请求先结束同样不提前解除另一项的保存状态', async () => {
    const { saver, state, handleToggle } = createHarness();
    const dWiki = deferred();
    const dCode = deferred();

    const pWiki = handleToggle(WIKI, false, dWiki.promise);
    const pCode = handleToggle(CODE, false, dCode.promise);

    // Wiki 先失败：只回滚并解锁 Wiki，Code 保持保存中
    dWiki.reject(new Error('network'));
    await pWiki;
    expect(saver.isSaving(WIKI)).toBe(false);
    expect(saver.isSaving(CODE)).toBe(true);
    expect(state.enabled[WIKI]).toBe(true);
    expect(state.enabled[CODE]).toBe(false);
    expect(state.failures).toEqual([WIKI]);

    dCode.resolve();
    await pCode;
    expect(saver.isSaving(CODE)).toBe(false);
    expect(state.enabled[CODE]).toBe(false);
  });
});

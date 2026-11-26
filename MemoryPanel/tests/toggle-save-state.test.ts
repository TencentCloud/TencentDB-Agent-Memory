/**
 * 回归测试 #1936：设置弹窗多个资源开关并发保存时，单个 savingKey 被先完成的请求清空。
 * 用受控 Promise（deferred）控制每个保存请求的完成时机，无需后端与 DOM。
 */
import { describe, expect, it, vi } from 'vitest';
import { createToggleSaver } from '../web/src/lib/toggle-save-state';

type Key = 'llm_wiki.enabled' | 'code_graph.enabled';
const WIKI: Key = 'llm_wiki.enabled';
const CODE: Key = 'code_graph.enabled';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 模拟组件里的三份状态：开关值、保存中集合、按开关的失败提示。 */
function setup(initial: Record<Key, boolean> = { [WIKI]: false, [CODE]: false }) {
  const values: Record<Key, boolean> = { ...initial };
  const saving: Partial<Record<Key, boolean>> = {};
  const errors: Partial<Record<Key, string>> = {};
  const saver = createToggleSaver<Key>({
    getValue: (k) => values[k],
    setValue: (k, v) => { values[k] = v; },
    setSaving: (k, s) => { saving[k] = s; },
    setError: (k, m) => {
      if (m === null) delete errors[k];
      else errors[k] = m;
    },
  });
  return { saver, values, saving, errors };
}

describe('createToggleSaver (#1936)', () => {
  it('两个并发请求各自保持 saving，直到自身请求结束（Wiki 先完成）', async () => {
    const { saver, saving, values } = setup();
    const wiki = deferred();
    const code = deferred();
    const pWiki = saver.submit(WIKI, true, () => wiki.promise);
    const pCode = saver.submit(CODE, true, () => code.promise);
    expect(saving).toEqual({ [WIKI]: true, [CODE]: true });

    wiki.resolve();
    await expect(pWiki).resolves.toEqual({ status: 'saved' });
    expect(saving[WIKI]).toBe(false);
    expect(saving[CODE]).toBe(true); // 旧实现在这里被提前清空
    expect(saver.isSaving(CODE)).toBe(true);

    code.resolve();
    await expect(pCode).resolves.toEqual({ status: 'saved' });
    expect(saving[CODE]).toBe(false);
    expect(values).toEqual({ [WIKI]: true, [CODE]: true });
  });

  it('反转快慢顺序（Code 先完成）同样不会提前解除 Wiki 的保存态', async () => {
    const { saver, saving } = setup();
    const wiki = deferred();
    const code = deferred();
    const pWiki = saver.submit(WIKI, true, () => wiki.promise);
    const pCode = saver.submit(CODE, true, () => code.promise);

    code.resolve();
    await pCode;
    expect(saving[CODE]).toBe(false);
    expect(saving[WIKI]).toBe(true);
    expect(saver.isSaving(WIKI)).toBe(true);

    wiki.resolve();
    await pWiki;
    expect(saving[WIKI]).toBe(false);
  });

  it('同一项保存未完成时拒绝重复提交，且不发出第二个请求', async () => {
    const { saver, values } = setup();
    const first = deferred();
    const save = vi.fn(() => first.promise);
    const p1 = saver.submit(WIKI, true, save);

    const secondSave = vi.fn(() => Promise.resolve());
    await expect(saver.submit(WIKI, false, secondSave)).resolves.toEqual({ status: 'busy' });
    expect(secondSave).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(1);
    expect(values[WIKI]).toBe(true);

    first.resolve();
    await p1;
    // 结束后可以再次提交
    await expect(saver.submit(WIKI, false, secondSave)).resolves.toEqual({ status: 'saved' });
    expect(secondSave).toHaveBeenCalledTimes(1);
  });

  it('失败只回滚并标记对应开关，另一项的成功不清除该失败提示', async () => {
    const { saver, values, saving, errors } = setup();
    const wiki = deferred();
    const code = deferred();
    const pWiki = saver.submit(WIKI, true, () => wiki.promise);
    const pCode = saver.submit(CODE, true, () => code.promise);

    wiki.reject(new Error('forbidden'));
    await expect(pWiki).resolves.toEqual({ status: 'failed', message: 'forbidden' });
    expect(values[WIKI]).toBe(false);
    expect(saving[WIKI]).toBe(false);
    expect(errors).toEqual({ [WIKI]: 'forbidden' });
    expect(saving[CODE]).toBe(true);
    expect(values[CODE]).toBe(true);

    code.resolve();
    await expect(pCode).resolves.toEqual({ status: 'saved' });
    expect(errors).toEqual({ [WIKI]: 'forbidden' });
    expect(saving[CODE]).toBe(false);

    // 对应开关重试成功后，只清除它自己的失败提示
    await saver.submit(WIKI, true, () => Promise.resolve());
    expect(errors).toEqual({});
    expect(values[WIKI]).toBe(true);
  });

  it('过期的失败响应不回滚已更新的值', async () => {
    const { saver, values, errors, saving } = setup();
    const wiki = deferred();
    const pWiki = saver.submit(WIKI, true, () => wiki.promise);
    // 请求在途期间该项被更新的操作覆盖（如配置重新加载写入了新值）
    values[WIKI] = false;

    wiki.reject(new Error('timeout'));
    await expect(pWiki).resolves.toEqual({ status: 'stale' });
    expect(values[WIKI]).toBe(false);
    expect(errors[WIKI]).toBeUndefined();
    expect(saving[WIKI]).toBe(false);
    expect(saver.isSaving(WIKI)).toBe(false);
  });

  it('当前值仍是本次写入的值时，失败才回滚到提交前的值', async () => {
    const { saver, values } = setup({ [WIKI]: true, [CODE]: true });
    await expect(
      saver.submit(WIKI, false, () => Promise.reject(new Error('boom'))),
    ).resolves.toEqual({ status: 'failed', message: 'boom' });
    expect(values[WIKI]).toBe(true);
  });

  it('保存函数同步抛错也会释放在途标记，不会锁死该开关', async () => {
    const { saver, values, saving, errors } = setup();
    const result = await saver.submit(WIKI, true, () => {
      throw new Error('sync');
    });
    expect(result).toEqual({ status: 'failed', message: 'sync' });
    expect(saver.isSaving(WIKI)).toBe(false);
    expect(saving[WIKI]).toBe(false);
    expect(values[WIKI]).toBe(false);
    expect(errors[WIKI]).toBe('sync');

    await expect(saver.submit(WIKI, true, () => Promise.resolve())).resolves.toEqual({ status: 'saved' });
  });

  it('非 Error 拒绝值也转成字符串提示', async () => {
    const { saver, errors } = setup();
    await saver.submit(CODE, true, () => Promise.reject('nope'));
    expect(errors[CODE]).toBe('nope');
  });
});

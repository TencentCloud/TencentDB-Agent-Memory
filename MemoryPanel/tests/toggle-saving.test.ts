/**
 * 开关并发保存的回归测试（issue #1936）。
 *
 * 组件需要 DOM 才能渲染，而本仓的测试设施运行在 node 环境，因此这里覆盖的是
 * 组件依赖的并发契约：按 key 独立的在途记录、重复提交被拒绝、请求结束后释放。
 *
 * 运行：cd MemoryPanel && npm test
 */
import { describe, expect, it } from 'vitest';
import { createToggleSaver } from '../web/src/lib/toggleSaving';

type Key = 'llm_wiki.enabled' | 'code_graph.enabled';

/** 手动控制完成时机的 Promise，用来模拟快慢不同的保存请求 */
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res();
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createToggleSaver', () => {
  it('Wiki 先保存完成不会释放仍在保存中的 Code', async () => {
    const wiki = deferred();
    const code = deferred();
    const saver = createToggleSaver<Key>((key) =>
      key === 'llm_wiki.enabled' ? wiki.promise : code.promise,
    );

    const wikiTask = saver.toggle('llm_wiki.enabled', false);
    const codeTask = saver.toggle('code_graph.enabled', true);

    wiki.resolve();
    await wikiTask;

    // 关键断言：Wiki 结束只释放自己，Code 仍在途，重复提交会被拒绝
    expect(saver.toggle('code_graph.enabled', false)).toBeNull();
    // Wiki 已释放，可以再次提交
    expect(saver.toggle('llm_wiki.enabled', true)).not.toBeNull();

    code.resolve();
    await codeTask;
  });

  it('反向顺序（Code 先完成）同样不会释放 Wiki', async () => {
    const wiki = deferred();
    const code = deferred();
    const saver = createToggleSaver<Key>((key) =>
      key === 'llm_wiki.enabled' ? wiki.promise : code.promise,
    );

    const wikiTask = saver.toggle('llm_wiki.enabled', true);
    const codeTask = saver.toggle('code_graph.enabled', false);

    code.resolve();
    await codeTask;

    expect(saver.toggle('llm_wiki.enabled', false)).toBeNull();

    wiki.resolve();
    await wikiTask;
    expect(saver.toggle('llm_wiki.enabled', false)).not.toBeNull();
  });

  it('同一项在途时拒绝重复提交，不发起第二个请求', async () => {
    const task = deferred();
    const calls: boolean[] = [];
    const saver = createToggleSaver<Key>((_key, value) => {
      calls.push(value);
      return task.promise;
    });

    const first = saver.toggle('llm_wiki.enabled', false);
    expect(first).not.toBeNull();
    // 保存未完成时再次切换（例如双击）应被拒绝
    expect(saver.toggle('llm_wiki.enabled', true)).toBeNull();
    expect(calls).toEqual([false]);

    task.resolve();
    await first;
    // 结束后释放，可以再次提交
    expect(saver.toggle('llm_wiki.enabled', true)).not.toBeNull();
  });

  it('保存函数同步抛错时不锁死该项，而是返回一个失败的 Promise', async () => {
    let calls = 0;
    const saver = createToggleSaver<Key>(() => {
      calls += 1;
      if (calls === 1) throw new Error('同步失败');
      return Promise.resolve();
    });

    const first = saver.toggle('llm_wiki.enabled', false);
    expect(first).not.toBeNull();
    await expect(first).rejects.toThrow('同步失败');

    // 同步异常同样要释放在途标记，否则这一项会永久拒绝提交
    expect(saver.toggle('llm_wiki.enabled', true)).not.toBeNull();
  });

  it('失败抛给调用方，但该项的在途标记会被释放，可以重试', async () => {
    const first = deferred();
    const second = deferred();
    let calls = 0;
    const saver = createToggleSaver<Key>(() => (calls++ === 0 ? first.promise : second.promise));

    const task = saver.toggle('llm_wiki.enabled', false);
    const failed = expect(task).rejects.toThrow('保存失败');
    const error = new Error('保存失败');
    first.reject(error);
    await failed;

    const retry = saver.toggle('llm_wiki.enabled', true);
    expect(retry).not.toBeNull();
    expect(calls).toBe(2);

    second.resolve();
    await retry;
  });

  it('一项失败不影响另一项的保存中状态', async () => {
    const wiki = deferred();
    const code = deferred();
    const saver = createToggleSaver<Key>((key) =>
      key === 'llm_wiki.enabled' ? wiki.promise : code.promise,
    );

    const wikiTask = saver.toggle('llm_wiki.enabled', false);
    const codeTask = saver.toggle('code_graph.enabled', true);

    const failed = expect(wikiTask).rejects.toThrow('保存失败');
    wiki.reject(new Error('保存失败'));
    await failed;

    // Code 不受 Wiki 失败影响，仍处于保存中
    expect(saver.toggle('code_graph.enabled', false)).toBeNull();

    code.resolve();
    await codeTask;
  });

  it('把 key 与目标值原样透传给保存函数', async () => {
    const calls: Array<[Key, boolean]> = [];
    const saver = createToggleSaver<Key>((key, value) => {
      calls.push([key, value]);
      return Promise.resolve();
    });

    await saver.toggle('code_graph.enabled', false);
    expect(calls).toEqual([['code_graph.enabled', false]]);
  });

  it('验收 #5：旧响应不可能回滚新状态（同项在途时不会产生第二个请求）', async () => {
    const first = deferred();
    const second = deferred();
    let calls = 0;
    const saver = createToggleSaver<Key>(() => (calls++ === 0 ? first.promise : second.promise));

    // 第一次点击：请求在途
    const t1 = saver.toggle('llm_wiki.enabled', false);
    expect(t1).not.toBeNull();
    expect(calls).toBe(1);

    // 在途期间再次点击：被拒绝，不会出现第二个响应
    expect(saver.toggle('llm_wiki.enabled', true)).toBeNull();
    expect(calls).toBe(1);

    // 第一次失败并释放后，才可能发起重试
    const failed = expect(t1).rejects.toThrow('保存失败');
    first.reject(new Error('保存失败'));
    await failed;

    const t2 = saver.toggle('llm_wiki.enabled', true);
    expect(t2).not.toBeNull();
    expect(calls).toBe(2);

    // 重试期间旧请求早已 settle，不存在「旧结果回滚新状态」的时序
    second.resolve();
    await t2;
    expect(saver.toggle('llm_wiki.enabled', false)).not.toBeNull();
  });
});

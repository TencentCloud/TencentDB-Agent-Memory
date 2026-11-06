/**
 * CodeGraph 轮询生命周期（issue #1937）：失败终态停止轮询、错误卡片保留、
 * 已进入团队列表的终态让位给列表、手动同步恢复轮询。
 *
 * 运行：cd MemoryPanel && npm test
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeGraphDetail } from '../web/src/lib/api/knowledge-api';
import {
  applyPollOutcome,
  createPoller,
  isTerminalFailure,
  mergeTrackedSources,
  pollableItems,
  pollOnce,
  reconcileTracked,
} from '../web/src/lib/codeGraphPolling';

/** 构造一条完整的 CodeGraphDetail，未指定的字段取默认值。 */
function graph(
  overrides: Partial<CodeGraphDetail> & { code_graph_id: string },
): CodeGraphDetail {
  return {
    team_id: 'team-1',
    repo_name: 'repo',
    repo_url: 'https://example.com/repo.git',
    branch: 'main',
    commit_hash: null,
    service_url: null,
    summary: null,
    status: 'pending',
    sync_error: null,
    version: '1',
    owner_user_id: null,
    stats: null,
    last_sync_at: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

describe('isTerminalFailure', () => {
  it('failed / missing 是失败终态', () => {
    expect(isTerminalFailure('failed')).toBe(true);
    expect(isTerminalFailure('missing')).toBe(true);
  });

  it('pending / processing / ready 不是失败终态', () => {
    expect(isTerminalFailure('pending')).toBe(false);
    expect(isTerminalFailure('processing')).toBe(false);
    expect(isTerminalFailure('ready')).toBe(false);
  });
});

describe('pollableItems', () => {
  it('排除失败终态，保留进行中的图', () => {
    const items = [
      graph({ code_graph_id: 'a', status: 'pending' }),
      graph({ code_graph_id: 'b', status: 'failed' }),
      graph({ code_graph_id: 'c', status: 'processing' }),
      graph({ code_graph_id: 'd', status: 'missing' }),
    ];
    expect(pollableItems(items).map((x) => x.code_graph_id)).toEqual(['a', 'c']);
  });

  it('没有 id 的条目不参与轮询', () => {
    const items = [graph({ code_graph_id: '', status: 'pending' })];
    expect(pollableItems(items)).toEqual([]);
  });

  it('全部是失败终态时返回空，调用方据此停掉定时器', () => {
    const items = [
      graph({ code_graph_id: 'a', status: 'failed' }),
      graph({ code_graph_id: 'b', status: 'missing' }),
    ];
    expect(pollableItems(items)).toEqual([]);
  });
});

describe('mergeTrackedSources', () => {
  it('没有跟踪条目时原样返回列表（引用不变）', () => {
    const sources = [graph({ code_graph_id: 'a' })];
    expect(mergeTrackedSources(sources, [])).toBe(sources);
  });

  it('新建失败、尚未进入列表的图作为 extras 排在最前', () => {
    const sources = [graph({ code_graph_id: 'a', status: 'ready' })];
    const tracked = [
      graph({ code_graph_id: 'b', status: 'failed', sync_error: 'clone 失败' }),
    ];
    const merged = mergeTrackedSources(sources, tracked);
    expect(merged.map((x) => x.code_graph_id)).toEqual(['b', 'a']);
    expect(merged[0].sync_error).toBe('clone 失败');
  });

  it('同 id 时以跟踪状态为准（进行中的图需要实时状态）', () => {
    const sources = [graph({ code_graph_id: 'a', status: 'pending' })];
    const tracked = [graph({ code_graph_id: 'a', status: 'processing' })];
    expect(mergeTrackedSources(sources, tracked)[0].status).toBe('processing');
  });
});

describe('reconcileTracked', () => {
  it('列表确认 ready 时让位（后端已恢复）', () => {
    const tracked = [graph({ code_graph_id: 'a', status: 'failed' })];
    const sources = [graph({ code_graph_id: 'a', status: 'ready' })];
    expect(reconcileTracked(tracked, sources)).toEqual([]);
  });

  it('列表仍是 failed 时保留本地快照（多一份 sync_error）', () => {
    const tracked = [graph({ code_graph_id: 'a', status: 'failed', sync_error: '原因' })];
    const sources = [graph({ code_graph_id: 'a', status: 'failed', sync_error: null })];
    expect(reconcileTracked(tracked, sources)).toHaveLength(1);
  });

  it('列表降级为 missing（KS 不可用）时保留本地快照', () => {
    const tracked = [graph({ code_graph_id: 'a', status: 'failed', sync_error: '原因' })];
    const sources = [graph({ code_graph_id: 'a', status: 'missing', sync_error: null })];
    expect(reconcileTracked(tracked, sources)).toHaveLength(1);
  });

  it('列表为 processing（他人刚重试）时保留本地快照', () => {
    const tracked = [graph({ code_graph_id: 'a', status: 'failed' })];
    const sources = [graph({ code_graph_id: 'a', status: 'processing' })];
    expect(reconcileTracked(tracked, sources)).toHaveLength(1);
  });

  it('失败终态还没有进入列表时保留（错误卡片要展示）', () => {
    const tracked = [graph({ code_graph_id: 'a', status: 'failed' })];
    const sources = [graph({ code_graph_id: 'b', status: 'ready' })];
    expect(reconcileTracked(tracked, sources).map((x) => x.code_graph_id)).toEqual(['a']);
  });

  it('进行中的图即使已在列表里也保留（覆盖语义不能丢）', () => {
    const tracked = [graph({ code_graph_id: 'a', status: 'processing' })];
    const sources = [graph({ code_graph_id: 'a', status: 'pending' })];
    expect(reconcileTracked(tracked, sources)).toHaveLength(1);
  });

  it('让位给列表后，卡片仍然由列表提供（不会消失）', () => {
    const tracked = [graph({ code_graph_id: 'a', status: 'failed', sync_error: '旧快照' })];
    const sources = [graph({ code_graph_id: 'a', status: 'ready' })];

    const display = mergeTrackedSources(sources, reconcileTracked(tracked, sources));

    expect(display.map((x) => x.code_graph_id)).toContain('a');
    expect(display[0].status).toBe('ready');
  });

  it('没有可移除项时返回原引用，避免多余渲染', () => {
    const tracked = [graph({ code_graph_id: 'a', status: 'processing' })];
    const sources = [graph({ code_graph_id: 'b', status: 'ready' })];
    expect(reconcileTracked(tracked, sources)).toBe(tracked);
  });
});

describe('applyPollOutcome', () => {
  it('把状态变化合并回跟踪列表', () => {
    const item = graph({ code_graph_id: 'a', status: 'processing' });
    const detail = graph({ code_graph_id: 'a', status: 'failed', sync_error: 'clone 失败' });
    const next = applyPollOutcome([item], { remove: [], updates: [{ item, detail }] });
    expect(next[0].status).toBe('failed');
    expect(next[0].sync_error).toBe('clone 失败');
  });

  it('ready 的条目从跟踪列表移除', () => {
    const item = graph({ code_graph_id: 'a', status: 'processing' });
    expect(applyPollOutcome([item], { remove: [item], updates: [] })).toEqual([]);
  });

  it('请求在飞时用户点了同步（同 id 已换成新对象），旧结果不覆盖新状态', () => {
    const staleItem = graph({ code_graph_id: 'a', status: 'processing' });
    const syncing = graph({ code_graph_id: 'a', status: 'processing' });
    const staleDetail = graph({ code_graph_id: 'a', status: 'failed' });

    const tracked = [syncing];
    const next = applyPollOutcome(tracked, {
      remove: [],
      updates: [{ item: staleItem, detail: staleDetail }],
    });
    // 对象身份已变，说明这是上一轮的结果，必须丢弃
    expect(next).toBe(tracked);
    expect(next[0].status).toBe('processing');
  });

  it('请求在飞时条目被删除，旧结果不会把它加回来', () => {
    const staleItem = graph({ code_graph_id: 'a', status: 'processing' });
    const staleDetail = graph({ code_graph_id: 'a', status: 'failed' });
    const other = graph({ code_graph_id: 'b', status: 'pending' });

    const tracked = [other];
    expect(
      applyPollOutcome(tracked, { remove: [staleItem], updates: [{ item: staleItem, detail: staleDetail }] }),
    ).toBe(tracked);
  });

  it('没有实际变化时返回原引用，避免多余渲染', () => {
    const item = graph({ code_graph_id: 'a', status: 'processing' });
    const tracked = [item];
    expect(applyPollOutcome(tracked, { remove: [], updates: [] })).toBe(tracked);
  });
});

describe('pollOnce（假 API）', () => {
  it('返回 failed：只更新状态、不移除；下一轮不再被轮询', async () => {
    const item = graph({ code_graph_id: 'a', status: 'processing' });
    const detail = graph({ code_graph_id: 'a', status: 'failed', sync_error: 'clone 失败' });
    const get = vi.fn(async () => detail);
    const onReady = vi.fn();

    const outcome = await pollOnce([item], { get, onReady });

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('a');
    expect(onReady).not.toHaveBeenCalled();
    expect(outcome.remove).toEqual([]);

    const tracked = applyPollOutcome([item], outcome);
    expect(tracked[0].status).toBe('failed');
    expect(tracked[0].sync_error).toBe('clone 失败');
    // 这就是「停止轮询」的判据：没有可轮询条目
    expect(pollableItems(tracked)).toEqual([]);
  });

  it('返回 ready：调用登记回调并移出跟踪列表', async () => {
    const item = graph({ code_graph_id: 'a', status: 'processing' });
    const detail = graph({ code_graph_id: 'a', status: 'ready' });
    const get = vi.fn(async () => detail);
    const onReady = vi.fn();

    const outcome = await pollOnce([item], { get, onReady });

    expect(onReady).toHaveBeenCalledWith(detail);
    expect(outcome.remove).toEqual([item]);
    expect(applyPollOutcome([item], outcome)).toEqual([]);
  });

  it('pending → processing：只更新状态，仍然可轮询', async () => {
    const item = graph({ code_graph_id: 'a', status: 'pending' });
    const detail = graph({ code_graph_id: 'a', status: 'processing' });

    const outcome = await pollOnce([item], { get: async () => detail, onReady: vi.fn() });
    const tracked = applyPollOutcome([item], outcome);

    expect(tracked[0].status).toBe('processing');
    expect(pollableItems(tracked)).toHaveLength(1);
  });

  it('单条请求抛错不影响同轮其它条目', async () => {
    const a = graph({ code_graph_id: 'a', status: 'processing' });
    const b = graph({ code_graph_id: 'b', status: 'pending' });
    const get = vi.fn(async (id: string) => {
      if (id === 'a') throw new Error('network');
      return graph({ code_graph_id: 'b', status: 'processing' });
    });

    const outcome = await pollOnce([a, b], { get, onReady: vi.fn() });
    expect(outcome.updates.map((u) => u.item.code_graph_id)).toEqual(['b']);
  });

  it('ready 时登记动作抛错，仍然移出轮询集合（与基线一致）', async () => {
    const item = graph({ code_graph_id: 'a', status: 'processing' });
    const detail = graph({ code_graph_id: 'a', status: 'ready' });
    const onReady = vi.fn(async () => {
      throw new Error('registerMeta failed');
    });

    const outcome = await pollOnce([item], { get: async () => detail, onReady });

    expect(outcome.remove).toEqual([item]);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(pollableItems(applyPollOutcome([item], outcome))).toEqual([]);
  });

  it('状态没有变化时不产生更新（避免无意义重渲染）', async () => {
    const item = graph({ code_graph_id: 'a', status: 'processing' });
    const outcome = await pollOnce([item], {
      get: async () => graph({ code_graph_id: 'a', status: 'processing' }),
      onReady: vi.fn(),
    });
    expect(outcome.updates).toEqual([]);
    expect(outcome.remove).toEqual([]);
  });

  it('失败后手动同步（状态改回 processing），重新进入轮询集合', () => {
    const failed = [graph({ code_graph_id: 'a', status: 'failed' })];
    expect(pollableItems(failed)).toEqual([]);

    // handleSync 的等价操作：同 id 换成新的 processing 对象
    const syncing = [graph({ code_graph_id: 'a', status: 'processing' })];
    expect(pollableItems(syncing)).toHaveLength(1);
  });
});

describe('轮询生命周期（假定时器 + 假 API）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('失败终态之后不再发起请求', async () => {
    const item = graph({ code_graph_id: 'a', status: 'processing' });
    const get = vi.fn(async () =>
      graph({ code_graph_id: 'a', status: 'failed', sync_error: 'clone 失败' }),
    );
    let tracked = [item];

    // 复刻 hook 的接线：定时器每 tick 只轮询 pollableItems 里的条目
    const poller = createPoller({
      intervalMs: 8000,
      run: async () => {
        const pollable = pollableItems(tracked);
        if (pollable.length === 0) return; // hook 里对应 hasPollable=false，定时器已停
        const outcome = await pollOnce(pollable, { get, onReady: vi.fn() });
        tracked = applyPollOutcome(tracked, outcome);
      },
    });
    poller.start();

    // 跑 3 个周期（24 秒）
    await vi.advanceTimersByTimeAsync(24000);

    expect(get).toHaveBeenCalledTimes(1); // 失败后没有再问
    expect(pollableItems(tracked)).toEqual([]); // 失败条目已不在轮询集合
    expect(tracked[0].sync_error).toBe('clone 失败'); // 但仍在跟踪列表里，供展示

    poller.stop();
  });

  it('混合场景：终态不再被请求，进行中的继续', async () => {
    const failed = graph({ code_graph_id: 'bad', status: 'failed' });
    const busy = graph({ code_graph_id: 'busy', status: 'processing' });
    const get = vi.fn(async (_id: string) =>
      graph({ code_graph_id: 'busy', status: 'processing' }),
    );
    let tracked = [failed, busy];

    const poller = createPoller({
      intervalMs: 8000,
      run: async () => {
        const pollable = pollableItems(tracked);
        if (pollable.length === 0) return;
        tracked = applyPollOutcome(tracked, await pollOnce(pollable, { get, onReady: vi.fn() }));
      },
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(24000);

    expect(get).toHaveBeenCalledTimes(4); // 立即 1 次 + 3 个周期
    expect(get.mock.calls.every((call) => call[0] === 'busy')).toBe(true);

    poller.stop();
  });

  it('失败后手动同步（processing）可恢复轮询', async () => {
    const failed = graph({ code_graph_id: 'a', status: 'failed' });
    let tracked = [failed];
    const get = vi.fn(async () => graph({ code_graph_id: 'a', status: 'processing' }));

    // handleSync 的等价操作
    tracked = [{ ...failed, status: 'processing' }];

    const poller = createPoller({
      intervalMs: 8000,
      run: async () => {
        const pollable = pollableItems(tracked);
        if (pollable.length === 0) return;
        tracked = applyPollOutcome(tracked, await pollOnce(pollable, { get, onReady: vi.fn() }));
      },
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(8000);

    expect(get.mock.calls.length).toBeGreaterThanOrEqual(2); // 启动一次 + 8 秒一次
    poller.stop();
  });
});

describe('createPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('启动时立即执行一次，之后按间隔重复', async () => {
    const run = vi.fn();
    const poller = createPoller({ intervalMs: 8000, run });

    poller.start();
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(8000);
    expect(run).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(8000);
    expect(run).toHaveBeenCalledTimes(3);

    poller.stop();
  });

  it('stop 之后不再执行', async () => {
    const run = vi.fn();
    const poller = createPoller({ intervalMs: 8000, run });

    poller.start();
    await vi.advanceTimersByTimeAsync(8000);
    expect(run).toHaveBeenCalledTimes(2);

    poller.stop();
    await vi.advanceTimersByTimeAsync(24000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('上一轮未结束时仍按节奏继续（请求挂死也不会让轮询停摆）', async () => {
    // 请求层没有超时，互斥一旦被挂死的请求占住，轮询会静默永久停止。
    // 这里固定「不互斥」的行为：与基线的 setInterval 一致。
    const run = vi.fn(() => new Promise<void>(() => {}));
    const poller = createPoller({ intervalMs: 8000, run });

    poller.start();
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(16000);
    expect(run).toHaveBeenCalledTimes(3);

    poller.stop();
  });

  it('stop 之后可以重新 start（没有残留状态）', async () => {
    const run = vi.fn();
    const poller = createPoller({ intervalMs: 8000, run });

    poller.start();
    poller.stop();
    poller.start();
    expect(run).toHaveBeenCalledTimes(2); // 每次 start 立即跑一次

    await vi.advanceTimersByTimeAsync(8000);
    expect(run).toHaveBeenCalledTimes(3); // 旧定时器已被清掉，只有一份在跑

    poller.stop();
  });
});

describe('状态迁移', () => {
  it('失败后停止轮询，手动同步置为 processing 后恢复', () => {
    const failed = [graph({ code_graph_id: 'a', status: 'failed' })];
    expect(pollableItems(failed)).toEqual([]);

    // handleSync 的等价操作：同 id 覆盖为 processing
    const syncing = [{ ...failed[0], status: 'processing' as const }];
    expect(pollableItems(syncing).map((x) => x.code_graph_id)).toEqual(['a']);
  });
});

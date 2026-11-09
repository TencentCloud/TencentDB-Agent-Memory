/**
 * CodeGraph 轮询与展示合并的纯逻辑（issue #1937）。
 *
 * useCodeSources 用 inFlight 跟踪「刚创建 / 刚点过同步」的图，它同时承担两件事：
 * 驱动 8 秒轮询，以及给还没进团队列表的图做展示兜底。以前失败终态（failed /
 * missing）永远留在列表里，于是每 8 秒继续请求一个不会再变的图。
 *
 * 这里不新增第二个集合：展示仍然只用 inFlight，是否轮询由条目自身的 status
 * 派生。两件事只有一份数据，不存在两个状态之间的同步问题。
 */
import type { CodeGraphDetail } from '@/lib/api/knowledge-api';

/** 失败终态：不会再自己变回进行中，继续轮询没有意义。 */
export function isTerminalFailure(status: CodeGraphDetail['status']): boolean {
  return status === 'failed' || status === 'missing';
}

/** 还需要轮询的条目：有 id 且不是失败终态。 */
export function pollableItems(items: CodeGraphDetail[]): CodeGraphDetail[] {
  return items.filter((item) => item.code_graph_id && !isTerminalFailure(item.status));
}

/**
 * 跟踪中的图合并进团队列表：同 id 以跟踪状态为准（进行中的图需要实时状态），
 * 列表里还没有的（刚创建、meta 尚未登记）排在最前占位。
 */
export function mergeTrackedSources(
  sources: CodeGraphDetail[],
  tracked: CodeGraphDetail[],
): CodeGraphDetail[] {
  if (tracked.length === 0) return sources;
  const trackedMap = new Map(tracked.map((x) => [x.code_graph_id, x]));
  const sourceIds = new Set(sources.map((s) => s.code_graph_id));
  const extras = tracked.filter((x) => x.code_graph_id && !sourceIds.has(x.code_graph_id));
  return [...extras, ...sources.map((s) => trackedMap.get(s.code_graph_id) ?? s)];
}

/**
 * 只有当团队列表确认该图已经 `ready` 时，才让本地失败快照退出。
 *
 * `ready` 意味着后端已恢复，列表比本地快照更新；其余情况都保留本地条目：
 * - 列表 `failed`：和本地一致，保留还能拿到轮询时捕获的 `sync_error`；
 * - 列表 `missing`：可能是 KS 短暂不可用时列表的降级结果（`joinCodeKs` 的
 *   catch 会返回 missing 且没有 sync_error），直接让位会让错误原因消失；
 * - 列表 `processing`：说明有人刚触发重试，本地失败快照更可信。
 */
export function reconcileTracked(
  tracked: CodeGraphDetail[],
  sources: CodeGraphDetail[],
): CodeGraphDetail[] {
  if (tracked.length === 0) return tracked;
  const readyIds = new Set(
    sources.filter((s) => s.status === 'ready').map((s) => s.code_graph_id),
  );
  const next = tracked.filter(
    (x) => !isTerminalFailure(x.status) || !readyIds.has(x.code_graph_id),
  );
  // 没有变化时返回原引用，避免无意义的 setInFlight 触发重渲染
  return next.length === tracked.length ? tracked : next;
}

export interface PollOutcome {
  /** 本轮拿到 ready、需要移出跟踪列表的条目。 */
  remove: CodeGraphDetail[];
  /** 状态有变化的条目：请求前读到的对象 → 最新详情。 */
  updates: Array<{ item: CodeGraphDetail; detail: CodeGraphDetail }>;
}

/**
 * 把一轮轮询结果合并进跟踪列表。
 *
 * 按**对象身份**而不是 id 匹配：请求在飞的时候，用户可能刚点了「同步」（同 id
 * 已被替换成新的 processing 对象）或删除了这一项。这时旧请求的结果不能落地，
 * 否则会把刚发起的重试覆盖回 failed，轮询也就停了。
 */
export function applyPollOutcome(
  tracked: CodeGraphDetail[],
  outcome: PollOutcome,
): CodeGraphDetail[] {
  const { remove, updates } = outcome;
  if (remove.length === 0 && updates.length === 0) return tracked;

  const removeSet = new Set(remove);
  const updMap = new Map(updates.map((u) => [u.item, u.detail]));
  const next = tracked
    .filter((x) => !removeSet.has(x))
    .map((x) => updMap.get(x) ?? x);

  // 没有任何实际变化时返回原引用，避免无意义的 setInFlight 触发重渲染
  if (next.length === tracked.length && next.every((x, i) => x === tracked[i])) {
    return tracked;
  }
  return next;
}

export interface PollDeps {
  /** 查询单张图的详情（真实实现是 knowledgeApi.code.get）。 */
  get: (codeGraphId: string) => Promise<CodeGraphDetail>;
  /** 到达 ready 时的登记动作（真实实现是 registerMeta + 刷新列表）。 */
  onReady: (detail: CodeGraphDetail) => Promise<void> | void;
}

/**
 * 跑一轮轮询，返回要如何合并进跟踪列表。
 *
 * 只负责「取状态 → 分类」，不改任何状态；调用方用 applyPollOutcome 合并。
 * 单条请求失败会被吞掉，不影响同轮其它条目（与基线行为一致）。
 */
export async function pollOnce(
  items: CodeGraphDetail[],
  deps: PollDeps,
): Promise<PollOutcome> {
  const outcome: PollOutcome = { remove: [], updates: [] };

  for (const item of items) {
    try {
      const detail = await deps.get(item.code_graph_id);
      if (detail.status === 'ready') {
        // 先记录移除，再执行登记动作：登记失败也不能让已 ready 的图继续被轮询
        // （基线的 registerMeta 失败同样会移除条目）
        outcome.remove.push(item);
        try {
          await deps.onReady(detail);
        } catch {
          /* 登记动作失败不影响「已 ready 就移出轮询」 */
        }
      } else if (detail.status !== item.status) {
        outcome.updates.push({ item, detail });
      }
    } catch {
      /* ignore transient poll errors */
    }
  }

  return outcome;
}

/**
 * 定时轮询：启动时立即执行一次，之后按 intervalMs 重复。
 *
 * 不在这里做「上一轮没结束就跳过」的互斥：请求层没有超时（base.ts 用的是裸
 * fetch），一旦某次请求挂死不 settle，互斥会把后续所有 tick 永久挡住，轮询
 * 静默停止。重叠的请求是安全的——applyPollOutcome 按对象身份合并，旧结果不会
 * 覆盖新状态。这与基线的 setInterval 行为一致。
 */
export function createPoller(options: {
  intervalMs: number;
  run: () => Promise<void> | void;
}): { start: () => void; stop: () => void } {
  let timer: ReturnType<typeof setInterval> | null = null;

  const runOnce = () => {
    try {
      const result = options.run();
      if (result && typeof result.then === 'function') {
        void result.catch(() => { /* 单轮失败不打断后续周期 */ });
      }
    } catch {
      /* 同步抛错同样不打断定时器 */
    }
  };

  return {
    start() {
      if (timer !== null) return;
      runOnce();
      timer = setInterval(runOnce, options.intervalMs);
    },
    stop() {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
  };
}

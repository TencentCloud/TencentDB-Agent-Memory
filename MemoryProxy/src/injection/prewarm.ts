/**
 * Prewarm runner — invoked once at session_init Case 2 (immediately after
 * the control plane registers the session and the SessionStore has its
 * `initialized` state). For every hook declaring
 * `cacheStrategy ∈ {"session_init", "hybrid"}`, this runs `hook.prewarm(input)`
 * in parallel and persists the resulting blocks into `HookCacheRepo`.
 *
 * Semantics:
 *   - Best-effort. Single-hook failure → warn-log + skip (no cache for that hook).
 *   - Total timeout (default 8s). Hooks not finished by then → warn-log + skip.
 *   - The whole call NEVER throws (silently degrades to no caching).
 *
 * The repo write is the side-effect; this function returns the list of
 * successfully cached hookIds for diagnostics/tests.
 */

import type { HookCacheRepo } from "../db/hookCacheRepo.js";
import type {
  ContextBlock,
  HookRegistry,
  InjectionHook,
  PrewarmInput,
} from "./types.js";

export interface PrewarmOptions {
  /** Total timeout for the whole prewarm pass, in ms. Defaults to 20000. */
  totalTimeoutMs?: number;
  /**
   * 刷新场景专用:在 prewarm 前先 `clearBySession` 把该 session 现有缓存全清掉,
   * 让本次 prewarm 的结果成为**唯一权威**。默认 `false`(保留首次 session_init 的
   * 语义:cache miss 时 pipeline 走 execute() self-heal)。
   *
   * 为什么需要这个开关 —— 首次 session_init 与 mem:sync 刷新走同一个入口
   * `prewarmFromConfig`,但语义不同:
   *   - 首次:缓存本来是空的,prewarm 拿到 `[]`/error 就 skip 写入,pipeline 侧
   *     get 回 null 时会走 execute() 现拉一次,并 self-heal 回写缓存 —— 语义闭环。
   *   - 刷新:缓存里**已经有旧数据**了。prewarm 若某个 hook 拿到 `[]`(比如用户
   *     刚解绑 wiki+codegraph)或超时/异常,`prewarmAll` 会 skip 写入,旧数据
   *     原封不动留在 COS 上;下次请求 pipeline 从 COS 读回老快照继续注入,表现
   *     就是"资产已经解绑但注入还带着"。
   *
   * 开启 `clearBefore` 后语义变成"prewarm 拿到什么就是什么,拿不到就没有":
   *   - hook A 有内容 → 覆写缓存(正常)。
   *   - hook B 拿到 `[]` → 旧缓存被上面的 clear 清掉,不再命中(修 knowledge 那个 bug)。
   *   - hook C prewarm 抛异常/超时 → 旧缓存同样被清掉,下次 pipeline 走 execute()
   *     兜底 —— 一次网络抖动不会让老快照"无限续命"。
   */
  clearBefore?: boolean;
}

export interface PrewarmResult {
  cachedHookIds: string[];
  skipped: Array<{ hookId: string; reason: string }>;
  durationMs: number;
}

// 8s → 20s（2026-07-11）：tdai-profile-memory-injector prewarm 需要读
// self + 每个 imported chat_memory 对应 agent 的 L2 索引 + L3 persona
// （走 COS）；当 imported agent 存在或 COS 慢时，8s 常常 timeout 导致
// 整个 <tdai_profile_memory> 段落丢失。放宽到 20s 覆盖常态开发机场景。
const DEFAULT_TOTAL_TIMEOUT_MS = 20000;

function shouldPrewarm(hook: InjectionHook): boolean {
  const s = hook.cacheStrategy ?? "none";
  return s === "session_init" || s === "hybrid";
}

/** Run a promise with a per-task timeout. Rejects on timeout. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`prewarm timeout(${ms}ms): ${label}`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Prewarm all eligible hooks for a freshly initialized session.
 *
 * @param registry  The injection HookRegistry (typically the global one).
 * @param repo      Where to persist the prewarmed blocks.
 * @param input     PrewarmInput (sessionInfo, agentDetail, taskDetail, keyId).
 * @param opts      Optional knobs (timeout, etc.).
 */
export async function prewarmAll(
  registry: HookRegistry,
  repo: HookCacheRepo,
  input: PrewarmInput,
  opts: PrewarmOptions = {},
): Promise<PrewarmResult> {
  const startedAt = Date.now();
  const sessionId = input.sessionInfo.session_id;
  const totalBudget = opts.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const cachedHookIds: string[] = [];
  const skipped: Array<{ hookId: string; reason: string }> = [];

  const all = registry.getAll();
  const targets = all.filter(shouldPrewarm);

  if (targets.length === 0) {
    console.log(
      `[hook-cache] prewarm session=${sessionId}: no hooks declared cacheStrategy, skipping`,
    );
    return { cachedHookIds, skipped, durationMs: Date.now() - startedAt };
  }

  // Refresh 场景:先清掉该 session 所有 hook 的现有缓存,让本次 prewarm 成为
  // 唯一权威。见 `PrewarmOptions.clearBefore` 的注释里详细解释了为什么首次
  // session_init 不需要这么做、而刷新必须这么做。
  //
  // 位置刻意放在 targets 非空 → 每个 hook 执行之前:如果注册表里根本没有
  // 需要 prewarm 的 hook,清理也没意义(且可能误清别人在同 session 下写的东西)。
  //
  // clearBySession 内部对底层错误 swallow(见 hookCacheRepo 各实现),不会
  // 阻断后续 prewarm,符合 "prewarm 是 best-effort" 的整体语义。
  if (opts.clearBefore) {
    try {
      repo.clearBySession(input.spaceId ?? "", input.userId, input.agentSource, sessionId);
      console.log(
        `[hook-cache] prewarm session=${sessionId}: clearBefore=true, cleared existing entries`,
      );
    } catch (err) {
      console.warn(
        `[hook-cache] prewarm session=${sessionId}: clearBefore failed (continuing):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Per-hook budget: shared total, but each individual call also caps at
  // `totalBudget` so a single hang can't starve siblings (Promise.allSettled
  // ensures we observe all settlements regardless).
  const runs = targets.map(async (hook) => {
    try {
      if (typeof hook.prewarm !== "function") {
        return { hookId: hook.id, status: "skipped" as const, reason: "no prewarm() implemented" };
      }
      const blocks = await withTimeout(
        Promise.resolve(hook.prewarm(input)),
        totalBudget,
        `hook=${hook.id}`,
      );
      const arr: ContextBlock[] = Array.isArray(blocks) ? blocks : [];
      if (arr.length === 0) {
        return { hookId: hook.id, status: "skipped" as const, reason: "empty blocks" };
      }
      return { hookId: hook.id, status: "ok" as const, blocks: arr };
    } catch (err) {
      return {
        hookId: hook.id,
        status: "error" as const,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // Top-level total deadline: even if one hook hangs longer than per-hook,
  // we don't want session_init to block forever.
  const settled = await Promise.race([
    Promise.allSettled(runs),
    new Promise<PromiseSettledResult<unknown>[]>((resolve) => {
      setTimeout(() => resolve([]), totalBudget + 500);
    }),
  ]);

  if (settled.length === 0) {
    console.warn(
      `[hook-cache] prewarm session=${sessionId}: global timeout ${totalBudget}ms exceeded`,
    );
    return { cachedHookIds, skipped, durationMs: Date.now() - startedAt };
  }

  const okEntries: Array<{ hookId: string; blocks: ContextBlock[] }> = [];
  for (const s of settled) {
    if (s.status !== "fulfilled") {
      // allSettled wrapped each task's catch already; this branch is unreachable
      // in practice, but kept for safety.
      skipped.push({ hookId: "<unknown>", reason: String((s as PromiseRejectedResult).reason) });
      continue;
    }
    const r = s.value as
      | { hookId: string; status: "ok"; blocks: ContextBlock[] }
      | { hookId: string; status: "skipped"; reason: string }
      | { hookId: string; status: "error"; reason: string };
    if (r.status === "ok") {
      okEntries.push({ hookId: r.hookId, blocks: r.blocks });
      cachedHookIds.push(r.hookId);
    } else {
      skipped.push({ hookId: r.hookId, reason: r.reason });
    }
  }

  if (okEntries.length > 0) {
    repo.putMany(input.spaceId ?? "", input.userId, input.agentSource, sessionId, okEntries);
  }

  const durationMs = Date.now() - startedAt;
  console.log(
    `[hook-cache] prewarm session=${sessionId}: cached=${cachedHookIds.length} skipped=${skipped.length} durationMs=${durationMs}`,
  );
  if (skipped.length > 0) {
    for (const s of skipped) {
      console.log(`[hook-cache]   - skip hook=${s.hookId} reason=${s.reason}`);
    }
  }

  return { cachedHookIds, skipped, durationMs };
}

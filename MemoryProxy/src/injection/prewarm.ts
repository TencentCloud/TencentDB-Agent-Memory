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
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let settled: PromiseSettledResult<unknown>[];
  try {
    settled = await Promise.race([
      Promise.allSettled(runs),
      new Promise<PromiseSettledResult<unknown>[]>((resolve) => {
        deadlineTimer = setTimeout(() => resolve([]), totalBudget + 500);
      }),
    ]);
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  }

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

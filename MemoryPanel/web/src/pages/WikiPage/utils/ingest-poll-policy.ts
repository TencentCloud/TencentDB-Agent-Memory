/**
 * ingest-poll-policy —— Wiki 详情页「抽取进度」轮询的**纯策略**（无 React、无 IO）。
 *
 * 背景（issue #1917「Memory Hub 本地知识库 Wiki 导入 Markdown 文档后陷入死循环」）：
 * 详情页是 `setInterval(poll, 2000)`，**没有任何预算**，退出条件完全依赖后端状态；
 * 同时 v2.0.2 引入了一个「已提交、新任务尚未接管」的屏蔽集合（pendingTakeover），
 * 它只在**采样到 `processing`** 时解除。而 `processing` 是毫秒级瞬态：
 *   - 重复导入同一文件 → sha256 未变 → 增量分类 skip → 秒级 ready；
 *   - LLM 未配置（LLM_MODE=proxy 且无 binding）→ 直接 failed。
 * 2 秒采样完全可能错过，于是屏蔽永久残留 → 真实终态被伪装成「加工中」（失败
 * 原因看不到）+ 轮询永不停止（每 2s 一个 wiki/get）。
 *
 * 这里把三件事收敛成可单测的纯函数：
 *   1. `shouldReleaseTakeover` —— 解除屏蔽的判据（**不再依赖采到 processing**）；
 *   2. `advanceIngestPollHealth` —— 轮询预算（次数上限 + 连续失败熔断）；
 *   3. `ingestPollWindowMinutes` —— 文案由常量推导，杜绝「文案写 10 分钟、
 *      常量却改了」的漂移。
 */

/** 轮询间隔（ms）。改这里，预算时长文案自动跟随。 */
export const INGEST_POLL_INTERVAL_MS = 2000;

/**
 * 单轮抽取的轮询**尝试**次数上限（默认 300 次 ≈ 10 分钟）。
 *
 * 语义：每次 `wiki/get` 往返都算一次（成功或失败均计）。达到后暂停自动检查，
 * 而不是继续无限跑。暂停 ≠ 判定失败 —— 大文档的多轮 LLM 合并确实可能超过
 * 10 分钟，所以 UI 必须给出「重新检查」入口。
 */
export const MAX_INGEST_POLL_ATTEMPTS = 300;

/** 连续读取失败上限：网络/KS 抖动时不要每 2s 空刷，连续 3 次即暂停。 */
export const MAX_INGEST_POLL_FAILURES = 3;

/**
 * 「屏蔽」的硬性兜底时长（ms）。
 *
 * 即使时间戳比较因某种原因失效（字段缺失、时区/格式异常、服务端时钟异常），
 * 也必须在此时长后解除屏蔽 —— 永久把真实终态藏起来比误报一次陈旧终态严重得多。
 *
 * ⚠️ **不变式**：`TAKEOVER_MAX_HOLD_MS < MAX_INGEST_POLL_ATTEMPTS * INGEST_POLL_INTERVAL_MS`
 * （本处 90s < 600s）。违反后，轮询在 timeout 暂停时 pendingTakeover 可能仍存在，
 * 届时 useWikiSources effect 里 timeout 分支的"强制解除屏蔽"会把**上一次任务的
 * 终态**漏给用户 —— 即 #1917 的原始症状。改大本常量时，必须同步修 effect 里
 * timeout 分支或下调轮询 timeout。
 */
export const TAKEOVER_MAX_HOLD_MS = 90_000;

export type IngestPollPauseReason = 'timeout' | 'network';

export interface IngestPollHealth {
  /** 已尝试次数（成功 + 失败）。 */
  attempts: number;
  /** 连续失败次数；任一次成功即归零。 */
  consecutiveFailures: number;
}

export const INITIAL_INGEST_POLL_HEALTH: IngestPollHealth = {
  attempts: 0,
  consecutiveFailures: 0,
};

export interface IngestPollAdvance extends IngestPollHealth {
  /** null = 继续轮询；非 null = 本轮应暂停。 */
  pauseReason: IngestPollPauseReason | null;
}

/**
 * 推进一次轮询预算。
 *
 * @param health    该 wiki 的累计健康度（跨阶段 scanning→ingesting→rebuilding 保留）
 * @param succeeded 本次 `wiki/get` 是否拿到有效响应
 *
 * 优先级：先判 timeout 再判 network（同时命中时报 timeout，次数耗尽才是根本原因）。
 * `attempts` 只增不减，只有显式 resume / 提交新任务才重置。
 */
export function advanceIngestPollHealth(
  health: IngestPollHealth,
  succeeded: boolean,
): IngestPollAdvance {
  const attempts = health.attempts + 1;
  const consecutiveFailures = succeeded ? 0 : health.consecutiveFailures + 1;
  const pauseReason: IngestPollPauseReason | null =
    attempts >= MAX_INGEST_POLL_ATTEMPTS
      ? 'timeout'
      : consecutiveFailures >= MAX_INGEST_POLL_FAILURES
        ? 'network'
        : null;
  return { attempts, consecutiveFailures, pauseReason };
}

/** 自动检查覆盖的时长（分钟），由常量推导，供 i18n 文案插值。 */
export function ingestPollWindowMinutes(
  attempts: number = MAX_INGEST_POLL_ATTEMPTS,
  intervalMs: number = INGEST_POLL_INTERVAL_MS,
): number {
  return Math.max(1, Math.round((attempts * intervalMs) / 60000));
}

/**
 * 一次「已提交、新任务尚未接管」的屏蔽记录。
 *
 * - `baselineUpdatedAt`：**提交前**该 wiki 行上的 `updated_at`（属于上一个任务）。
 *   提交后 KS 会在同一请求内把行写成 `pending` 并刷新 `updated_at`，所以任何
 *   「比它新」的读数都必然来自新任务。
 * - `submittedAt`：提交时刻（客户端时钟），**只**用于兜底超时，不参与正确性判断。
 */
export interface TakeoverRecord {
  baselineUpdatedAt: string;
  submittedAt: number;
}

/**
 * 屏蔽是否可以解除。
 *
 * 判据（任一成立即解除）：
 *   1. `processing` —— 新任务已在跑，展示它本身就是正确的（即便这次读到的是
 *      旧任务的 processing，语义上也只是「还在加工」，不会误导）；
 *   2. `updated_at` 比提交前的基线更新 —— 该读数必然产生于提交之后，不可能是
 *      上一个任务留下的陈旧终态；
 *   3. 已超过 `TAKEOVER_MAX_HOLD_MS` —— 兜底，保证任何异常情况下都不会永久屏蔽。
 *
 * **为什么不能再用「必须看到 processing」**：上面的 ①② 说明快速成功/快速失败
 * 都会跳过 processing，那个判据等于给集合埋了一个永不触发的删除条件 —— 这正是
 * #1917 的死循环成因。
 *
 * **为什么不能简单改成「只要不是 pending 就解除」**：提交瞬间可能有在此之前就
 * 发出的 `wiki/get` 在飞，它带回的是旧任务的 `ready/failed`。若据此解除，UI 会
 * 在「新任务刚开始跑」时闪一下「已完成」。`updated_at` 比较正好排除这种陈旧读数。
 *
 * @param rec      该 wiki 的屏蔽记录；`undefined` 表示没有记录（视为可解除）
 * @param observed 本轮读到的 KS 真值；`null/undefined` 表示本次读取失败（保持屏蔽）
 * @param nowMs    当前时间（ms），仅用于兜底超时
 */
export function shouldReleaseTakeover(
  rec: TakeoverRecord | undefined,
  observed: { status?: string | null; updated_at?: string | null } | null | undefined,
  nowMs: number,
): boolean {
  if (!rec) return true;
  // 兜底超时**必须最先判**：任何后续分支（包括"本次读取失败"）都不能短路掉它，
  // 否则一旦读取持续失败就永久屏蔽 —— 那正是要消灭的那类不可达退出条件。
  if (nowMs - rec.submittedAt >= TAKEOVER_MAX_HOLD_MS) return true;
  if (!observed) return false;
  if (observed.status === 'processing') return true;
  const observedAt = observed.updated_at ?? '';
  return !!observedAt && observedAt > rec.baselineUpdatedAt;
}

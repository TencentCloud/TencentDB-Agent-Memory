/**
 * SkillWorkerPool —— 进程内单例的 skill 抽取 worker 池。
 *
 * 对齐 memory PipelineWorker：一次性起 N 条无状态 consumeLoop，
 * 从全局共享的 SkillAgentTaskQueue 拿 agent tuple。tuple 5 段自带
 * instance_id, worker 出队后按 instance_id 通过 resolver 现取对应
 * instance 的 buffer / extractor / sink, 干活时委托给
 * SkillConversationExtractWorker.consumeAgent（原封复用 8 步流程）。
 *
 * 语义与老"per-instance worker"完全一致：
 *   - agent-level extract-lock 保证同一 (instance, agent) 只有一条 loop 抽取
 *   - tasks-mutex 保护 _tasks.json 读改写
 *   - transient / permanent 错误分级 + DLQ
 *   - 幽灵 task 静默回收
 *
 * 差别只在拓扑：worker 数不再随 instance 数线性膨胀, 用 concurrency
 * 一个参数统一控制全进程 in-flight 上限。详见
 * docs/design/2026-07-30-skill-worker-instance-decoupling.md。
 */

import {
  LEGACY_INSTANCE_ID,
  parseAgentTuple,
  type AgentTuple,
  type ISkillAgentTaskQueue,
} from "./agent-task-queue.js";
import type { SkillBufferStorage } from "./buffer-storage.js";
import type { ExtractorLogger, ISkillExtractor } from "../queue/types.js";
import { runInRootContext } from "../../report/otel-context.js";
import { obsLogger } from "../../report/obs-logger.js";
import {
  SkillConversationExtractWorker,
  type SkillCandidatesSink,
  type SkillConversationExtractWorkerOptions,
} from "./extract-worker.js";

/**
 * 由 gateway 侧闭包捕获的 per-instance 资源解析函数。走进程级 cache,
 * 首次 <10ms, 后续 <1ms (Map.get)。
 */
export interface SkillWorkerResolvers {
  resolveBuffer(instanceId: string): Promise<SkillBufferStorage>;
  resolveExtractor(instanceId: string): Promise<ISkillExtractor>;
  resolveSink(instanceId: string): Promise<SkillCandidatesSink>;
}

export interface SkillWorkerPoolOptions extends SkillWorkerResolvers {
  /** 池里 worker 数, 全进程并发上限。>=1。 */
  concurrency: number;
  /** 全进程共享的 skill agent 队列。 */
  queue: ISkillAgentTaskQueue;
  logger: ExtractorLogger;
  /** 池 id 前缀, worker id 会拼上 index; 默认 `skill-pool-${pid}`。 */
  poolId?: string;

  // ── 透传给底层 SkillConversationExtractWorker 的参数 ──
  brpopBlockMs?: number;
  extractLockTtlMs?: number;
  extractLockRenewIntervalMs?: number;
  tasksMutexLockTtlMs?: number;
  tasksMutexWaitDeadlineMs?: number;
  lockContentionSleepMs?: number;
  lockContentionSleepJitterMs?: number;
  tasksPerRound?: number;
  failureRequeueSleepMs?: number;
  permanentMaxRetries?: number;
  transientLogSampleEvery?: number;
  now?: () => number;

  /**
   * 2026-08-03 crash-recovery §4.4: 本 loop 处理某个 agent 失败后 (抢锁失败 /
   * resolver 抛错 / consumeAgent 抛错), 短时间内 dequeue 到同 agent 直接跳过,
   * 避免 pool 在 peek 语义下热循环。默认 200ms。
   *
   * 抑制表存在本 loop 进程内 (per-workerLoop Map, 不跨 loop 共享 —— 不同 loop 的
   * 独立抑制状态是天然错峰)。
   */
  suppressAgentTtlMs?: number;

  /**
   * 2026-08-03 crash-recovery §4.5: 降级路径下周期性自愈扫描的间隔 ms。
   * 只在 queue.getPeekStrategy() === "rpop_lpush_downgrade" 时启用。默认 60_000。
   * 非降级路径下 start() 只跑一次冷启动扫描, 不启动定时器。
   */
  selfHealIntervalMs?: number;
}

export class SkillWorkerPool {
  private readonly opts: SkillWorkerPoolOptions;
  private readonly logger: ExtractorLogger;
  private readonly poolId: string;
  private closed = false;
  private started = false;
  private loopPromises: Promise<void>[] = [];
  private selfHealTimer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: SkillWorkerPoolOptions) {
    if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
      throw new Error(`[skill-worker-pool] concurrency must be positive integer, got ${opts.concurrency}`);
    }
    this.opts = opts;
    this.logger = opts.logger;
    this.poolId = opts.poolId ?? `skill-pool-${process.pid}`;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.closed = false;
    const n = this.opts.concurrency;
    this.logger.info(
      `[skill-worker-pool] start pool_id=${this.poolId} concurrency=${n} ` +
        `brpopBlockMs=${this.opts.brpopBlockMs ?? 5000} ` +
        `extractLockTtlMs=${this.opts.extractLockTtlMs ?? 600_000}`,
    );

    // 2026-08-03 crash-recovery §4.5: 冷启动跑一次 selfHealScan, 清历史遗留的
    // "Set 有 / List 无" 幽灵 + legacy 4 段。放在拉起 workerLoop 之前跑, 避免竞态。
    // 用 fire-and-forget 的 IIFE 而不是 await —— pool.start() 保持同步 API,
    // 扫描慢的话让 loop 并行跑, self-heal 补上任何漏的即可。
    void (async () => {
      try {
        const result = await this.selfHealScan();
        this.logger.info(
          `[skill-worker-pool] self-heal cold scan done scanned=${result.scanned} ` +
            `repushed=${result.repushed} legacy_purged=${result.legacyPurged} dur_ms=${result.dur_ms}`,
        );
        obsLogger.info("skill.worker.self_heal_scan", {
          pool_id: this.poolId,
          scanned: result.scanned,
          repushed: result.repushed,
          legacy_purged: result.legacyPurged,
          dur_ms: result.dur_ms,
          trigger: "cold_start",
        });
      } catch (err) {
        this.logger.warn(
          `[skill-worker-pool] self-heal cold scan failed: ${(err as Error).message}`,
        );
      }
    })();

    // 降级路径下额外起周期定时器。原子路径无此需要 (peek 已保证 List 状态一致)。
    const strategy =
      typeof this.opts.queue.getPeekStrategy === "function"
        ? this.opts.queue.getPeekStrategy()
        : "lmove";
    if (strategy === "rpop_lpush_downgrade") {
      const interval = this.opts.selfHealIntervalMs ?? 60_000;
      this.logger.warn(
        `[skill-worker-pool] peek strategy is DOWNGRADED — starting periodic self-heal ` +
          `every ${interval}ms`,
      );
      this.selfHealTimer = setInterval(() => {
        void (async () => {
          if (this.closed) return;
          try {
            const result = await this.selfHealScan();
            obsLogger.info("skill.worker.self_heal_scan", {
              pool_id: this.poolId,
              scanned: result.scanned,
              repushed: result.repushed,
              legacy_purged: result.legacyPurged,
              dur_ms: result.dur_ms,
              trigger: "periodic_downgrade",
            });
          } catch (err) {
            this.logger.warn(
              `[skill-worker-pool] periodic self-heal failed: ${(err as Error).message}`,
            );
          }
        })();
      }, interval);
    }

    // 拉起 N 条 workerLoop。跟 memory PipelineWorker.start 同 pattern:
    // 不 await, 全部并发常驻; stop() 里再一起等。每条 loop 放到 OTel
    // ROOT_CONTEXT 里跑 (跟老 SkillConversationExtractWorker 对齐), 防止
    // 无限循环继承"启动那一刻"的 active span 污染 LLM trace。
    for (let i = 0; i < n; i++) {
      const p = runInRootContext(() => this.workerLoop(i));
      p.catch(() => { /* logged inside */ });
      this.loopPromises.push(p);
    }
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.selfHealTimer) {
      clearInterval(this.selfHealTimer);
      this.selfHealTimer = undefined;
    }
    for (const p of this.loopPromises) {
      try { await p; } catch { /* swallow */ }
    }
    this.loopPromises = [];
  }

  /**
   * 一次性扫描 pending-agents-set, 修 List 侧缺失 + 清 legacy 4 段残留。
   * 详见 docs/design/2026-07-21-skill-worker-crash-recovery.md §4.5。
   *
   * 语义:
   *   - 5 段 legit tuple 且 List 无 → LPUSH 补回, repushed++
   *   - 4 段 legacy 残留            → SREM + LREM 清, legacyPurged++
   *   - 5 段 legit tuple 且 List 有 → 不动
   *
   * 冷启动时 pool.start() 会 fire-and-forget 调用一次; 降级路径下额外周期性调用。
   * 也 export 出来给测试 + 排障用。
   */
  async selfHealScan(): Promise<{
    scanned: number;
    repushed: number;
    legacyPurged: number;
    dur_ms: number;
  }> {
    const q = this.opts.queue;
    if (typeof q.scanAgentSet !== "function") {
      // 老 queue 实现没升级, 直接返回空结果, 不 crash pool。
      return { scanned: 0, repushed: 0, legacyPurged: 0, dur_ms: 0 };
    }
    const t0 = Date.now();
    let scanned = 0;
    let repushed = 0;
    let legacyPurged = 0;
    const members = await q.scanAgentSet();
    for (const raw of members) {
      scanned++;
      const parsed = parseAgentTuple(raw);
      if (!parsed || parsed.instance_id === LEGACY_INSTANCE_ID) {
        // legacy 4 段 (parse 出来 instance_id === LEGACY) 或损坏 (parse null) → 清。
        // 损坏残留跟 legacy 一起处理: 反正 pool 处理不了它。
        await q.purgeRawAgent(raw);
        legacyPurged++;
        continue;
      }
      const inList = await q.listContains(raw);
      if (!inList) {
        await q.enqueueRawAgent(raw);
        repushed++;
      }
    }
    return { scanned, repushed, legacyPurged, dur_ms: Date.now() - t0 };
  }

  /**
   * 单条 worker loop。设计上无状态：每次拿到 agent 就 resolver 现取资源,
   * 构造一次性 SkillConversationExtractWorker 委托 consumeAgent。
   */
  private async workerLoop(index: number): Promise<void> {
    const workerId = `${this.poolId}#${index}`;
    const blockMs = this.opts.brpopBlockMs ?? 5000;
    const suppressTtl = this.opts.suppressAgentTtlMs ?? 200;

    // 2026-08-03 crash-recovery §4.4: per-workerLoop 短抑制表, 防 peek 语义下的
    // hot-loop (抢锁失败 / resolver 抛错时 agent 仍在队头, 本 loop 200ms 内不再抢它)。
    // 别的 loop 有独立抑制状态, 天然错峰。
    const suppress = new Map<string, number>();
    const now = () => this.opts.now?.() ?? Date.now();
    const isSuppressed = (a: AgentTuple): boolean => {
      const key = `${a.instance_id}|${a.space_id}|${a.user_id}|${a.team_id}|${a.agent_id}`;
      const until = suppress.get(key);
      if (until === undefined) return false;
      if (until <= now()) { suppress.delete(key); return false; }
      return true;
    };
    const suppressAgent = (a: AgentTuple): void => {
      const key = `${a.instance_id}|${a.space_id}|${a.user_id}|${a.team_id}|${a.agent_id}`;
      suppress.set(key, now() + suppressTtl);
      // 惰性清理: 每 100 条清一次过期
      if (suppress.size > 100) {
        const t = now();
        for (const [k, v] of suppress) if (v <= t) suppress.delete(k);
      }
    };

    while (!this.closed) {
      let agent: AgentTuple | null = null;
      try {
        // 2026-08-03 crash-recovery §4.1: 用原子 peekAgent (LMOVE 语义), 保证
        // agent 在 loop 崩溃时仍留在 List, 下一轮 peek 能重新拿到。见
        // docs/design/2026-07-21-skill-worker-crash-recovery.md §4。
        agent = await this.opts.queue.peekAgent(blockMs);
      } catch (err) {
        if (this.closed) break;
        this.logger.warn(`[skill-worker-pool] ${workerId} peek error: ${(err as Error).message}`);
        await sleep(200);
        continue;
      }
      if (!agent) continue;

      // 短抑制: 本 loop 刚失败过这个 agent, 短时间内跳过。别的 loop 抑制状态独立,
      // 会拿到别的 agent, 天然让位。
      if (isSuppressed(agent)) {
        obsLogger.info("skill.worker.suppressed_skip", {
          worker_id: workerId,
          instance_id: agent.instance_id,
          agent_id: agent.agent_id,
        });
        // 短睡防止本 loop 空转紧跟着又 peek 到自己刚抑制的 agent
        await sleep(Math.min(20, suppressTtl));
        continue;
      }

      // Legacy 4 段兜底: instance_id === "__legacy__". 升级过渡期偶尔会有,
      // 见到直接丢弃 + error log, 不尝试消费 (说明版本错乱)。
      //
      // 2026-08-03 crash-recovery: peekAgent 用 LMOVE 语义, legacy 4 段 raw 已被
      // 搬到队头 —— 如果只 continue 会导致 pool 在同一条 legacy raw 上无限 peek 循环 (OOM)。
      // 必须按 4 段拼回原始 raw 字符串, purgeRawAgent 直接 SREM+LREM 清干净。
      // 5 段 serialize 命中不到这条 raw, 所以走 purgeRawAgent 而不是 removeAgent。
      if (agent.instance_id === LEGACY_INSTANCE_ID) {
        const legacyRaw = `${agent.space_id}|${agent.user_id}|${agent.team_id}|${agent.agent_id}`;
        this.logger.error(
          `[skill-worker-pool] ${workerId} legacy 4-segment tuple detected, purging: ${legacyRaw}`,
        );
        obsLogger.warn("skill.worker.legacy_tuple_dropped", {
          worker_id: workerId,
          space_id: agent.space_id,
          user_id: agent.user_id,
          team_id: agent.team_id,
          agent_id: agent.agent_id,
        });
        try {
          await this.opts.queue.purgeRawAgent(legacyRaw);
        } catch (err) {
          this.logger.warn(
            `[skill-worker-pool] ${workerId} purgeRawAgent(legacy) failed: ${(err as Error).message}`,
          );
        }
        continue;
      }

      try {
        const result = await this.consumeAgent(agent, workerId);
        // consumeAgent 只抛未处理错误, lock contention 是 result.lockContended=true。
        // 抢锁失败也进抑制, 让别的 loop 拿别的 agent。
        if (result?.lockContended) suppressAgent(agent);
      } catch (err) {
        this.logger.error(
          `[skill-worker-pool] ${workerId} consumeAgent error: ${(err as Error).message}`,
        );
        // consumeAgent 抛出 (通常是 resolver 抛错) → 抑制该 agent 一段时间,
        // 让本 loop 拿别的 agent。抑制过期后如果问题没解决还会再试。
        suppressAgent(agent);
      }
    }
  }

  /**
   * 拿到 agent 后按 instance_id resolver 现取 3 份 per-instance 资源,
   * 构造一次性 SkillConversationExtractWorker 委托 consumeAgent 走 8 步流程。
   *
   * 这里不缓存 worker 实例 —— 每次都 new 是 O(1) 分配 + 常量字段拷贝,
   * 相对 20-90 秒的 LLM 抽取可忽略, 换来的是 worker pool 本身完全无状态。
   */
  private async consumeAgent(
    agent: AgentTuple,
    workerId: string,
  ): Promise<{ lockContended?: boolean }> {
    const instanceId = agent.instance_id;
    const [buffer, extractor, sink] = await Promise.all([
      this.opts.resolveBuffer(instanceId),
      this.opts.resolveExtractor(instanceId),
      this.opts.resolveSink(instanceId),
    ]);

    const extractWorkerOpts: SkillConversationExtractWorkerOptions = {
      workerId,
      buffer,
      queue: this.opts.queue,
      extractor,
      sink,
      logger: this.logger,
      brpopBlockMs: this.opts.brpopBlockMs,
      extractLockTtlMs: this.opts.extractLockTtlMs,
      extractLockRenewIntervalMs: this.opts.extractLockRenewIntervalMs,
      tasksMutexLockTtlMs: this.opts.tasksMutexLockTtlMs,
      tasksMutexWaitDeadlineMs: this.opts.tasksMutexWaitDeadlineMs,
      lockContentionSleepMs: this.opts.lockContentionSleepMs,
      lockContentionSleepJitterMs: this.opts.lockContentionSleepJitterMs,
      tasksPerRound: this.opts.tasksPerRound,
      failureRequeueSleepMs: this.opts.failureRequeueSleepMs,
      permanentMaxRetries: this.opts.permanentMaxRetries,
      transientLogSampleEvery: this.opts.transientLogSampleEvery,
      now: this.opts.now,
    };
    const oneShot = new SkillConversationExtractWorker(extractWorkerOpts);
    // 直接调 consumeAgent —— 走同一份 8 步流程 (extract-lock / renewTimer /
    // tasks-mutex / transient-permanent / DLQ / 幽灵检测)。返回 lockContended 供
    // 上游短抑制表使用。
    const result = await oneShot.consumeAgent(agent);
    return { lockContended: result.lockContended };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

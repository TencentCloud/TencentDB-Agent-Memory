/**
 * PipelineWorker — 竞争消费 Pipeline 任务
 *
 * 需求 #12 Worker 竞争消费 + #13 死信队列与失败处理
 *
 * 架构文档 §方案C:
 * - XREADGROUP Consumer Group 竞争消费 task (单一队列)
 * - 分布式锁保护：per-session (L1/L2), per-instance (L3)
 * - 锁续约：每 30s 续约，续约失败 abort
 * - LLM 执行 + 写入：取 buffer → 调 LLM → 写 VDB/COS
 * - 级联调度：L1→L2 (via onL1Complete timer推进), L2→L3 (直接入队)
 * - 死信队列：超过重试上限 → 写入死信
 * - 重试策略：抢锁失败 5s 重投, LLM 超时指数退避 5s/15s/45s
 * - 幂等：VDB upsert by record_id, COS 覆盖写
 */

import type { IStateBackend, TaskPayload } from "../core/state/types.js";
import { buildPipelineTimerMember } from "../core/state/timer-member.js";
import { serializeTraceContext } from "../core/report/trace-propagation.js";
import { obsLogger } from "../core/report/obs-logger.js";

// ============================
// Types
// ============================

interface Logger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

/** L1/L2/L3 任务执行器 (由上层注入具体的 LLM + VDB 逻辑)
 *
 * H-11 Step 2: methods optionally accept an AbortSignal. When the worker loses
 * its distributed lock mid-execution, it aborts the signal so the executor
 * can promptly tear down in-flight LLM calls. Executors that ignore the
 * signal still work (the worker will skip ACK after lockLost), but they
 * waste compute / tokens until the LLM call naturally returns.
 */
export interface TaskExecutor {
  executeL1(task: TaskPayload, signal?: AbortSignal): Promise<void>;
  executeL2(task: TaskPayload, signal?: AbortSignal): Promise<void>;
  executeL3(task: TaskPayload, signal?: AbortSignal): Promise<void>;
  executeFlush?(task: TaskPayload, signal?: AbortSignal): Promise<void>;
  executeOffloadL1?(task: TaskPayload, signal?: AbortSignal): Promise<void>;
  executeOffloadL15?(task: TaskPayload, signal?: AbortSignal): Promise<void>;
  executeOffloadL2?(task: TaskPayload, signal?: AbortSignal): Promise<void>;
}

export interface PipelineWorkerConfig {
  /** Worker 节点 ID */
  workerId?: string;
  /** 并发消费协程数 (default: 60). 每个协程独立消费任务，不同 session 并行执行。 */
  concurrency?: number;
  /** 消费轮询间隔 ms (default: 200) */
  pollIntervalMs?: number;
  /**
   * 锁 TTL ms (default: 600000 = 10min)。
   * 必须 ≥ 2 × max(LLM timeout)：默认 LLM timeout 是 120s，
   * 留足buffer 保证即便续约 timer 因 GC / 事件循环阻塞错过 1-2 次
   * tick，锁也不会过期被别人抢走。
   *
   * 海量导入下同 agent 多 session 排队时，TTL 需覆盖正常任务执行和锁续约。
   * 锁冲突本身由本地 parked 调度器退避，不再 ACK + 重新入队。
   */
  lockTtlMs?: number;
  /** 锁续约间隔 ms (default: 30000 = TTL 的 1/8，避免续约失败) */
  lockRenewIntervalMs?: number;
  /** 最大重试次数 (default: 3) */
  maxRetries?: number;
  /** 重试基础延迟 ms (default: 5000, 指数退避) */
  retryBaseDelayMs?: number;
  /** Pending 消息回收间隔 ms (default: 30000) */
  pendingRecoveryIntervalMs?: number;
  /** Pending 消息超时判定 ms (default: 300000 = 5min, 必须 > lockTtlMs) */
  pendingStaleMs?: number;
  /** 锁冲突 parked 队首的退避序列 (default: 200/600/1800/5000ms) */
  lockRetryDelaysMs?: readonly number[];
  /** parked 重试延迟抖动比例，0 可用于确定性测试 (default: 0.2) */
  lockRetryJitterRatio?: number;
  /** 全局同时重试的 lock scope 上限 (default: min(concurrency, 8)) */
  lockRetryConcurrency?: number;
  /** 本地 parked 消息容量上限；满时 consumeLoop 在拉取前背压 (default: max(concurrency*4, 64)) */
  maxParkedTasks?: number;
  /** parked PEL claim 心跳间隔 (default: pendingStaleMs / 3，最小 50ms) */
  parkedClaimHeartbeatMs?: number;
  /** 死信任务持久化回调 */
  onDeadLetter?: (task: TaskPayload, error: string, retryCount: number) => Promise<void>;
  /**
   * L1 完成后的回调，用于推进 L2 timer（解决 L2 快路径）。
   * 由 server.ts 注入 statefulManager.advanceL2TimerAfterL1。
   * 不注入则 L2 只靠 maxInterval 兜底。
   */
  onL1Complete?: (sessionId: string, instanceId: string, teamId?: string, agentId?: string) => Promise<void>;
  /**
   * L2 完成后的回调，用于设置 L2 maxInterval timer。
   * 由 server.ts 注入 statefulManager.armL2MaxInterval。
   */
  onL2Complete?: (sessionId: string, instanceId: string, teamId?: string, agentId?: string) => Promise<void>;
  /**
   * 分布式锁粒度 (default: "session")
   * - "session": L1/L2 per-session 锁, L3 per-instance 锁 (原行为, 最大并发)
   * - "instance": L1/L2/L3 全部 per-instance 锁 (CR-1 临时缓解: 防止同 instance 不同 session
   *   并发 append 到 daily JSONL 共享 key. 代价是单 instance 内 task 完全串行.)
   *
   * 切换该值不影响持久状态 (lock 是 TTL=120s 的临时 key).
   * 灰度时必须在 lockTtlMs 时间内完成全 worker 同步切换, 避免新老 worker 用不同 key 同时持锁.
   */
  lockGranularity?: "session" | "instance";

  /**
   * PipelineWorker 内部的并发信号量。historically 跨 memory + skill V2 worker 共享,
   * 2026-07-17 skill 改造后 skill 侧不再用信号量做并发上限, 现在只有 memory
   * pipeline 一个 consumer。未注入时行为不变。processTask 入口 acquire、finally release。
   */
  permitPool?: import("./worker-permit-pool.js").WorkerPermitPool;
}

export interface DeadLetterEntry {
  task: TaskPayload;
  error: string;
  retryCount: number;
  deadAt: number;
}

const TAG = "[pipeline-worker]";

interface ClaimedTask extends TaskPayload {
  _msgId?: string;
  _ownerId?: string;
  _stream?: string;
}

interface ParkedTask {
  task: ClaimedTask;
  lockKey: string;
  attempt: number;
  nextRetryAt: number;
  ownershipLost: boolean;
}

// ============================
// PipelineWorker
// ============================

export class PipelineWorker {
  private backend: IStateBackend;
  private executor: TaskExecutor;
  private config: Required<Omit<PipelineWorkerConfig, "onDeadLetter" | "onL1Complete" | "onL2Complete" | "permitPool">> & {
    onDeadLetter?: PipelineWorkerConfig["onDeadLetter"];
    onL1Complete?: PipelineWorkerConfig["onL1Complete"];
    onL2Complete?: PipelineWorkerConfig["onL2Complete"];
    permitPool?: PipelineWorkerConfig["permitPool"];
  };
  private logger: Logger;

  private running = false;
  private destroyed = false;
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;
  private recoveryRunning = false;
  private recoveryPromise: Promise<void> | null = null;
  private consumeLoopPromises = new Set<Promise<void>>();
  private parkedRetryPromises = new Set<Promise<void>>();
  private parkedSchedulerTimer: ReturnType<typeof setTimeout> | null = null;
  private parkedHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private parkedHeartbeatRunning = false;
  private parkedHeartbeatPromise: Promise<void> | null = null;
  private claimRefreshes = new Set<Promise<boolean>>();
  private parkedByScope = new Map<string, ParkedTask[]>();
  private retryingScopes = new Set<string>();
  private parkedTaskCount = 0;
  private parkedCapacityReservations = 0;
  private parkedCapacityWaiters = new Set<() => void>();

  // Active locks tracked for graceful shutdown
  private activeLocks = new Set<string>();

  // In-flight tasks (consumed but not yet completed/failed/dropped). Used by
  // standalone /v2/pipeline/status to compute per-L-type running stats.
  // Service mode never reads this — it just costs a Map.set/delete per task.
  private runningTasks = new Map<string, TaskPayload>();

  // Dead letter queue (进程内 + 可选回调持久化)
  private deadLetterQueue: DeadLetterEntry[] = [];

  // Metrics
  private metrics = {
    tasksConsumed: 0,
    tasksCompleted: 0,
    tasksFailed: 0,
    tasksRetried: 0,
    tasksDeadLettered: 0,
    lockConflicts: 0,
    /** H-11: number of times renewLock callback failed → lockLost=true was set. */
    lockRenewFailed: 0,
    /** H-11: number of times execution finished but lockLost was true → task left in PENDING for another worker. */
    lockLostDuringExecution: 0,
    /** H-11 Step 2: number of times an executor was aborted via AbortSignal due to lockLost. */
    executionAborted: 0,
    /** Number of stream messages moved to a local lock-scope parked queue. */
    tasksParked: 0,
    /** Number of parked queue-head lock acquisition attempts. */
    parkedRetryAttempts: 0,
    /** Number of tasks dropped locally after their PEL ownership was lost. */
    taskOwnershipLost: 0,
    /** Number of parked/active claim heartbeat calls that failed or lost ownership. */
    claimRefreshFailed: 0,
  };

  constructor(backend: IStateBackend, executor: TaskExecutor, config?: PipelineWorkerConfig, logger?: Logger) {
    this.backend = backend;
    this.executor = executor;
    this.logger = logger ?? { info: console.log, warn: console.warn, error: console.error };

    const concurrency = config?.concurrency ?? 60;
    const lockTtlMs = config?.lockTtlMs ?? 600000;
    const lockRenewIntervalMs = config?.lockRenewIntervalMs ?? 30000;
    const requestedPendingStaleMs = config?.pendingStaleMs ?? 300000;
    // A healthy task must never become claimable while its distributed lock is
    // still valid. Automatically converge invalid deployments rather than rely
    // on an operational convention that the previous defaults violated.
    const minimumPendingStaleMs = lockTtlMs + (lockRenewIntervalMs * 2);
    const pendingStaleMs = Math.max(requestedPendingStaleMs, minimumPendingStaleMs);
    const maxParkedTasks = config?.maxParkedTasks ?? Math.max(concurrency * 4, 64);
    const lockRetryDelaysMs = config?.lockRetryDelaysMs ?? [200, 600, 1800, 5000];
    const lockRetryJitterRatio = config?.lockRetryJitterRatio ?? 0.2;
    const requestedRetryConcurrency = config?.lockRetryConcurrency ?? Math.max(1, Math.min(concurrency, 8));
    const parkedClaimHeartbeatMs = config?.parkedClaimHeartbeatMs
      ?? Math.max(50, Math.floor(pendingStaleMs / 3));

    if (!Number.isInteger(concurrency) || concurrency <= 0) {
      throw new RangeError(`${TAG} concurrency must be a positive integer`);
    }
    if (!Number.isFinite(lockTtlMs) || lockTtlMs <= 0) {
      throw new RangeError(`${TAG} lockTtlMs must be positive`);
    }
    if (!Number.isFinite(lockRenewIntervalMs) || lockRenewIntervalMs <= 0 || lockRenewIntervalMs >= lockTtlMs) {
      throw new RangeError(`${TAG} lockRenewIntervalMs must be positive and less than lockTtlMs`);
    }
    if (!Number.isFinite(requestedPendingStaleMs) || requestedPendingStaleMs <= 1) {
      throw new RangeError(`${TAG} pendingStaleMs must be greater than 1ms`);
    }
    if (!Number.isInteger(maxParkedTasks) || maxParkedTasks <= 0) {
      throw new RangeError(`${TAG} maxParkedTasks must be a positive integer`);
    }
    if (lockRetryDelaysMs.length === 0 || lockRetryDelaysMs.some((delay) => !Number.isFinite(delay) || delay < 0)) {
      throw new RangeError(`${TAG} lockRetryDelaysMs must contain finite non-negative delays`);
    }
    if (!Number.isFinite(lockRetryJitterRatio) || lockRetryJitterRatio < 0 || lockRetryJitterRatio > 1) {
      throw new RangeError(`${TAG} lockRetryJitterRatio must be between 0 and 1`);
    }
    if (!Number.isInteger(requestedRetryConcurrency) || requestedRetryConcurrency <= 0) {
      throw new RangeError(`${TAG} lockRetryConcurrency must be a positive integer`);
    }
    if (!Number.isFinite(parkedClaimHeartbeatMs) || parkedClaimHeartbeatMs <= 0
      || parkedClaimHeartbeatMs >= pendingStaleMs) {
      throw new RangeError(`${TAG} parkedClaimHeartbeatMs must be positive and less than pendingStaleMs`);
    }

    if (pendingStaleMs !== requestedPendingStaleMs) {
      this.logger.warn(
        `${TAG} pendingStaleMs=${requestedPendingStaleMs} is not greater than lockTtlMs=${lockTtlMs}; ` +
        `automatically raised to ${pendingStaleMs}`,
      );
    }

    this.config = {
      workerId: config?.workerId ?? `worker-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      concurrency,
      pollIntervalMs: config?.pollIntervalMs ?? 200,
      lockTtlMs,
      lockRenewIntervalMs,
      maxRetries: config?.maxRetries ?? 3,
      retryBaseDelayMs: config?.retryBaseDelayMs ?? 5000,
      pendingRecoveryIntervalMs: config?.pendingRecoveryIntervalMs ?? 30000,
      pendingStaleMs,
      lockRetryDelaysMs,
      lockRetryJitterRatio,
      lockRetryConcurrency: Math.min(requestedRetryConcurrency, maxParkedTasks),
      maxParkedTasks,
      parkedClaimHeartbeatMs,
      onDeadLetter: config?.onDeadLetter,
      onL1Complete: config?.onL1Complete,
      onL2Complete: config?.onL2Complete,
      lockGranularity: config?.lockGranularity ?? "session",
      permitPool: config?.permitPool,
    };
  }

  // ============================
  // Lifecycle
  // ============================

  async start(): Promise<void> {
    if (this.destroyed || this.running) return;
    this.running = true;

    this.logger.info(`${TAG} Starting (workerId=${this.config.workerId}, concurrency=${this.config.concurrency})`);

    // 启动 pending 消息回收循环
    this.startPendingRecovery();

    // 启动 N 个并发消费协程，并保留 Promise 供 stop 等待在途 consume/执行结束。
    for (let i = 0; i < this.config.concurrency; i++) {
      const loop = this.consumeLoop();
      this.consumeLoopPromises.add(loop);
      void loop.finally(() => this.consumeLoopPromises.delete(loop));
    }
  }

  async stop(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.running = false;

    // 停止 pending recovery / parked 调度与心跳。
    if (this.recoveryTimer) { clearInterval(this.recoveryTimer); this.recoveryTimer = null; }
    if (this.parkedSchedulerTimer) { clearTimeout(this.parkedSchedulerTimer); this.parkedSchedulerTimer = null; }
    if (this.parkedHeartbeatTimer) { clearInterval(this.parkedHeartbeatTimer); this.parkedHeartbeatTimer = null; }

    // 先唤醒并等待所有在途路径。它们观察到 destroyed 后不得再执行新 claim；
    // consume/recovery 在停机后返回的新消息会立即把 claim 调到 stale。
    this.wakeParkedCapacityWaiters();
    await Promise.allSettled([
      ...Array.from(this.consumeLoopPromises),
      ...Array.from(this.parkedRetryPromises),
      ...(this.recoveryPromise ? [this.recoveryPromise] : []),
      ...(this.parkedHeartbeatPromise ? [this.parkedHeartbeatPromise] : []),
    ]);
    if (this.claimRefreshes.size > 0) await Promise.allSettled(Array.from(this.claimRefreshes));

    // 主动把 parked/retrying claim 调老，避免停机后继续占住 PEL 所有权。
    const parked = Array.from(this.parkedByScope.values()).flat();
    await Promise.allSettled(parked.map((entry) => this.refreshTaskClaim(entry.task, this.config.pendingStaleMs)));
    this.parkedByScope.clear();
    this.parkedTaskCount = 0;

    // 释放所有活跃锁
    for (const lockKey of this.activeLocks) {
      try { await this.backend.releaseLock(lockKey, this.config.workerId); } catch { /* best effort */ }
    }
    this.activeLocks.clear();

    this.logger.info(
      `${TAG} Stopped (consumed=${this.metrics.tasksConsumed}, completed=${this.metrics.tasksCompleted}, ` +
      `failed=${this.metrics.tasksFailed}, deadLettered=${this.metrics.tasksDeadLettered})`,
    );
  }

  getMetrics() {
    let parkedTasks = 0;
    for (const queue of this.parkedByScope.values()) parkedTasks += queue.length;
    return {
      ...this.metrics,
      workerId: this.config.workerId,
      deadLetterCount: this.deadLetterQueue.length,
      parkedTasks,
      parkedCapacity: this.config.maxParkedTasks,
      parkedBackpressured: this.parkedTaskCount >= this.config.maxParkedTasks,
      parkedScopes: this.parkedByScope.size,
      retryingScopes: this.retryingScopes.size,
    };
  }

  /**
   * Snapshot of tasks currently being executed by this worker (after lock
   * acquisition, before completion/failure). Used by standalone
   * /v2/pipeline/status to compute per-L-type running stats. Service mode
   * never calls this. Returns a fresh array (Map values copy).
   */
  getRunningTasks(): TaskPayload[] {
    return Array.from(this.runningTasks.values());
  }

  getDeadLetterQueue(): readonly DeadLetterEntry[] {
    return this.deadLetterQueue;
  }

  // ============================
  // Consume Loop
  // ============================

  private async consumeLoop(): Promise<void> {
    while (this.running && !this.destroyed) {
      let capacityReserved = false;
      try {
        capacityReserved = await this.reserveParkedCapacity();
        if (!capacityReserved || !this.running || this.destroyed) return;
        const task = await this.backend.consumeTask(this.config.workerId, this.config.pollIntervalMs);
        if (!task) continue;
        if (this.destroyed) {
          await this.refreshTaskClaim(task as ClaimedTask, this.config.pendingStaleMs);
          return;
        }

        this.metrics.tasksConsumed++;
        await this.processTask(task);
      } catch (err) {
        if (!this.destroyed) {
          this.logger.error(`${TAG} Consume loop error: ${err instanceof Error ? err.message : String(err)}`);
          await this.sleep(1000); // 避免疯狂重试
        }
      } finally {
        if (capacityReserved) this.releaseParkedCapacityReservation();
      }
    }
  }

  // ============================
  // Task Processing
  // ============================

  private async processTask(
    task: TaskPayload,
    resumed?: { lockKey: string; lockAcquired: true; permitAcquired: true },
  ): Promise<void> {
    const claimedTask = task as ClaimedTask;
    const lockKey = resumed?.lockKey ?? this.getLockKey(task);
    const retryCount = (task.data?.retryCount as number) ?? 0;

    // permitPool acquire：memory pipeline 内部并发限流。parked 重试在调度器中
    // acquire 后传入 permitAcquired，避免重复获取。两条路径都由 releasePermitOnce 归还。
    const permitPool = this.config.permitPool;
    if (permitPool && !resumed?.permitAcquired) {
      await permitPool.acquire();
    }
    let permitReleased = false;
    const releasePermitOnce = (): void => {
      if (permitReleased) return;
      permitReleased = true;
      if (permitPool) {
        try { permitPool.release(); }
        catch (err) {
          this.logger.warn(`${TAG} permitPool release error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };

    // stop() may race with a parked retry after it acquired the lock. Do not
    // start new work during shutdown; release both resources and make the PEL
    // message immediately eligible for another live worker.
    if (this.destroyed) {
      if (resumed?.lockAcquired && lockKey) {
        try { await this.backend.releaseLock(lockKey, this.config.workerId); } catch { /* best effort */ }
      }
      await this.refreshTaskClaim(claimedTask, this.config.pendingStaleMs);
      releasePermitOnce();
      return;
    }

    // consumeTask 或 parked retry 可能在等待 permit 期间被其他节点接管。
    // 执行前必须刷新并验证 PEL owner；失败时不得执行或 ACK。
    if (!resumed) {
      const owned = await this.refreshTaskClaim(claimedTask);
      if (!owned || this.destroyed) {
        if (this.destroyed) {
          await this.refreshTaskClaim(claimedTask, this.config.pendingStaleMs);
        } else {
          this.noteOwnershipLost(claimedTask, "before execution");
        }
        releasePermitOnce();
        return;
      }
    }

    // Lock-free tasks still need a PEL heartbeat. Without it, a long offload
    // can be XAUTOCLAIMed and executed concurrently even though no lock exists.
    if (lockKey === null) {
      this.runningTasks.set(task.id, task);
      const abortController = new AbortController();
      let claimLost = false;
      let heartbeatPromise: Promise<void> | null = null;
      const heartbeatTimer = setInterval(() => {
        // Keep heartbeating during graceful stop while this execution is still
        // awaited; a hard process exit naturally stops the timer and enables recovery.
        if (heartbeatPromise || claimLost) return;
        const heartbeat = (async () => {
          try {
            if (await this.refreshTaskClaim(claimedTask, undefined, true)) return;
            this.noteOwnershipLost(claimedTask, "lock-free claim heartbeat");
          } catch (err) {
            this.logger.warn(
              `${TAG} lock-free claim heartbeat failed (task=${task.id}): ` +
              `${err instanceof Error ? err.message : String(err)}`,
            );
          }
          claimLost = true;
          this.metrics.claimRefreshFailed++;
          if (!abortController.signal.aborted) {
            this.metrics.executionAborted++;
            abortController.abort(new Error("pipeline-worker: lock-free task claim lost"));
          }
        })();
        heartbeatPromise = heartbeat;
        void heartbeat.then(() => {
          if (heartbeatPromise === heartbeat) heartbeatPromise = null;
        });
      }, this.config.parkedClaimHeartbeatMs);
      heartbeatTimer.unref?.();
      const stopHeartbeat = async (): Promise<void> => {
        clearInterval(heartbeatTimer);
        if (heartbeatPromise) await heartbeatPromise;
      };

      try {
        await this.executeTask(task, abortController.signal);
        await stopHeartbeat();
        if (claimLost) return;

        // ACK 必须与 PEL owner 原子校验；失主后不得记 completed 或继续副作用。
        if (!(await this.ackTaskIfOwned(claimedTask))) {
          this.noteOwnershipLost(claimedTask, "lock-free ACK");
          (task as any)._deferredEnqueue = undefined;
          return;
        }

        this.metrics.tasksCompleted++;
        this.logger?.debug?.(`${TAG} Task completed (lock-free): ${task.type} [${task.instanceId}/${task.sessionId}]`);
      } catch (err) {
        await stopHeartbeat();
        if (claimLost) {
          this.metrics.tasksFailed++;
          return;
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        this.metrics.tasksFailed++;

        if (retryCount < this.config.maxRetries) {
          const delay = this.config.retryBaseDelayMs * Math.pow(3, retryCount);
          this.logger.warn(`${TAG} Task failed (lock-free, retry ${retryCount + 1}/${this.config.maxRetries}, delay=${delay}ms): ${errMsg}`);
          await this.sleep(delay);
          if (this.destroyed) return;
          const replacement = this.buildRetryTask(task, retryCount + 1);
          if (!(await this.replacePendingTaskIfOwned(claimedTask, replacement))) {
            this.noteOwnershipLost(claimedTask, "lock-free retry replace");
            (task as any)._deferredEnqueue = undefined;
            return;
          }
          this.metrics.tasksRetried++;
        } else {
          await this.moveToDeadLetter(task, errMsg, retryCount);
        }
      } finally {
        clearInterval(heartbeatTimer);
        this.runningTasks.delete(task.id);
        releasePermitOnce();

        // Deferred enqueue (same as locked path)
        const deferred = (task as any)._deferredEnqueue as TaskPayload[] | undefined;
        if (deferred?.length) {
          for (const dTask of deferred) {
            try {
              await this.backend.enqueueTask(dTask);
              this.logger?.debug?.(`${TAG} Deferred enqueue: ${dTask.type} [${dTask.id}]`);
            } catch (err) {
              this.logger?.warn?.(`${TAG} Deferred enqueue failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      }
      return;
    }

    // Step 1: 抢分布式锁。首次冲突立即切槽：原消息保留在 PEL，
    // 不 ACK、不重新 XADD；按 lock scope FIFO parked 后马上归还 permit。
    const locked = resumed?.lockAcquired
      ?? await this.backend.acquireLock(lockKey, this.config.workerId, this.config.lockTtlMs);
    if (!locked) {
      this.metrics.lockConflicts++;
      this.parkTask(claimedTask, lockKey);
      releasePermitOnce();
      return;
    }

    this.activeLocks.add(lockKey);
    // Track in-flight task — used by standalone /v2/pipeline/status. Done after
    // lock acquisition so lock-conflict drops don't pollute the running set.
    this.runningTasks.set(task.id, task);
    let lockLost = false;
    // H-11 Step 2: AbortController so renewLock failure can immediately interrupt
    // long-running LLM calls inside the executor (saves token cost and avoids
    // writing data after the lock has been transferred to another worker).
    const abortController = new AbortController();

    // Step 2: 启动锁续约 (局部 timer，per-task 独立)
    const renewTimer = setInterval(async () => {
      try {
        const renewed = await this.backend.renewLock(lockKey, this.config.workerId, this.config.lockTtlMs);
        if (!renewed) {
          this.metrics.lockRenewFailed++;
          this.logger.warn(
            `${TAG} Lock renew failed for ${lockKey} (worker=${this.config.workerId}); ` +
            `marking lockLost and aborting executor`,
          );
          lockLost = true;
          clearInterval(renewTimer);
          // H-11 Step 2: signal the executor to abort. Any in-flight LLM / VDB call
          // wired to this signal will throw an AbortError and tear down cleanly.
          if (!abortController.signal.aborted) {
            this.metrics.executionAborted++;
            abortController.abort(new Error("pipeline-worker: lock lost during execution"));
          }
          return;
        }

        // 锁仍归本 worker 时同步刷新 Redis Stream PEL claim，避免长任务被 stale recovery 抢走。
        if (!(await this.refreshTaskClaim(claimedTask))) {
          this.metrics.claimRefreshFailed++;
          this.noteOwnershipLost(claimedTask, "active claim heartbeat");
          lockLost = true;
          clearInterval(renewTimer);
          if (!abortController.signal.aborted) {
            this.metrics.executionAborted++;
            abortController.abort(new Error("pipeline-worker: task claim lost during execution"));
          }
        }
      } catch (e) {
        this.metrics.lockRenewFailed++;
        this.logger.warn(
          `${TAG} Lock renew threw for ${lockKey}: ${e instanceof Error ? e.message : String(e)}`,
        );
        lockLost = true;
        clearInterval(renewTimer);
        if (!abortController.signal.aborted) {
          this.metrics.executionAborted++;
          abortController.abort(new Error("pipeline-worker: lock renew exception"));
        }
      }
    }, this.config.lockRenewIntervalMs);

    // Step 3: 执行任务
    try {
      await this.executeTask(task, abortController.signal);

      // H-11 Step 1: re-check lockLost after successful executeTask.
      // If the lock was lost mid-execution we must NOT ack and NOT cascade
      // because another worker has already (or will) take over via XPENDING/XCLAIM
      // recovery, and ACK'ing here would cause a silent partial-failure where the
      // task is removed from the stream while only half of its side effects landed.
      if (lockLost) {
        this.metrics.lockLostDuringExecution++;
        this.logger.warn(
          `${TAG} Lock lost during execution but task body returned; ` +
          `skipping ACK + cascadeSchedule so another worker can re-process: ` +
          `${task.type} [${task.instanceId}/${task.sessionId}]`,
        );
        // NOTE: rely on L1/L2/L3 idempotency (vectorStore.upsert by memoryId
        // is idempotent; jsonl appends use ETag/append-position so concurrent
        // writers don't corrupt). Hard rollback not feasible for COS objects.
        (task as any)._deferredEnqueue = undefined;
        return;
      }

      // Step 4: 后继状态/级联必须先完成，失败时原消息仍在 PEL，可通过
      // replacePendingTask 原子替换为 retry；禁止 ACK 后才发现 cascade 失败。
      if (!(await this.refreshTaskClaim(claimedTask))) {
        this.noteOwnershipLost(claimedTask, "before cascade");
        (task as any)._deferredEnqueue = undefined;
        return;
      }
      await this.cascadeSchedule(task);

      // Step 5: 所有副作用成功后再 ACK。若最后时刻丢失 owner，不计 completed。
      if (!(await this.ackTaskIfOwned(claimedTask))) {
        this.noteOwnershipLost(claimedTask, "completion ACK");
        (task as any)._deferredEnqueue = undefined;
        return;
      }

      this.metrics.tasksCompleted++;
      this.logger?.debug?.(`${TAG} Task completed: ${task.type} [${task.instanceId}/${task.sessionId}]`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      // 检查锁是否丢失 → 如果丢失，不重试（避免重复执行）
      if (lockLost) {
        this.logger.warn(`${TAG} Lock lost during execution, aborting: ${task.type} [${task.instanceId}/${task.sessionId}]`);
        this.metrics.tasksFailed++;
        return;
      }

      this.metrics.tasksFailed++;

      // 指数退避重试
      if (retryCount < this.config.maxRetries) {
        const delay = this.config.retryBaseDelayMs * Math.pow(3, retryCount); // 5s, 15s, 45s
        this.logger.warn(
          `${TAG} Task failed (retry ${retryCount + 1}/${this.config.maxRetries}, delay=${delay}ms): ${errMsg}`,
        );
        await this.sleep(delay);
        const replacement = this.buildRetryTask(task, retryCount + 1);
        if (!(await this.replacePendingTaskIfOwned(claimedTask, replacement))) {
          this.noteOwnershipLost(claimedTask, "retry replace");
          (task as any)._deferredEnqueue = undefined;
          return;
        }
        this.metrics.tasksRetried++;
      } else {
        await this.moveToDeadLetter(task, errMsg, retryCount);
      }
    } finally {
      // Step 6: 停止续约 + 释放锁
      clearInterval(renewTimer);
      this.activeLocks.delete(lockKey);
      this.runningTasks.delete(task.id);
      try { await this.backend.releaseLock(lockKey, this.config.workerId); } catch { /* best effort */ }
      releasePermitOnce();

      // Step 7: 延迟入队 — executor 可通过 task._deferredEnqueue 暂存需要在锁释放后才入队的任务，
      // 避免新任务立即被消费时因同 session 锁仍被持有而产生不必要的锁冲突。
      const deferred = (task as any)._deferredEnqueue as TaskPayload[] | undefined;
      if (deferred?.length) {
        for (const dTask of deferred) {
          try {
            await this.backend.enqueueTask(dTask);
            this.logger?.debug?.(`${TAG} Deferred enqueue: ${dTask.type} [${dTask.id}]`);
          } catch (err) {
            this.logger?.warn?.(`${TAG} Deferred enqueue failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }
  }

  // ============================
  // Lock-conflict parking / PEL ownership
  // ============================

  private async reserveParkedCapacity(): Promise<boolean> {
    while (!this.destroyed) {
      if (this.parkedTaskCount + this.parkedCapacityReservations < this.config.maxParkedTasks) {
        this.parkedCapacityReservations++;
        return true;
      }
      await new Promise<void>((resolve) => {
        this.parkedCapacityWaiters.add(resolve);
        if (this.destroyed) {
          this.parkedCapacityWaiters.delete(resolve);
          resolve();
        }
      });
    }
    return false;
  }

  private releaseParkedCapacityReservation(): void {
    this.parkedCapacityReservations = Math.max(0, this.parkedCapacityReservations - 1);
    this.wakeParkedCapacityWaiters();
  }

  private wakeParkedCapacityWaiters(): void {
    for (const resolve of this.parkedCapacityWaiters) resolve();
    this.parkedCapacityWaiters.clear();
  }

  private parkTask(task: ClaimedTask, lockKey: string): void {
    const queue = this.parkedByScope.get(lockKey) ?? [];
    queue.push({
      task,
      lockKey,
      attempt: 0,
      nextRetryAt: Date.now() + this.getParkedRetryDelay(0),
      ownershipLost: false,
    });
    this.parkedByScope.set(lockKey, queue);
    this.parkedTaskCount++;
    this.metrics.tasksParked++;
    this.logger?.debug?.(
      `${TAG} Parked after lock conflict [${task.type}] (task=${task.id}, scope=${lockKey}, depth=${queue.length})`,
    );
    this.ensureParkedHeartbeat();
    this.scheduleParkedRetries();
  }

  private getParkedRetryDelay(attempt: number): number {
    const delays = this.config.lockRetryDelaysMs;
    const base = delays[Math.min(attempt, delays.length - 1)] ?? 5000;
    const jitter = Math.max(0, this.config.lockRetryJitterRatio);
    if (jitter === 0) return Math.max(0, base);
    const factor = 1 + (Math.random() * 2 - 1) * jitter;
    return Math.max(0, Math.round(base * factor));
  }

  private scheduleParkedRetries(): void {
    if (this.destroyed) return;
    if (this.parkedSchedulerTimer) {
      clearTimeout(this.parkedSchedulerTimer);
      this.parkedSchedulerTimer = null;
    }

    const capacity = this.config.lockRetryConcurrency - this.retryingScopes.size;
    const now = Date.now();
    const candidates = Array.from(this.parkedByScope.entries())
      .filter(([scope, queue]) => queue.length > 0 && !this.retryingScopes.has(scope))
      .sort((a, b) => a[1][0]!.nextRetryAt - b[1][0]!.nextRetryAt);

    let started = 0;
    for (const [scope, queue] of candidates) {
      if (started >= capacity || queue[0]!.nextRetryAt > now) break;
      started++;
      this.retryingScopes.add(scope);
      const retry = this.retryParkedScope(scope);
      this.parkedRetryPromises.add(retry);
      void retry.finally(() => {
        this.parkedRetryPromises.delete(retry);
        this.retryingScopes.delete(scope);
        this.scheduleParkedRetries();
      });
    }

    if (started > 0 || this.retryingScopes.size >= this.config.lockRetryConcurrency) return;
    const next = candidates.find(([scope]) => !this.retryingScopes.has(scope));
    if (!next) return;
    const waitMs = Math.max(0, next[1][0]!.nextRetryAt - Date.now());
    this.parkedSchedulerTimer = setTimeout(() => {
      this.parkedSchedulerTimer = null;
      this.scheduleParkedRetries();
    }, waitMs);
    this.parkedSchedulerTimer.unref?.();
  }

  private async retryParkedScope(scope: string): Promise<void> {
    const queue = this.parkedByScope.get(scope);
    const entry = queue?.[0];
    if (!queue || !entry || this.destroyed) return;

    if (entry.ownershipLost || !(await this.refreshTaskClaim(entry.task))) {
      this.removeParkedHead(scope, entry);
      if (!entry.ownershipLost) this.noteOwnershipLost(entry.task, "before parked retry");
      return;
    }

    const permitPool = this.config.permitPool;
    let permitAcquired = false;
    try {
      if (permitPool) {
        await permitPool.acquire();
        permitAcquired = true;
      }
      if (this.destroyed) return;

      // acquire() 可能排队很久；拿到 permit 后必须再次验证 owner。
      if (!(await this.refreshTaskClaim(entry.task))) {
        this.removeParkedHead(scope, entry);
        this.noteOwnershipLost(entry.task, "after parked permit wait");
        return;
      }

      this.metrics.parkedRetryAttempts++;
      const acquired = await this.backend.acquireLock(scope, this.config.workerId, this.config.lockTtlMs);
      if (this.destroyed) {
        if (acquired) {
          try { await this.backend.releaseLock(scope, this.config.workerId); } catch { /* best effort */ }
        }
        return;
      }
      if (!acquired) {
        entry.attempt++;
        entry.nextRetryAt = Date.now() + this.getParkedRetryDelay(entry.attempt);
        this.metrics.lockConflicts++;
        return;
      }

      this.removeParkedHead(scope, entry);
      // Transfer permit ownership before awaiting: processTask releases it in
      // its own finally even when retry replacement or DLQ persistence throws.
      permitAcquired = false;
      await this.processTask(entry.task, { lockKey: scope, lockAcquired: true, permitAcquired: true });
    } catch (err) {
      this.logger.warn(
        `${TAG} Parked retry failed (task=${entry.task.id}, scope=${scope}): ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
      if (!this.destroyed && this.parkedByScope.get(scope)?.[0] === entry) {
        entry.attempt++;
        entry.nextRetryAt = Date.now() + this.getParkedRetryDelay(entry.attempt);
      }
    } finally {
      if (permitAcquired && permitPool) {
        try { permitPool.release(); } catch { /* best effort */ }
      }
    }
  }

  private removeParkedHead(scope: string, expected: ParkedTask): void {
    this.removeParkedEntry(scope, expected);
  }

  private removeParkedEntry(scope: string, expected: ParkedTask): void {
    const queue = this.parkedByScope.get(scope);
    if (!queue) return;
    const index = queue.indexOf(expected);
    if (index < 0) return;
    queue.splice(index, 1);
    this.parkedTaskCount = Math.max(0, this.parkedTaskCount - 1);
    this.wakeParkedCapacityWaiters();
    if (queue.length === 0) this.parkedByScope.delete(scope);
    else if (index === 0) queue[0]!.nextRetryAt = Date.now() + this.getParkedRetryDelay(0);
    if (this.parkedByScope.size === 0 && this.parkedHeartbeatTimer) {
      clearInterval(this.parkedHeartbeatTimer);
      this.parkedHeartbeatTimer = null;
    }
  }

  private ensureParkedHeartbeat(): void {
    if (this.parkedHeartbeatTimer || this.destroyed) return;
    this.parkedHeartbeatTimer = setInterval(() => {
      const heartbeat = this.heartbeatParkedClaims();
      this.parkedHeartbeatPromise = heartbeat;
      void heartbeat.finally(() => {
        if (this.parkedHeartbeatPromise === heartbeat) this.parkedHeartbeatPromise = null;
      });
    }, this.config.parkedClaimHeartbeatMs);
    this.parkedHeartbeatTimer.unref?.();
  }

  private async heartbeatParkedClaims(): Promise<void> {
    if (this.destroyed || this.parkedHeartbeatRunning) return;
    this.parkedHeartbeatRunning = true;
    try {
      const entries = Array.from(this.parkedByScope.entries())
        .flatMap(([scope, queue]) => queue.map((entry) => ({ scope, entry })));
      await Promise.all(entries.map(async ({ scope, entry }) => {
        if (entry.ownershipLost) return;
        if (!(await this.refreshTaskClaim(entry.task))) {
          entry.ownershipLost = true;
          this.metrics.claimRefreshFailed++;
          this.noteOwnershipLost(entry.task, "parked claim heartbeat");
          this.removeParkedEntry(scope, entry);
        }
      }));
    } finally {
      this.parkedHeartbeatRunning = false;
      this.scheduleParkedRetries();
    }
  }

  private async refreshTaskClaim(
    task: ClaimedTask,
    idleMs?: number,
    allowDuringStop = false,
  ): Promise<boolean> {
    if (!task._msgId) return true;
    if (!this.backend.refreshTaskClaim) return true;
    if (this.destroyed && idleMs === undefined && !allowDuringStop) return false;

    const refresh = this.backend.refreshTaskClaim(
      task._msgId,
      task._ownerId ?? this.config.workerId,
      idleMs,
    );
    this.claimRefreshes.add(refresh);
    try {
      return await refresh;
    } catch (err) {
      this.logger.warn(
        `${TAG} refreshTaskClaim failed (task=${task.id}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    } finally {
      this.claimRefreshes.delete(refresh);
    }
  }

  private async ackTaskIfOwned(task: ClaimedTask): Promise<boolean> {
    if (!task._msgId) return true;
    if (this.backend.ackTaskIfOwned) {
      try {
        return await this.backend.ackTaskIfOwned(task._msgId, task._ownerId ?? this.config.workerId);
      } catch (err) {
        this.logger.warn(
          `${TAG} ackTaskIfOwned failed (task=${task.id}): ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      }
    }
    await this.backend.ackTask(task._msgId);
    return true;
  }

  private noteOwnershipLost(task: ClaimedTask, phase: string): void {
    this.metrics.taskOwnershipLost++;
    this.logger.warn(
      `${TAG} Task ownership lost; skipping execution/ACK/cascade ` +
      `(phase=${phase}, task=${task.id}, owner=${task._ownerId ?? this.config.workerId})`,
    );
  }

  private async executeTask(task: TaskPayload, signal?: AbortSignal): Promise<void> {
    switch (task.type) {
      case "L1": return this.executor.executeL1(task, signal);
      case "L2": return this.executor.executeL2(task, signal);
      case "L3": return this.executor.executeL3(task, signal);
      case "flush": return this.executor.executeFlush?.(task, signal) ?? this.executor.executeL1(task, signal);
      case "offload-l1": return this.executor.executeOffloadL1?.(task, signal);
      case "offload-l15": return this.executor.executeOffloadL15?.(task, signal);
      case "offload-l2": return this.executor.executeOffloadL2?.(task, signal);
      default:
        this.logger.warn(`${TAG} Unknown task type: ${task.type}`);
    }
  }

  // ============================
  // 级联调度
  // ============================

  private async cascadeSchedule(task: TaskPayload): Promise<void> {
    const now = Date.now();
    const tid = task.teamId ?? (task.data as any)?.teamId;
    const aid = task.agentId ?? (task.data as any)?.agentId;

    if (task.type === "L1" || task.type === "flush") {
      // L1 完成 → reset session-level L1 state, then advance agent/profile-level L2 timers.
      await this.backend.updateSessionState(task.instanceId, task.sessionId, {
        conversation_count: 0,
      }, tid, aid);
      const profileScopes = Array.isArray((task as any)._l2ProfileScopes)
        ? ((task as any)._l2ProfileScopes as string[]).filter(Boolean)
        : [];
      const l2Keys = profileScopes.length > 0 ? profileScopes : [task.sessionId];
      if (this.config.onL1Complete) {
        for (const l2Key of l2Keys) {
          await this.backend.updateSessionState(task.instanceId, l2Key, { l2_pending_l1_count: 1 }, tid, aid);
          // Timer advancement is part of successful L1 completion. Propagate
          // failures so the original PEL message is atomically replaced by a
          // retry instead of ACKing a task whose L2 continuation was lost.
          await this.config.onL1Complete(l2Key, task.instanceId, tid, aid);
        }
      }
      this.logger?.debug?.(`${TAG} [${task.instanceId}/${task.sessionId}] L1 done → L2 timer advanced (${l2Keys.join(",")})`);
    }

    if (task.type === "L2") {
      // If L2 was skipped (no new L1 records), don't cascade to L3 or arm timer
      if ((task as any)._l2Skipped) {
        // L2 made no scene change — common once the scene set is at maxScenes,
        // so CREATE is blocked and no existing scene is updated. Don't arm the
        // L2 timer or advance L2 state, but DO still enqueue L3. Otherwise,
        // once every session's L1 is fully drained, no L2 ever produces a
        // change, so L3 is never reached and the persona can never
        // (re)generate — even with request_persona_update set — and the dead
        // end recurs after every restart (l2LastRunTime is in-memory, so the
        // first post-restart L2 for each session is a cold-start skip).
        // PersonaTrigger.shouldGenerate() (checkpoint-only, no LLM) stays the
        // sole gate, so this is cheap and idempotent: it returns should=false
        // in the steady state and only generates on request/threshold/recovery.
        this.logger?.debug?.(`${TAG} [${task.instanceId}/${task.sessionId}] L2 skipped (no new data); enqueuing L3 anyway (PersonaTrigger gates actual generation)`);
        await this.backend.enqueueTask({
          id: `L3-${task.id}`,
          type: "L3",
          instanceId: task.instanceId,
          sessionId: task.sessionId,
          teamId: tid,
          agentId: aid,
          priority: 2,
          data: task.data ? { ...task.data, ...serializeTraceContext() } : { teamId: tid, agentId: aid, ...serializeTraceContext() },
          createdAt: now,
        });
        return;
      }

      // L2 完成 → 直接入队 L3（携带 trace context 用于跨异步链路关联）
      // L3 task 也带 team/agent，保锁粒度对齐
      await this.backend.enqueueTask({
        // Stable across L2 replay so downstream idempotency keys do not change
        // when the worker crashes after enqueue but before ACK.
        id: `L3-${task.id}`,
        type: "L3",
        instanceId: task.instanceId,
        sessionId: task.sessionId,
        teamId: tid,
        agentId: aid,
        priority: 2,
        data: task.data ? { ...task.data, ...serializeTraceContext() } : { teamId: tid, agentId: aid, ...serializeTraceContext() },
        createdAt: now,
      });
      await this.backend.updateSessionState(task.instanceId, task.sessionId, {
        l2_pending_l1_count: 0,
        l2_last_extraction_time: new Date().toISOString(),
      }, tid, aid);
      // onL2Complete 由 server.ts 注入 statefulManager.armL2MaxInterval。
      // 失败必须传播，避免 ACK 后永久失去 maxInterval 兜底 timer。
      if (this.config.onL2Complete) {
        await this.config.onL2Complete(task.sessionId, task.instanceId, tid, aid);
      }
      this.logger?.debug?.(`${TAG} [${task.instanceId}/${task.sessionId}] L2 done → L3 enqueued`);
    }
  }

  // ============================
  // Lock Management
  // ============================

  /**
   * Lock key 设计：
   *
   * v2 pipeline 默认 (lockGranularity="session", 实际是 (instance, team, agent) 散开):
   *   - L1: pipeline:{inst:tid:aid}:s:{sess}   — session 级锁
   *           L1 数据按 (team,user,agent,session) 在 TCVDB 隔离，
   *           不同 session 真并发抽取
   *   - L2: pipeline:{inst:tid:aid}            — agent 级锁
   *           L2 落地是 profiles/team:T|agent:X/scene_blocks/ 共享目录，
   *           同 agent 不同 session 的 L2 必须互斥避免撞写 scene/index 文件
   *   - L3: pipeline:{inst:tid:aid}            — agent 级锁（同 L2）
   *           L3 写 profiles/team:T|agent:X/persona.md 一个 agent 一份
   *
   * 跨 agent 完全并发：不同 (tid, aid) 散到不同 Redis Cluster slot，
   * 避免单 instance 集中到一个 hash slot 形成大 key 热点。
   *
   * teamId / agentId 缺失（旧调用 / offload）时退化到 "_:_" 占位，
   * 等价于按 instance 维度落同一 slot —— 兼容老行为，不会破坏锁互斥。
   *
   * lockGranularity="instance" (legacy CR-1 缓解):
   *   - L1/L2/L3: pipeline:{instanceId}        — 全部 instance 级共享同一把锁
   *   不推荐使用，保留向后兼容。新部署用默认即可。
   *
   * Rolling upgrade caveat:
   *   新旧 worker 的 ACK/PEL 协议不同，不允许在同一 keyPrefix + consumer group
   *   下长期混跑。上线应先停止旧 consumer 并等待在途任务结束，再启动新版本；
   *   或使用独立 keyPrefix 做蓝绿切换并显式排空旧 Stream。
   */
  private getLockKey(task: TaskPayload): string | null {
    // offload-l1 is lock-free: rename guarantees exclusive file ownership,
    // appendFile is atomic (O_APPEND), and state.json is read-only for L1.
    if (task.type === "offload-l1") return null;

    // offload-l2: per-MMD lock so different MMDs can be processed concurrently.
    if (task.type === "offload-l2") {
      const mmdFile = (task.data as any)?.targetMmdFile ?? "default";
      return `pipeline:{${task.instanceId}}:offload-l2:${mmdFile}`;
    }

    // offload-l15: lock-free at worker level. The executor acquires a short
    // lock only during the final write phase (state.json update), allowing
    // multiple L1.5 LLM calls to run concurrently without blocking each other.
    if (task.type === "offload-l15") return null;

    if (this.config.lockGranularity === "instance") {
      return `pipeline:{${task.instanceId}}`;
    }

    // v2 默认：按 (instance, team, agent) 散开 hash tag
    //
    // teamId/agentId 优先级：
    //   1. task.teamId / task.agentId（v2 入队时显式带）
    //   2. task.data.teamId / task.data.agentId（兼容老调用）
    //   3. 从 task.sessionId 解析（timer-scanner 入队的 L2/L3 task,
    //      sessionId 形如 "profile:team:T|agent:A" 或
    //      "profile:team:T|agent:A|session:S" 时从里面抠出 tid/aid）
    //   4. "_" 占位退化到 instance 级（不推荐，hash 集中）
    let tid = task.teamId || (task.data as any)?.teamId;
    let aid = task.agentId || (task.data as any)?.agentId;
    if (!tid || !aid) {
      const m = task.sessionId.match(/^profile:team:([^|]+)\|agent:([^|]+)(?:\|session:.+)?$/);
      if (m) {
        // profile scope 里的 team 字段实际是 (teamId || userId)，与 buildProfileIsolationScope 一致。
        // 这里直接当 teamId 用即可，hash 分桶维度对齐就行。
        // 如果 key 携带 source session，它只作为 L2 输入边界，不进入锁粒度。
        tid = tid || m[1];
        aid = aid || m[2];
      }
    }
    tid = tid || "_";
    aid = aid || "_";
    const ns = `{${task.instanceId}:${tid}:${aid}}`;

    if (task.type === "L2" || task.type === "L3") {
      // agent 级锁：同 agent 的 L2/L3 互斥，避免共享目录撞写
      return `pipeline:${ns}`;
    }
    // L1 + flush 仍是 session 级
    return `pipeline:${ns}:s:${task.sessionId}`;
  }

  // ============================
  // Dead Letter (#13)
  // ============================

  private async moveToDeadLetter(task: TaskPayload, error: string, retryCount: number): Promise<void> {
    const claimedTask = task as ClaimedTask;

    // Persist the terminal failure before ACK. If persistence fails, leave the
    // original message in PEL so stale recovery can retry without silent loss.
    if (this.config.onDeadLetter) {
      await this.config.onDeadLetter(task, error, retryCount);
    }

    if (!(await this.ackTaskIfOwned(claimedTask))) {
      this.noteOwnershipLost(claimedTask, "dead-letter ACK");
      (task as any)._deferredEnqueue = undefined;
      return;
    }

    const entry: DeadLetterEntry = { task, error, retryCount, deadAt: Date.now() };
    this.deadLetterQueue.push(entry);
    this.metrics.tasksDeadLettered++;

    this.logger.error(
      `${TAG} Dead letter: ${task.type} [${task.instanceId}/${task.sessionId}] after ${retryCount} retries: ${error}`,
    );

    // Clean up timers for this session to prevent ghost triggers
    try {
      const tid = task.teamId ?? (task.data as any)?.teamId;
      const aid = task.agentId ?? (task.data as any)?.agentId;
      await this.backend.removeTimer(task.instanceId, buildPipelineTimerMember(task.sessionId, "L1_idle", { teamId: tid, agentId: aid }));
      await this.backend.removeTimer(task.instanceId, buildPipelineTimerMember(task.sessionId, "L2_schedule", { teamId: tid, agentId: aid }));
    } catch { /* best effort */ }

    obsLogger.error("core.task.dead_letter", {
      instance_id: task.instanceId,
      session_id: task.sessionId,
      task_type: task.type,
      task_id: task.id,
      error,
      retry_count: retryCount,
    });
  }

  private buildRetryTask(task: TaskPayload, newRetryCount: number): TaskPayload {
    const replacement: TaskPayload = {
      ...task,
      id: `${task.type}-${task.sessionId}-retry${newRetryCount}-${Date.now()}`,
      data: { ...task.data, retryCount: newRetryCount },
      createdAt: Date.now(),
    };
    delete replacement._msgId;
    delete replacement._ownerId;
    delete replacement._stream;
    delete (replacement as any)._l2Skipped;
    delete (replacement as any)._l2HasMore;
    delete (replacement as any)._l2LatestCursor;
    delete (replacement as any)._l2ProfileScopes;
    delete (replacement as any)._deferredEnqueue;
    return replacement;
  }

  private async replacePendingTaskIfOwned(task: ClaimedTask, replacement: TaskPayload): Promise<boolean> {
    if (!task._msgId) {
      await this.backend.enqueueTask(replacement);
      return true;
    }
    if (!this.backend.replacePendingTask) {
      throw new Error(`${TAG} replacePendingTask unavailable; original task remains pending (task=${task.id})`);
    }
    return this.backend.replacePendingTask(
      task._msgId,
      task._ownerId ?? this.config.workerId,
      replacement,
    );
  }

  // ============================
  // Pending Message Recovery (#13.2: XPENDING 超时检测 + XCLAIM)
  // ============================

  /**
   * 定期扫描远程队列中超时未 ACK 的 pending 消息。
   *
   * 当某个 Worker 进程挂了，它消费过但未 ACK 的消息会卡在 pending 列表。
   * 存活的 Worker 通过后端的 claimStaleTasks 接管这些消息重新处理。
   *
   * 保证：
   * - 幂等: VDB upsert by record_id, COS 覆盖写
   * - 不重复: 后端原子转移所有权，同一消息只会被一个 Worker 认领
   */
  private startPendingRecovery(): void {
    if (!this.backend.claimStaleTasks) return; // LocalStateBackend 不需要

    this.recoveryTimer = setInterval(() => {
      if (this.destroyed || this.recoveryRunning) return;
      const recovery = this.runPendingRecovery();
      this.recoveryPromise = recovery;
      void recovery.finally(() => {
        if (this.recoveryPromise === recovery) this.recoveryPromise = null;
      });
    }, this.config.pendingRecoveryIntervalMs);
  }

  private async runPendingRecovery(): Promise<void> {
    if (this.destroyed || this.recoveryRunning || !this.backend.claimStaleTasks) return;
    this.recoveryRunning = true;
    let reserved = 0;
    try {
      const available = this.config.maxParkedTasks
        - this.parkedTaskCount
        - this.parkedCapacityReservations;
      if (available <= 0) return;
      reserved = Math.min(10, available);
      this.parkedCapacityReservations += reserved;

      const stale = await this.backend.claimStaleTasks(
        this.config.workerId,
        this.config.pendingStaleMs,
        reserved,
      );
      const unused = reserved - stale.length;
      this.parkedCapacityReservations -= unused;
      if (unused > 0) this.wakeParkedCapacityWaiters();
      reserved = stale.length;
      if (stale.length === 0) return;

      if (this.destroyed) {
        await Promise.allSettled(
          stale.map((task) => this.refreshTaskClaim(task as ClaimedTask, this.config.pendingStaleMs)),
        );
        return;
      }

      this.logger.info(`${TAG} Recovered ${stale.length} stale pending task(s)`);
      await Promise.all(stale.map(async (task) => {
        this.metrics.tasksConsumed++;
        try {
          await this.processTask(task);
        } catch (err) {
          this.logger.error(`${TAG} Recovery task failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }));
    } catch (err) {
      this.logger.warn(`${TAG} Pending recovery error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      while (reserved-- > 0) this.releaseParkedCapacityReservation();
      this.recoveryRunning = false;
    }
  }

  // ============================
  // Util
  // ============================

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => { const t = setTimeout(r, ms); t.unref(); });
  }
}

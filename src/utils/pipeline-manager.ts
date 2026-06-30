/**
 * MemoryPipelineManager: 管理 L0→L1→L2→L3 四级记忆提取流水线。
 * MemoryPipelineManager: manages the L0→L1→L2→L3 memory extraction pipeline.
 *
 * ## 分层架构 / Layered architecture
 *
 * - **L0（采集层 / capture）**: `auto-capture.ts` 从每个 `agent_end` 事件中提取
 *   新消息，做脱敏处理后通过 `notifyConversation(sessionKey, messages)` 传入流水线。
 *   消息在本地按会话缓存 —— 此阶段**不会**发起远程调用。
 *
 * - **L1（批量提取/入库层 / batch extraction）**: 当会话轮次达到 `everyNConversations`
 *   阈值 **或** 会话闲置超过 `l1IdleTimeoutSeconds` 时，L1 Runner 被触发，接收
 *   `{ sessionKey, msg, bg_msg }`，负责将消息入库/提取（例如调用 appendEvent
 *   或执行本地提取逻辑）。`bg_msg` 为背景上下文预留字段，当前始终为空。
 *
 * - **L2（场景提取层 / scene extraction）**: 每个会话独立的下行定时器。
 *   每次 L2 完成后，下次触发时间设为 `now + maxInterval`。当 L1 完成（有新的记忆事件）
 *   时，触发时间会被提前（但绝不推迟）到 `max(now + delay, lastL2 + minInterval)`。
 *   定时器触发时，如果会话已冷却（不活跃时间 > `sessionActiveWindowHours`），
 *   定时器会被取消而不是触发 L2 —— 它将由下一次 L1 事件重新激活。
 *
 * - **L3（人格生成层 / persona generation）**: 全局互斥锁（并发=1）+ pending 标记去重。
 *   在 L2 完成后触发。
 *
 * ## 定时器语义 / Timer semantics
 *
 * L1 使用**可重置定时器**（经典空闲/防抖模式）：每次对话将倒计时重置为
 * `l1IdleTimeoutSeconds`。定时器触发时，缓冲的消息通过 L1 批量处理。
 *
 * L2 使用**只下不定时器（downward-only timer）**: 预定的触发时间只能提前，不能推迟。
 * 这样既保证了 maxInterval 兜底，又保证了 L1 之后的快速响应，同时 minInterval 作为
 * 频率下限防止过度触发。
 *
 * 两种定时器都通过 `ManagedTimer` 实现，消除了重复的 clear→set→fire→clean 样板代码。
 *
 * ## L1 触发路径
 *   A. **对话阈值触发**（主要路径）：当 `notifyConversation()` 中
 *      `conversation_count >= effectiveThreshold` 时，L1 立即触发并携带所有缓冲消息。
 *      有效阈值受预热模式影响（见下文）。
 *   B. **空闲超时触发**（兜底路径）：当会话闲置超过 `l1IdleTimeoutSeconds` 时，
 *      L1 用已缓冲的消息（低于阈值）触发。
 *   C. **优雅关闭冲刷**：在优雅关闭时，所有待处理的缓冲区通过 L1→L2 冲刷处理。
 *
 * ## 预热模式 / Warm-up mode
 *
 * 当 `enableWarmup` 为 true（默认值）时，新会话使用指数增长的 L1 触发阈值，
 * 而不是直接跳到 `everyNConversations`。增长序列为：1 → 2 → 4 → 8 → ... →
 * everyNConversations。这确保了早期对话能被快速处理（首次对话立即触发 L1），
 * 同时随着会话成熟逐步降低处理频率。
 *
 * `PipelineSessionState` 中的 `warmup_threshold` 字段跟踪当前阈值。
 * 值为 0 表示预热已完成（已毕业进入稳态）。每次成功执行 L1 后阈值翻倍。
 *
 * ## L2 触发路径
 *   A. **L1后延迟触发**: L1 完成 → 定时器提前到
 *      `max(now + delay, lastL2 + min)` → 触发 → 入队 L2。
 *   B. **最大间隔兜底**: L2 完成 → 定时器设为
 *      `now + maxInterval` → 触发 → 入队 L2（仅活跃会话）。
 *   C. **优雅关闭冲刷**: 所有待处理的 L2 定时器被冲刷。
 *
 * 所有队列使用 SerialQueue（并发=1）保证串行执行。
 *
 * ## 设计文档 / Design doc
 * 详见 `docs/08-pipeline-refactor-design.md`。
 */

import type { PipelineSessionState } from "./checkpoint.js";
import { SessionFilter } from "./session-filter.js";
import { ManagedTimer } from "./managed-timer.js";
import { SerialQueue } from "./serial-queue.js";
import { report } from "../core/report/reporter.js";
import type { Logger } from "../core/types.js";

// ============================
// 类型定义 / Types
// ============================

/** 单条已捕获的消息，已准备好进入 L1 处理。 */
export interface CapturedMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  /** ISO 格式时间戳字符串 */
  timestamp: string;
}

/** 流水线配置 —— 所有时间单位为秒。 */
export interface PipelineConfig {
  /**
   * 触发 L1 批量处理的对话轮次阈值。
   * 当会话的 conversation_count 达到此值时，L1 立即触发并携带所有缓冲消息。
   * 默认值：5。
   */
  everyNConversations: number;

  /**
   * 是否启用新会话预热模式。
   * 启用后，L1 触发阈值从 1 开始，每次成功执行 L1 后翻倍
   * (1 → 2 → 4 → 8 → ... → everyNConversations)，
   * 使早期会话得到更积极的处理。
   * 默认值：true。
   */
  enableWarmup: boolean;

  l1: {
    /** 触发 L1 的空闲超时时间（秒，默认：60） */
    idleTimeoutSeconds: number;
  };

  l2: {
    /**
     * L1 完成后到触发 L2 的延迟时间（秒，默认：90）。
     * 给远程 L1 留出异步生成记录的时间。
     */
    delayAfterL1Seconds: number;
    /** 每个会话 L2 提取的最小间隔（秒，默认：900，即15分钟） */
    minIntervalSeconds: number;
    /**
     * 每个会话 L2 提取的最大间隔（秒，默认：3600，即1小时）。
     * 即使没有新的 L1 完成，活跃会话的 L2 也会按此间隔轮询。
     */
    maxIntervalSeconds: number;
    /**
     * 会话不活跃时间超过此值（小时，默认：24）后停止 L2 轮询。
     * 避免在废弃会话上浪费资源。
     */
    sessionActiveWindowHours: number;
  };
}

/** L1 执行器返回的结果。 */
export interface L1RunnerResult {
  /** 成功处理的消息数量 */
  processedCount?: number;
}

/** L1 执行器 —— 批量处理某个会话的缓冲消息。 */
export type L1Runner = (params: {
  sessionKey: string;
  msg: CapturedMessage[];     // 当前对话的消息列表
  bg_msg: CapturedMessage[];  // 背景上下文消息（当前始终为空）
}) => Promise<L1RunnerResult | void>;

/** L2 提取执行器返回的结果。 */
export interface L2RunnerResult {
  /** 处理后批次中最新的 `updated_at` 游标。 */
  latestCursor?: string;
  /** 为 true 表示没有新记录，本次提取被跳过。 */
  skipped?: boolean;
}

/** L2 提取执行器 —— 处理单个会话的记录。 */
export type L2Runner = (sessionKey: string, cursor?: string) => Promise<L2RunnerResult | void>;

/** L3 执行器 —— 基于所有会话的场景数据生成人格画像。 */
export type L3Runner = () => Promise<void>;

/** 持久化会话状态到检查点的回调函数。 */
export type PipelineStatePersister = (states: Record<string, PipelineSessionState>) => Promise<void>;

const TAG = "[memory-tdai] [pipeline]";

// ============================
// 每个会话的定时器状态（仅内存）
// / Per-session timer state (in memory only)
// ============================

interface SessionTimerState {
  /** L1 空闲定时器（可重置）：对会话活动做防抖处理。 */
  l1Idle: ManagedTimer;
  /** L2 调度定时器（只下不）：下次 L2 触发时间，只能提前不能推迟。 */
  l2Schedule: ManagedTimer;
  /** 该会话的 L1 任务是否已入队或正在运行。 */
  l1Queued: boolean;
  /** 该会话的 L2 任务是否已入队或正在运行。 */
  l2Queued: boolean;
  /** L1 连续失败次数，用于重试上限控制。成功或新对话到达时重置。 */
  l1RetryCount: number;
}

export class MemoryPipelineManager {
  // ── 配置（内部转换为毫秒）/ Config (converted to ms internally) ──
  private readonly l1IdleTimeoutMs: number;
  private readonly everyNConversations: number;
  private readonly enableWarmup: boolean;
  private readonly l2DelayAfterL1Ms: number;
  private readonly l2MinIntervalMs: number;
  private readonly l2MaxIntervalMs: number;
  private readonly sessionActiveWindowMs: number;

  /** L1 失败后重试前等待时间（毫秒）。 */
  private readonly L1_RETRY_DELAY_MS = 30_000; // 30 秒
  /** 每个会话 L1 最大连续重试次数，超过后放弃。 */
  private readonly L1_MAX_RETRIES = 5;

  // ── 队列（命名便于诊断）/ Queues (named for diagnostics) ──
  private readonly l1Queue = new SerialQueue("L1");
  private readonly l2Queue = new SerialQueue("L2");
  private readonly l3Queue = new SerialQueue("L3");

  // ── L3 去重标记 ──
  /** L3 是否有待处理的新工作 */
  private l3Pending = false;
  /** L3 是否正在运行中 */
  private l3Running = false;

  // ── 每个会话的状态数据 ──
  private readonly sessionStates = new Map<string, PipelineSessionState>();
  private readonly sessionTimers = new Map<string, SessionTimerState>();

  // 每个会话的消息缓冲区：自上次 L1 运行以来积累的消息
  private readonly messageBuffers = new Map<string, CapturedMessage[]>();

  // 每个会话 L2 上次运行时间（毫秒时间戳，用于 minInterval 下限计算）
  private readonly l2LastRunTime = new Map<string, number>();

  // ── 回调钩子 / Callbacks ──
  private l1Runner: L1Runner | null = null;
  private l2Runner: L2Runner | null = null;
  private l3Runner: L3Runner | null = null;
  private persister: PipelineStatePersister | null = null;
  private logger: Logger | undefined;

  // 统一会话过滤器（内部会话 + excludeAgents）
  private readonly sessionFilter: SessionFilter;

  // ── 生命周期 / Lifecycle ──
  /** 是否已销毁，销毁后拒绝所有新工作 */
  private destroyed = false;

  /** 插件实例 ID，用于指标上报（异步初始化后由外部设置）。 */
  instanceId?: string;

  // ── 会话 GC：定期驱逐内存中的冷却会话 ──
  /** sessionActiveWindowMs 的倍数，确定 GC 回收资格的过期阈值。 */
  private readonly SESSION_GC_INACTIVE_MULTIPLIER = 3;
  /** 每 N 次 notifyConversation 调用运行一次 GC。 */
  private readonly SESSION_GC_EVERY_N_NOTIFICATIONS = 50;
  /** GC 调度计数器。 */
  private notifyCounter = 0;

  /**
   * 构造函数：初始化配置、日志、会话过滤器，并将所有时间单位从秒转换为毫秒。
   */
  constructor(config: PipelineConfig, logger?: Logger, sessionFilter?: SessionFilter) {
    // 将配置中的秒值全部转换为内部使用的毫秒值
    this.l1IdleTimeoutMs = config.l1.idleTimeoutSeconds * 1000;
    this.everyNConversations = config.everyNConversations;
    this.enableWarmup = config.enableWarmup;
    this.l2DelayAfterL1Ms = config.l2.delayAfterL1Seconds * 1000;
    this.l2MinIntervalMs = config.l2.minIntervalSeconds * 1000;
    this.l2MaxIntervalMs = config.l2.maxIntervalSeconds * 1000;
    this.sessionActiveWindowMs = config.l2.sessionActiveWindowHours * 60 * 60 * 1000;
    this.logger = logger;
    this.sessionFilter = sessionFilter ?? new SessionFilter();

    this.logger?.debug?.(
      `${TAG} Initialized: everyNConversations=${config.everyNConversations}, ` +
      `warmup=${config.enableWarmup ? "enabled" : "disabled"}, ` +
      `l1IdleTimeout=${config.l1.idleTimeoutSeconds}s, ` +
      `l2DelayAfterL1=${config.l2.delayAfterL1Seconds}s, ` +
      `l2MinInterval=${config.l2.minIntervalSeconds}s, ` +
      `l2MaxInterval=${config.l2.maxIntervalSeconds}s, ` +
      `sessionActiveWindow=${config.l2.sessionActiveWindowHours}h`,
    );

    // 为队列连接调试日志输出
    if (this.logger?.debug) {
      const debugFn = (msg: string) => this.logger?.debug?.(`${TAG} ${msg}`);
      this.l1Queue.setDebugLogger(debugFn);
      this.l2Queue.setDebugLogger(debugFn);
      this.l3Queue.setDebugLogger(debugFn);
    }
  }

  // ============================
  // 初始化与启动 / Setup
  // ============================

  /** 设置 L1 批量执行器（负责将缓冲消息入库/提取） */
  setL1Runner(runner: L1Runner): void {
    this.l1Runner = runner;
  }

  /** 设置 L2 场景提取执行器 */
  setL2Runner(runner: L2Runner): void {
    this.l2Runner = runner;
  }

  /** 设置 L3 人格生成执行器 */
  setL3Runner(runner: L3Runner): void {
    this.l3Runner = runner;
  }

  /** 设置会话状态持久化回调 */
  setPersister(persister: PipelineStatePersister): void {
    this.persister = persister;
  }

  /**
   * 从检查点恢复会话状态并启动流水线。
   * 有待处理计数的会话将被立即重新入队。
   */
  start(restoredStates?: Record<string, PipelineSessionState>): void {
    if (this.destroyed) return;

    if (restoredStates) {
      let skipped = 0;
      for (const [sessionKey, state] of Object.entries(restoredStates)) {
        // 跳过内部会话（如管理指令、系统会话等）
        if (this.sessionFilter.shouldSkip(sessionKey)) {
          skipped++;
          continue;
        }
        // 回填预热阈值：对于在预热功能上线之前的旧检查点数据，
        // 如果缺少 warmup_threshold 字段，则标记为已毕业（预热完成）
        const patched = { ...state };
        if (patched.warmup_threshold == null) {
          patched.warmup_threshold = 0;
        }
        this.sessionStates.set(sessionKey, patched);
      }
      this.logger?.info(
        `${TAG} Restored ${this.sessionStates.size} session state(s) from checkpoint` +
        (skipped > 0 ? ` (filtered ${skipped} internal)` : ""),
      );
    }

    // 恢复：重新入队有待处理工作的会话
    this.recoverPendingSessions();

    this.logger?.info(`${TAG} Pipeline started`);
  }

  // ============================
  // L0→L1：通知阶段（由 auto-capture 在 agent_end 事件时调用）
  // / L0→L1: Notify (called from auto-capture on agent_end)
  // ============================

  /**
   * 获取会话的有效触发阈值，考虑预热模式。
   *
   * 预热模式下，新会话从阈值=1 开始，每次成功 L1 后翻倍：
   * 1 → 2 → 4 → 8 → ... → everyNConversations。
   * 一旦阈值达到 everyNConversations，预热完成（warmup_threshold 设为 0），
   * 之后使用固定配置值。
   */
  private getEffectiveThreshold(state: PipelineSessionState): number {
    if (!this.enableWarmup) return this.everyNConversations;
    // warmup_threshold === 0 means warm-up completed; use steady-state config
    if (state.warmup_threshold <= 0) return this.everyNConversations;
    return Math.min(state.warmup_threshold, this.everyNConversations);
  }

  /**
   * L1 成功后推进预热阈值。将阈值翻倍直到达到 everyNConversations，
   * 然后标记预热完成（warmup_threshold = 0）。
   */
  private advanceWarmupThreshold(state: PipelineSessionState): void {
    if (!this.enableWarmup) return;
    if (state.warmup_threshold <= 0) return; // already graduated

    const next = state.warmup_threshold * 2;
    if (next >= this.everyNConversations) {
      // Graduated: switch to steady-state
      state.warmup_threshold = 0;
      this.logger?.debug?.(`${TAG} Warm-up graduated → using steady-state threshold ${this.everyNConversations}`);
    } else {
      state.warmup_threshold = next;
      this.logger?.debug?.(`${TAG} Warm-up advanced → next threshold ${next}`);
    }
  }

  /**
   * 通知流水线：某个会话的一轮对话已结束，将捕获的消息缓冲起来等待 L1 批量处理。
   *
   * 从此处产生两条触发路径：
   * - **路径 A（阈值触发）**：如果 conversation_count >= 有效阈值（预热或稳态），
   *   立即触发 L1 并携带所有缓冲消息。
   * - **路径 B（空闲触发）**：重置 L1 空闲定时器。当用户停止聊天、定时器触发时，
   *   L1 用当前已缓冲的消息运行。
   */
  async notifyConversation(sessionKey: string, messages: CapturedMessage[]): Promise<void> {
    if (this.destroyed) return;
    if (this.sessionFilter.shouldSkip(sessionKey)) return;

    const state = this.getOrCreateState(sessionKey);
    state.conversation_count += 1;
    state.last_active_time = Date.now();

    // 新对话到达时重置 L1 重试计数（环境可能已经恢复）
    const timers = this.getOrCreateTimers(sessionKey);
    timers.l1RetryCount = 0;

    // 将消息追加到缓冲区，等待 L1 批量处理
    const buffer = this.messageBuffers.get(sessionKey) ?? [];
    buffer.push(...messages);
    this.messageBuffers.set(sessionKey, buffer);

    const effectiveThreshold = this.getEffectiveThreshold(state);
    const warmupInfo = this.enableWarmup && state.warmup_threshold > 0
      ? ` (warmup: ${state.warmup_threshold})`
      : "";

    this.logger?.debug?.(
      `${TAG} [${sessionKey}] notify: conversation_count=${state.conversation_count}/${effectiveThreshold}${warmupInfo}, ` +
      `buffered_messages=${buffer.length} (+${messages.length} new)`,
    );

    // 持久化当前状态到检查点
    await this.persistStates();

    // 路径 A：对话轮次达到有效阈值 → 立即触发 L1 批量处理
    if (state.conversation_count >= effectiveThreshold) {
      this.logger?.debug?.(
        `${TAG} [${sessionKey}] Conversation threshold reached (${state.conversation_count}>=${effectiveThreshold}${warmupInfo}), triggering L1`,
      );
      this.enqueueL1(sessionKey);
      return; // 跳过空闲定时器重置 —— L1 已经被触发
    }

    // 路径 B：未达阈值 → 重置 L1 空闲定时器（稍后通过空闲超时兜底处理）
    timers.l1Idle.schedule(this.l1IdleTimeoutMs, () => this.onL1IdleTimeout(sessionKey));
    this.logger?.debug?.(
      `${TAG} [${sessionKey}] L1 idle timer reset (${this.l1IdleTimeoutMs / 1000}s)`,
    );

    // 定期 GC：驱逐内存中的冷却会话
    this.notifyCounter += 1;
    if (this.notifyCounter >= this.SESSION_GC_EVERY_N_NOTIFICATIONS) {
      this.notifyCounter = 0;
      this.gcStaleSessions();
    }
  }

  // ============================
  // 优雅关闭 / Graceful shutdown
  // ============================

  /**
   * 单会话冲刷 —— 作用域为单个会话的结束处理。
   *
   * 与 {@link destroy} 的语义区别：
   *   - `destroy` 拆除**整个**调度器（用于进程级关闭，如 OpenClaw 的
   *     `gateway_stop`）。
   *   - `flushSession` 仅处理 `sessionKey` 指定的那一个会话，其他会话的
   *     定时器、缓冲区和流水线状态保持不变。这是 Gateway 的
   *     `POST /session/end` 端点和 Hermes 的 `on_session_end` 回调的
   *     正确语义 —— 它们在一个对话结束、但进程继续服务其他并发会话时触发。
   *
   * 具体行为：
   *   1. 取消该会话的 L1 空闲定时器（不再为此会话触发空闲回调）。
   *   2. 如果该会话的消息缓冲区仍有待处理数据，立即入队一个 L1 运行
   *      (`triggerReason="flush"`)。
   *   3. 等待共享的 `l1Queue` 排空，让调用方在返回前能够观测到 L1 完成。
   *      由于 L1 已经是单消费者的 SerialQueue，等待 `onIdle` 是最经济的
   *      正确信号。
   *
   * 故意不做的事情：
   *   - 不触碰其他会话的定时器 / 缓冲区 / 流水线状态。
   *   - 不销毁调度器或其任何队列。
   *   - 不重置 `destroyed` 等全局字段。
   *
   * 未知的 sessionKey 是无操作：调度器可能已通过 GC 回收了该会话，
   * 或者该会话从未产生过任何捕获。
   */
  async flushSession(sessionKey: string): Promise<void> {
    if (this.destroyed) return;
    if (this.sessionFilter.shouldSkip(sessionKey)) return;

    const timers = this.sessionTimers.get(sessionKey);
    const buffer = this.messageBuffers.get(sessionKey);

    // 步骤1：取消空闲定时器，确保返回后不会再触发
    if (timers?.l1Idle.pending) {
      timers.l1Idle.cancel();
    }

    // 步骤2：将缓冲区中待处理的消息通过 L1 冲刷处理
    if (buffer && buffer.length > 0) {
      this.logger?.debug?.(
        `${TAG} [${sessionKey}] flushSession: enqueuing L1 for ${buffer.length} buffered message(s)`,
      );
      this.enqueueL1(sessionKey, "flush");
    }

    // 步骤3：等待 L1 排空。L1 是单消费者 SerialQueue，
    // 这是最经济的正确等待信号；不会饿死其他会话，
    // 因为跨会话的 L1 工作要么已经入队，要么由各自捕获路径并发入队。
    await this.l1Queue.onIdle();

    this.logger?.debug?.(`${TAG} [${sessionKey}] flushSession: complete`);
  }

  /**
   * destroy 的最大等待时间（毫秒）。
   * 必须短于 gateway_stop hook 的超时（3 秒），
   * 以便为后续的 VectorStore / EmbeddingService 清理留出余量。
   */
  private readonly DESTROY_TIMEOUT_MS = 2_000;

  /**
   * 带超时保护的优雅关闭：
   * 1. 标记为已销毁，停止接收新工作
   * 2. 在 DESTROY_TIMEOUT_MS 内尝试冲刷所有待处理的 L1/L2/L3 工作
   * 3. 如果冲刷超时或失败，持久化当前状态以便下次启动时恢复
   * 4. 待处理工作永不丢失 —— 下次 start() 时会通过检查点恢复
   */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    this.logger?.info(
      `${TAG} Destroying pipeline (timeout=${this.DESTROY_TIMEOUT_MS}ms)...`,
    );

    try {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      // 竞速：_doFlush 必须在超时前完成
      await Promise.race([
        this._doFlush(),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error("destroy timeout")), this.DESTROY_TIMEOUT_MS);
        }),
      ]).finally(() => {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      });
      this.logger?.info(`${TAG} Pipeline flushed successfully`);
    } catch (err) {
      this.logger?.warn(
        `${TAG} Pipeline flush timed out or failed: ${err instanceof Error ? err.message : String(err)}. ` +
        `Pending work will be recovered on next startup.`,
      );
    }

    // 无论冲刷成功、超时还是失败，都要持久化状态。
    // 这确保待处理工作（缓冲消息、L2 待处理计数）保存到检查点，
    // 可以在下次 start() 时通过 recoverPendingSessions() 恢复。
    try {
      await this.persistStates();
    } catch (err) {
      this.logger?.error(
        `${TAG} Failed to persist states during destroy: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.logger?.info(`${TAG} Pipeline destroyed`);
  }

  /**
   * 内部方法：尝试冲刷所有待处理的流水线工作（L1 → L2 → L3）。
   * 从 destroy() 中抽离出来，以便可以用超时包装。
   */
  private async _doFlush(): Promise<void> {
    // 步骤1：冲刷所有 L1 空闲定时器 —— 仅当有缓冲消息时才入队
    for (const [sessionKey, timers] of this.sessionTimers) {
      if (timers.l1Idle.pending) {
        timers.l1Idle.cancel(); // 不直接触发空闲回调，而是通过队列处理
        const buffer = this.messageBuffers.get(sessionKey);
        if (buffer && buffer.length > 0) {
          this.logger?.debug?.(`${TAG} [${sessionKey}] Flush: enqueuing L1 for ${buffer.length} buffered messages`);
          this.enqueueL1(sessionKey, "flush");
        }
      }
    }

    // 步骤2：等待 L1 队列排空
    this.logger?.debug?.(`${TAG} Waiting for L1 queue to drain (size=${this.l1Queue.size})`);
    await this.l1Queue.onIdle();

    // 步骤3：冲刷所有 L2 调度定时器
    for (const [sessionKey, timers] of this.sessionTimers) {
      if (timers.l2Schedule.pending) {
        this.logger?.debug?.(`${TAG} [${sessionKey}] Flush: triggering L2 schedule timer`);
        timers.l2Schedule.flush();
      }
    }

    // 步骤4：等待所有剩余队列排空
    this.logger?.debug?.(`${TAG} Waiting for queues to drain (l2=${this.l2Queue.size}, l3=${this.l3Queue.size})`);
    await Promise.all([
      this.l2Queue.onIdle(),
      this.l3Queue.onIdle(),
    ]);
  }

  // ============================
  // 内部：L1 空闲超时处理器
  // / Internal: L1 idle timeout handler
  // ============================

  /** L1 空闲定时器触发时的回调：检查是否有待处理消息，有则入队 L1 */
  private onL1IdleTimeout(sessionKey: string): void {
    const buffer = this.messageBuffers.get(sessionKey);
    const state = this.sessionStates.get(sessionKey);

    // 既没缓冲消息也没待处理对话轮次，无需处理
    if ((!buffer || buffer.length === 0) && (!state || state.conversation_count === 0)) {
      this.logger?.debug?.(
        `${TAG} [${sessionKey}] L1 idle timeout but no pending messages or conversations`,
      );
      return;
    }

    this.logger?.debug?.(
      `${TAG} [${sessionKey}] L1 idle timeout fired (buffered=${buffer?.length ?? 0}, conversations=${state?.conversation_count ?? 0})`,
    );
    this.enqueueL1(sessionKey, "idle_timeout");
  }

  // ============================
  // 内部：L1 队列 / Internal: L1 queue
  // ============================

  /**
   * 将 L1 任务入队。
   * @param triggerReason 触发原因：threshold（阈值）/ idle_timeout（空闲超时）/ flush（冲刷）
   */
  private enqueueL1(sessionKey: string, triggerReason: "threshold" | "idle_timeout" | "flush" = "threshold"): void {
    const timers = this.getOrCreateTimers(sessionKey);

    // 防止重复入队
    if (timers.l1Queued) {
      this.logger?.debug?.(`${TAG} [${sessionKey}] L1 already queued, skipping`);
      return;
    }

    // 如果空闲定时器还在运行，取消它（阈值触发比空闲定时器更早到达）
    timers.l1Idle.cancel();

    timers.l1Queued = true;
    this.logger?.debug?.(`${TAG} [${sessionKey}] Enqueuing L1 (queue=${this.l1Queue.name})`);

    // ── pipeline_l1_trigger 指标上报 ──
    const state = this.sessionStates.get(sessionKey);
    const buffer = this.messageBuffers.get(sessionKey);
    if (this.instanceId && this.logger) {
      report("pipeline_l1_trigger", {
        sessionKey,
        triggerReason,
        conversationCount: state?.conversation_count ?? 0,
        bufferedMessageCount: buffer?.length ?? 0,
      });
    }

    this.l1Queue.add(async () => {
      await this.runL1(sessionKey);
    }).catch((err) => {
      this.logger?.error(
        `${TAG} [${sessionKey}] L1 task failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
      );
    }).finally(() => {
      timers.l1Queued = false;
    });
  }

  /**
   * L1 执行逻辑：取出某会话的所有缓冲消息，传给 L1Runner 做批量处理
   * （例如 appendEvent 入库，或本地提取逻辑）。
   *
   * L1 成功后：
   * - conversation_count 和消息缓冲区被重置
   * - L2 定时器被提前（只下不），以便后续进行远程记录生成
   *
   * L1 失败时：
   * - conversation_count 和缓冲区保留，等待下次空闲超时或阈值触发时重试
   */
  private async runL1(sessionKey: string): Promise<void> {
    const state = this.sessionStates.get(sessionKey);
    if (!state) return;

    // 清空消息缓冲区（取走所有权，清空共享引用）
    const buffer = this.messageBuffers.get(sessionKey) ?? [];
    this.messageBuffers.set(sessionKey, []);

    if (buffer.length === 0 && state.conversation_count === 0) {
      this.logger?.debug?.(`${TAG} [${sessionKey}] L1 skipped: no messages and no pending conversations`);
      return;
    }

    this.logger?.debug?.(
      `${TAG} [${sessionKey}] L1 running: messages=${buffer.length}, conversation_count=${state.conversation_count}`,
    );

    // 未设置 L1 执行器时：直接跳过执行，但状态照常推进
    if (!this.l1Runner) {
      this.logger?.warn(`${TAG} [${sessionKey}] No L1 runner set, skipping`);
      state.l2_pending_l1_count = state.conversation_count;
      state.conversation_count = 0;
      this.advanceWarmupThreshold(state);
      await this.persistStates();
      this.advanceL2Timer(sessionKey);
      return;
    }

    try {
      // 调用实际的 L1 执行器（例如 appendEvent 入库）
      await this.l1Runner({
        sessionKey,
        msg: buffer,
        bg_msg: [], // 预留字段，未来用于背景上下文
      });

      this.logger?.debug?.(
        `${TAG} [${sessionKey}] L1 complete: processed ${buffer.length} messages`,
      );
    } catch (err) {
      this.logger?.error(
        `${TAG} [${sessionKey}] L1 runner failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
      );
      // 失败时：将消息放回缓冲区以便重试
      const currentBuffer = this.messageBuffers.get(sessionKey) ?? [];
      this.messageBuffers.set(sessionKey, [...buffer, ...currentBuffer]);
      this.logger?.debug?.(
        `${TAG} [${sessionKey}] L1 failure: restored ${buffer.length} messages to buffer (total=${buffer.length + currentBuffer.length})`,
      );

      // 重新激活 L1 空闲定时器，实现自动重试（受最大重试次数限制）
      const timers = this.getOrCreateTimers(sessionKey);
      timers.l1RetryCount += 1;
      if (timers.l1RetryCount <= this.L1_MAX_RETRIES) {
        timers.l1Idle.schedule(this.L1_RETRY_DELAY_MS, () => this.onL1IdleTimeout(sessionKey));
        this.logger?.debug?.(
          `${TAG} [${sessionKey}] L1 retry scheduled in ${this.L1_RETRY_DELAY_MS / 1000}s ` +
          `(attempt ${timers.l1RetryCount}/${this.L1_MAX_RETRIES})`,
        );
      } else {
        this.logger?.warn(
          `${TAG} [${sessionKey}] L1 max retries reached (${this.L1_MAX_RETRIES}), ` +
          `giving up auto-retry. ${buffer.length + currentBuffer.length} messages remain buffered. ` +
          `Will resume on next user conversation.`,
        );
      }

      return; // 不推进状态，不触发 L2
    }

    // 成功：重置重试计数并推进状态
    const timers = this.getOrCreateTimers(sessionKey);
    timers.l1RetryCount = 0;
    state.l2_pending_l1_count = state.conversation_count;
    state.conversation_count = 0;
    this.advanceWarmupThreshold(state);
    await this.persistStates();

    // 将 L2 定时器提前（只下不），在延迟后触发，同时遵守 minInterval
    this.advanceL2Timer(sessionKey);
  }

  // ============================
  // 内部：L2 定时器管理（只下不语义 / downward-only）
  // / Internal: L2 timer management (downward-only)
  // ============================

  /**
   * L1 事件（新记忆生成）后将当前会话的 L2 定时器提前。
   *
   * 计算期望触发时间公式：
   *   T_desired = max(now + l2DelayAfterL1, lastL2Time + l2MinInterval)
   *
   * 仅当 T_desired 早于当前调度时间时才移动定时器（只下不语义）。
   * 如果没有待处理的定时器，则无条件设置。
   */
  private advanceL2Timer(sessionKey: string): void {
    if (this.destroyed) return;

    const timers = this.getOrCreateTimers(sessionKey);
    const now = Date.now();

    // Compute the floor: lastL2 + minInterval (rate-limit protection)
    const lastL2 = this.l2LastRunTime.get(sessionKey) ?? 0;
    const minIntervalFloor = lastL2 > 0 ? lastL2 + this.l2MinIntervalMs : 0;

    // Desired fire time: delay after L1, but no earlier than minInterval floor
    const desiredTime = Math.max(now + this.l2DelayAfterL1Ms, minIntervalFloor);

    const advanced = timers.l2Schedule.tryAdvanceTo(desiredTime, () => this.onL2TimerFired(sessionKey, "delay-after-l1"));

    if (advanced) {
      const delaySec = Math.round((desiredTime - now) / 1000);
      this.logger?.debug?.(
        `${TAG} [${sessionKey}] L2 timer advanced: firing in ${delaySec}s` +
        (timers.l2Schedule.scheduledTime > 0
          ? ` (was ${Math.round((timers.l2Schedule.scheduledTime - now) / 1000)}s)`
          : " (newly armed)"),
      );
    } else {
      this.logger?.debug?.(
        `${TAG} [${sessionKey}] L2 timer not advanced: current schedule is already earlier`,
      );
    }
  }

  /**
   * L2 完成后设置最大间隔兜底定时器。
   * 无条件设置 T = now + l2MaxInterval，替换任何待处理的定时器。
   */
  private armL2MaxInterval(sessionKey: string): void {
    if (this.destroyed) return;

    const timers = this.getOrCreateTimers(sessionKey);
    const fireAt = Date.now() + this.l2MaxIntervalMs;
    timers.l2Schedule.scheduleAt(fireAt, () => this.onL2TimerFired(sessionKey, "max-interval"));

    this.logger?.debug?.(
      `${TAG} [${sessionKey}] L2 maxInterval timer armed: ${Math.round(this.l2MaxIntervalMs / 1000)}s`,
    );
  }

  /**
   * 每个会话的 L2 定时器触发时的回调。
   *
   * 检查会话活跃度：如果会话已冷却（不活跃 > activeWindow），
   * 不会重新激活定时器 —— 它将由下一次 L1 事件恢复。
   * 否则，将 L2 入队。
   *
   * `source` 参数区分触发来源：
   * - "delay-after-l1"：L1 完成后不久触发 —— 跳过冷却检查，
   *   因为 L1 完成本身就证明了最近的活跃度。
   * - "max-interval"：周期性定时器 —— 正常应用冷却检查。
   */
  private onL2TimerFired(sessionKey: string, source: "delay-after-l1" | "max-interval"): void {
    const state = this.sessionStates.get(sessionKey);
    if (!state) return;

    const now = Date.now();

    // Cold session check: only applies to periodic (maxInterval) triggers.
    // Delay-after-L1 triggers are exempt because L1 just completed, proving
    // the session was recently active.
    if (source === "max-interval" && now - state.last_active_time >= this.sessionActiveWindowMs) {
      this.logger?.debug?.(
        `${TAG} [${sessionKey}] L2 timer fired but session is cold ` +
        `(inactive ${Math.round((now - state.last_active_time) / 3600_000)}h), timer stopped. ` +
        `Will re-arm on next L1 event.`,
      );
      return; // timer not re-armed — advanceL2Timer() in runL1 will revive it
    }

    this.enqueueL2(sessionKey, `timer:${source}`);
  }

  // ============================
  // 内部：L2 队列 / Internal: L2 queue
  // ============================

  /**
   * 将 L2 任务入队。
   * @param trigger 触发原因标识，用于日志诊断
   */
  private enqueueL2(sessionKey: string, trigger: string): void {
    const timers = this.getOrCreateTimers(sessionKey);

    // 取消任何待处理的 L2 定时器（马上就要运行 L2 了）
    timers.l2Schedule.cancel();

    // 冲突检测：如果 L2 已入队则跳过并告警
    if (timers.l2Queued) {
      this.logger?.warn(
        `${TAG} [${sessionKey}] L2 enqueue conflict on queue "${this.l2Queue.name}": ` +
        `task already queued/running (trigger=${trigger}), skipping`,
      );
      return;
    }

    timers.l2Queued = true;
    this.logger?.debug?.(`${TAG} [${sessionKey}] Enqueuing L2 (trigger=${trigger}, queue=${this.l2Queue.name})`);

    this.l2Queue.add(async () => {
      await this.runL2(sessionKey);
    }).catch((err) => {
      this.logger?.error(
        `${TAG} [${sessionKey}] L2 task failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
      );
    }).finally(() => {
      timers.l2Queued = false;
    });
  }

  /**
   * L2 执行逻辑：调用 L2Runner 对单个会话进行场景提取。
   */
  private async runL2(sessionKey: string): Promise<void> {
    const state = this.sessionStates.get(sessionKey);
    if (!state) return;

    if (!this.l2Runner) {
      this.logger?.warn(`${TAG} [${sessionKey}] No L2 runner set, skipping`);
      return;
    }

    this.logger?.debug?.(
      `${TAG} [${sessionKey}] L2 running: l2_pending_l1_count=${state.l2_pending_l1_count}`,
    );

    // 使用上次提取的游标，实现增量提取
    const cursor = state.last_extraction_updated_time || undefined;

    let result: L2RunnerResult | void;
    try {
      result = await this.l2Runner(sessionKey, cursor);
    } catch (err) {
      this.logger?.error(
        `${TAG} [${sessionKey}] L2 runner failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
      );
      // 即使失败也设置 maxInterval 兜底，保证最终会重试
      this.armL2MaxInterval(sessionKey);
      return;
    }

    // L2 完成后：更新状态
    const now = Date.now();
    state.l2_pending_l1_count = 0;

    // 冷启动优化：如果这是该会话的首次 L2 运行且被跳过（无新记录），
    // 则不更新 l2LastRunTime。这避免了 minInterval 在首次 L1 提取
    // 刚产生实际记忆时阻止下一次 L2 触发。
    const isFirstL2 = !this.l2LastRunTime.has(sessionKey);
    const wasSkipped = result?.skipped === true;

    if (isFirstL2 && wasSkipped) {
      this.logger?.info?.(
        `${TAG} [${sessionKey}] L2 cold-start skip: not updating l2LastRunTime ` +
        `(minInterval won't block next trigger)`,
      );
      this.armL2MaxInterval(sessionKey);
      await this.persistStates();
      return;
    }

    state.last_extraction_time = new Date().toISOString();
    state.l2_last_extraction_time = new Date().toISOString();
    this.l2LastRunTime.set(sessionKey, now);

    // 使用执行器返回的记录时间戳推进游标
    if (result?.latestCursor) {
      state.last_extraction_updated_time = result.latestCursor;
    } else if (!state.last_extraction_updated_time) {
      // 冷启动保护：如果执行器返回 void（如提取失败）且游标仍为空，
      // 将其初始化为当前时间，避免下次 L2 运行做全表扫描。
      state.last_extraction_updated_time = new Date().toISOString();
    }

    await this.persistStates();

    this.logger?.debug?.(`${TAG} [${sessionKey}] L2 complete`);

    // 设置 maxInterval 兜底定时器，为下一个周期做准备
    this.armL2MaxInterval(sessionKey);

    // 触发 L3 人格生成
    this.triggerL3();
  }

  // ============================
  // 内部：L3 队列（全局互斥 + 去重）
  // / Internal: L3 queue (global, dedup)
  // ============================

  /**
   * 触发 L3 人格生成。
   * 如果 L3 正在运行，则标记 pending=true，等当前运行结束后自动再次运行。
   */
  private triggerL3(): void {
    if (this.destroyed) return;

    if (this.l3Running) {
      // L3 正在运行 —— 标记 pending，等当前运行完后再执行
      this.l3Pending = true;
      this.logger?.debug?.(`${TAG} L3 already running, marking pending`);
      return;
    }

    this.logger?.debug?.(`${TAG} Triggering L3`);
    this.enqueueL3();
  }

  /** 将 L3 任务入队，设置运行标记 */
  private enqueueL3(): void {
    this.l3Running = true;
    this.l3Pending = false;

    this.logger?.debug?.(`${TAG} Enqueuing L3 (queue=${this.l3Queue.name})`);

    this.l3Queue.add(async () => {
      await this.runL3();
    }).catch((err) => {
      this.logger?.error(
        `${TAG} L3 task failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
      );
    }).finally(() => {
      this.l3Running = false;

      // L3 运行期间如果有新的 L2 完成，则再次运行 L3
      if (this.l3Pending && !this.destroyed) {
        this.logger?.debug?.(`${TAG} L3 has pending work, re-running`);
        this.enqueueL3();
      }
    });
  }

  /** L3 执行逻辑：调用 L3Runner 基于所有会话的场景数据生成人格画像 */
  private async runL3(): Promise<void> {
    if (!this.l3Runner) {
      this.logger?.warn(`${TAG} No L3 runner set, skipping`);
      return;
    }

    this.logger?.debug?.(`${TAG} L3 running`);
    try {
      await this.l3Runner();
      this.logger?.debug?.(`${TAG} L3 complete`);
    } catch (err) {
      this.logger?.error(
        `${TAG} L3 runner failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
      );
    }
  }

  // ============================
  // Internal: state management
  // ============================

  private getOrCreateState(sessionKey: string): PipelineSessionState {
    let state = this.sessionStates.get(sessionKey);
    if (!state) {
      state = {
        conversation_count: 0,
        last_extraction_time: "",
        last_extraction_updated_time: "",
        last_active_time: Date.now(),
        l2_pending_l1_count: 0,
        warmup_threshold: this.enableWarmup ? 1 : 0,
        l2_last_extraction_time: "",
      };
      this.sessionStates.set(sessionKey, state);
      this.logger?.debug?.(`${TAG} [${sessionKey}] Created new session state`);
    }
    return state;
  }

  private getOrCreateTimers(sessionKey: string): SessionTimerState {
    let timers = this.sessionTimers.get(sessionKey);
    if (!timers) {
      const isDestroyed = () => this.destroyed;
      timers = {
        l1Idle: new ManagedTimer(`L1-idle:${sessionKey}`, isDestroyed),
        l2Schedule: new ManagedTimer(`L2-schedule:${sessionKey}`, isDestroyed),
        l1Queued: false,
        l2Queued: false,
        l1RetryCount: 0,
      };
      this.sessionTimers.set(sessionKey, timers);
    }
    return timers;
  }

  private async persistStates(): Promise<void> {
    if (!this.persister) return;

    // PipelineSessionState only contains pipeline-owned fields, so we can
    // safely persist the entire object without risk of overwriting runner state.
    const obj: Record<string, PipelineSessionState> = {};
    for (const [k, v] of this.sessionStates) {
      obj[k] = { ...v };
    }
    try {
      this.logger?.debug?.(`Persisting states: ${JSON.stringify(obj)}`);
      await this.persister(obj);
    } catch (err) {
      this.logger?.error(
        `${TAG} Failed to persist states: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Evict cold sessions from in-memory maps to prevent unbounded growth.
   *
   * A session is eligible for GC when:
   * 1. Inactive for > sessionActiveWindowMs * SESSION_GC_INACTIVE_MULTIPLIER
   * 2. No queued/running L1 or L2 tasks
   * 3. No buffered messages pending processing
   *
   * Evicted sessions can be fully restored from checkpoint on next
   * `notifyConversation()` (state) or `start()` (recovery).
   */
  private gcStaleSessions(): void {
    const now = Date.now();
    const maxInactiveMs = this.sessionActiveWindowMs * this.SESSION_GC_INACTIVE_MULTIPLIER;
    let evictedCount = 0;

    for (const [sessionKey, state] of this.sessionStates) {
      if (now - state.last_active_time < maxInactiveMs) continue;

      // Safety: don't evict sessions with active work
      const timers = this.sessionTimers.get(sessionKey);
      if (timers?.l1Queued || timers?.l2Queued) continue;

      const buffer = this.messageBuffers.get(sessionKey);
      if (buffer && buffer.length > 0) continue;

      // Evict: cancel any pending timers, then remove from all maps
      if (timers) {
        timers.l1Idle.cancel();
        timers.l2Schedule.cancel();
      }
      this.sessionStates.delete(sessionKey);
      this.sessionTimers.delete(sessionKey);
      this.messageBuffers.delete(sessionKey);
      this.l2LastRunTime.delete(sessionKey);
      evictedCount++;
    }

    if (evictedCount > 0) {
      this.logger?.debug?.(
        `${TAG} Session GC: evicted ${evictedCount} cold session(s), ` +
        `${this.sessionStates.size} remaining`,
      );
    }
  }

  /**
   * Recovery: re-enqueue sessions that have pending work from before restart.
   *
   * On restart, message buffers are empty (in-memory only). Sessions with
   * non-zero conversation_count had messages that were either:
   * 1. Already processed by L1 (l2_pending_l1_count > 0) → arm L2 timer
   * 2. Never reached L1 (conversation_count > 0, messages lost) → arm L2
   *    as best-effort recovery
   *
   * We arm L2 timers (with delay) rather than enqueuing immediately,
   * because the pipeline may be starting during management commands.
   */
  private recoverPendingSessions(): void {
    for (const [sessionKey, state] of this.sessionStates) {
      if (state.conversation_count === 0 && state.l2_pending_l1_count === 0) continue;

      this.logger?.debug?.(
        `${TAG} [${sessionKey}] Recovery: conversation_count=${state.conversation_count}, ` +
        `l2_pending_l1_count=${state.l2_pending_l1_count}, arming L2 timer`,
      );

      // Reset conversation_count since we can't recover the messages
      state.l2_pending_l1_count = Math.max(state.l2_pending_l1_count, state.conversation_count);
      state.conversation_count = 0;

      // Arm L2 timer with delay (gives the system time to fully start)
      this.advanceL2Timer(sessionKey);
    }
  }

  // ============================
  // Public accessors (for testing / status)
  // ============================

  /** Get the pipeline session state for a session (read-only copy). */
  getSessionState(sessionKey: string): PipelineSessionState | undefined {
    const state = this.sessionStates.get(sessionKey);
    return state ? { ...state } : undefined;
  }

  /** Get the buffered message count for a session. */
  getBufferedMessageCount(sessionKey: string): number {
    return this.messageBuffers.get(sessionKey)?.length ?? 0;
  }

  /** Get all session keys being tracked. */
  getSessionKeys(): string[] {
    return Array.from(this.sessionStates.keys());
  }

  /** Whether the pipeline has been destroyed. */
  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /** Queue sizes and running state for monitoring. */
  getQueueSizes(): {
    l1: number; l2: number; l3: number;
    l1Pending: boolean; l2Pending: boolean; l3Pending: boolean;
    l1Idle: boolean; l2Idle: boolean; l3Idle: boolean;
  } {
    return {
      l1: this.l1Queue.size,
      l2: this.l2Queue.size,
      l3: this.l3Queue.size,
      l1Pending: this.l1Queue.pending,
      l2Pending: this.l2Queue.pending,
      l3Pending: this.l3Queue.pending,
      l1Idle: this.l1Queue.idle,
      l2Idle: this.l2Queue.idle,
      l3Idle: this.l3Queue.idle,
    };
  }
}

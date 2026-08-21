/**
 * Checkpoint management for tracking memory processing progress.
 *
 * ## Split-state design
 *
 * Per-session state is split into two independent namespaces to prevent
 * the PipelineManager and L0/L1 runners from overwriting each other's fields:
 *
 * - **runner_states** (`RunnerSessionState`): owned by CheckpointManager methods
 *   (markL1*, advanceSession*). Contains L0 capture cursor, L1 cursor, scene name.
 *
 * - **pipeline_states** (`PipelineSessionState`): owned exclusively by
 *   PipelineManager via `mergePipelineStates()`. Contains conversation_count,
 *   extraction times, L2 tracking fields.
 *
 * Each side only reads/writes its own namespace, eliminating the split-brain
 * overwrite bug where pipeline persistStates() could clobber runner-written fields.
 *
 * ## Concurrency safety
 *
 * All mutating methods (read-modify-write) are serialized via a per-file async lock.
 * Multiple CheckpointManager instances sharing the same file path automatically share
 * the same lock, so callers can freely `new CheckpointManager()` without coordination.
 * Writes use atomic tmp+rename to prevent corruption on crash.
 */

import { randomBytes } from "node:crypto";
import type { StorageAdapter } from "../core/storage/adapter.js";
import { StoragePaths } from "../core/storage/types.js";

// ============================
// Types
// ============================

/**
 * Per-session state managed by L0/L1 runners (written directly to checkpoint).
 * These fields are ONLY written by CheckpointManager methods (markL1*, advanceSession*, etc.)
 * and are NEVER touched by the PipelineManager's persistStates().
 */
export interface RunnerSessionState {
  // ═══ L0 — per-session capture cursor ═══
  /** Epoch ms of the newest message captured for THIS session.
   *  Used instead of the global `Checkpoint.last_captured_timestamp` so that
   *  concurrent sessions don't advance each other's cursors and cause missed messages. */
  last_captured_timestamp: number;

  // ═══ L1 — cursor & continuity ═══
  /** L0 JSONL cursor: epoch ms of last message processed by L1 */
  last_l1_cursor: number;
  /** Last scene name from the most recent L1 extraction (for cross-batch continuity) */
  last_scene_name: string;
}

/**
 * Per-session state managed exclusively by PipelineManager (written via mergePipelineStates).
 * These fields are ONLY written by the pipeline's persistStates() callback
 * and are NEVER touched by CheckpointManager's L0/L1 methods.
 */
export interface PipelineSessionState {
  /** Conversation rounds since last L1 trigger */
  conversation_count: number;
  /** ISO timestamp of the last extraction completion */
  last_extraction_time: string;
  /** ISO timestamp cursor for incremental extraction reads */
  last_extraction_updated_time: string;
  /** Epoch ms of the last notifyConversation call */
  last_active_time: number;
  /** Mirrors conversation_count at L1 completion time (for L2 tracking) */
  l2_pending_l1_count: number;
  /**
   * Current warm-up threshold for L1 triggering.
   * Starts at 1 for new sessions and doubles after each L1 completion
   * (1 → 2 → 4 → 8 → ...) until it reaches everyNConversations.
   * 0 means warm-up is complete (use everyNConversations directly).
   */
  warmup_threshold: number;
  /** ISO timestamp of last L2 extraction completion */
  l2_last_extraction_time: string;
}

export interface Checkpoint {
  // ═══ Global counters ═══
  /** Epoch ms of the newest message successfully uploaded. Messages with ts > this are new. */
  last_captured_timestamp: number;
  /** Total messages processed across all time */
  total_processed: number;
  last_persona_at: number;
  last_persona_time: string;
  request_persona_update: boolean;
  persona_update_reason: string;
  memories_since_last_persona: number;
  scenes_processed: number;

  // ═══ Per-session split state ═══
  /** Runner-managed per-session state (L0 capture cursor, L1 cursor, scene name).
   *  Written ONLY by CheckpointManager methods. */
  runner_states: Record<string, RunnerSessionState>;
  /** Pipeline-managed per-session state (conversation_count, extraction times, etc.).
   *  Written ONLY by the pipeline's mergePipelineStates(). */
  pipeline_states: Record<string, PipelineSessionState>;

  // ═══ L0 ═══
  /** Total L0 conversation files recorded */
  l0_conversations_count: number;

  // ═══ L1 ═══
  /** Total L1 memories extracted across all time */
  total_memories_extracted: number;
}

const DEFAULT_RUNNER_STATE: RunnerSessionState = {
  last_captured_timestamp: 0,
  last_l1_cursor: 0,
  last_scene_name: "",
};

const DEFAULT_PIPELINE_STATE: PipelineSessionState = {
  conversation_count: 0,
  last_extraction_time: "",
  last_extraction_updated_time: "",
  last_active_time: 0,
  l2_pending_l1_count: 0,
  warmup_threshold: 0, // 0 = graduated (safe default for old sessions missing this field)
  l2_last_extraction_time: "",
};

const DEFAULT_CHECKPOINT: Checkpoint = {
  last_captured_timestamp: 0,
  total_processed: 0,
  last_persona_at: 0,
  last_persona_time: "",
  request_persona_update: false,
  persona_update_reason: "",
  memories_since_last_persona: 0,
  scenes_processed: 0,
  runner_states: {},
  pipeline_states: {},
  l0_conversations_count: 0,
  total_memories_extracted: 0,
};

export interface CheckpointLogger {
  info(msg: string): void;
  warn?(msg: string): void;
}

const noopLogger: CheckpointLogger = { info() {} };

// ============================
// Per-file async lock
// ============================
// Keyed by resolved file path. Multiple CheckpointManager instances pointing
// to the same file automatically share the same lock — callers don't need to
// coordinate instance creation.

const fileLocks = new Map<string, Promise<void>>();

/**
 * Serialize async critical sections per file path.
 * Under no contention the overhead is a single resolved-promise await.
 */
async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  // Chain after whatever is currently queued for this path
  const prev = fileLocks.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  fileLocks.set(filePath, gate);

  await prev;
  try {
    return await fn();
  } finally {
    release();
    // Clean up the map entry if we're the tail of the chain
    if (fileLocks.get(filePath) === gate) {
      fileLocks.delete(filePath);
    }
  }
}

/**
 * 跨节点互斥所需的最小锁接口。
 *
 * 由 IStateBackend（Redis）天然满足；standalone 模式不注入即可，
 * 因为单进程下 withFileLock 已足够。
 */
export interface CheckpointDistributedLock {
  acquireLock(key: string, ownerId: string, ttlMs: number): Promise<boolean>;
  releaseLock(key: string, ownerId: string): Promise<void>;
  /**
   * 续约（只能续自己持有的锁）。
   *
   * 必须提供：checkpoint 临界区含 2 次对象存储 IO，COS 抖动时可能超过 ttlMs。
   * 没有续约时锁会静默过期 → 后来者合法抢到 → 两节点同时在临界区，
   * 而 releaseLock 的 owner 校验会让先者「删不掉别人的锁」从而毫无报错，
   * 形成最难排查的静默双写。
   */
  renewLock(key: string, ownerId: string, ttlMs: number): Promise<boolean>;
}

/** checkpoint 写入的可观测计数器（由调用方注入，便于上报到既有 metric 通道） */
export interface CheckpointLockMetrics {
  /** 抢锁失败后放弃写入并要求上层重试的次数 */
  onRequeueRequired?(key: string, waitedMs: number): void;
  /** 锁后端异常导致降级（无锁执行）的次数 */
  onBackendError?(key: string, err: unknown): void;
  /** 续约失败导致放弃写入的次数 */
  onLockLost?(key: string): void;
  /** 每次成功抢锁的等待耗时，用于算p50/p95/p99 */
  onAcquireWait?(key: string, waitedMs: number): void;
}

export interface CheckpointLockOptions {
  /** 分布式锁后端；缺省表示仅依赖进程内锁 */
  lock: CheckpointDistributedLock;
  /** 锁 key，必须能唯一标识该 checkpoint 对象（通常用 instanceId） */
  lockKey: string;
  /** 锁持有时长上限，防止进程崩溃后死锁 */
  ttlMs?: number;
  /** 抢锁最长等待时间 */
  maxWaitMs?: number;
  /** 续约间隔，默认 ttlMs/3 */
  renewIntervalMs?: number;
  /** 可观测计数器 */
  metrics?: CheckpointLockMetrics;
}

/**
 * 抢不到锁 / 锁中途丢失时抛出。
 *
 * 语义：本次 checkpoint **没有写入**，上层必须重新入队而不是当作成功。
 * 旧实现在这里降级为「无锁硬写」，那等于明知会覆盖别人仍然写，
 * 是 L1 游标丢失的直接来源之一。
 */
export class CheckpointLockUnavailableError extends Error {
  readonly code = "CHECKPOINT_LOCK_UNAVAILABLE";
  constructor(message: string, readonly lockKey: string) {
    super(message);
    this.name = "CheckpointLockUnavailableError";
  }
}

/**
 * TTL 取 60s：临界区虽以「一次 GET + 一次 PUT」为主，但 COS 抖动 / 大文件
 * 序列化都可能拉长耗时，配合 renewLock 续约后TTL 只作为「进程崩溃后的
 * 兜底自愈上限」，不再是「临界区必须在此内完成」的硬约束。
 */
const DEFAULT_LOCK_TTL_MS = 60_000;
/** 抢锁最长等待。必须 < 任务锁 TTL（600s），避免把上层任务锁一起拖爆。 */
const DEFAULT_LOCK_MAX_WAIT_MS = 30_000;

export class CheckpointManager {
  private filePath: string;
  private logger: CheckpointLogger;
  private storage: StorageAdapter | undefined;
  private lockOptions: CheckpointLockOptions | undefined;
  private readonly ownerId = `cp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

  constructor(
    dataDir: string,
    logger?: CheckpointLogger,
    storage?: StorageAdapter,
    lockOptions?: CheckpointLockOptions,
  ) {
    this.storage = storage;
    if (storage) {
      this.filePath = StoragePaths.checkpoint;
    } else {
      // Dynamic import path for fs-based mode is resolved in readRaw/writeRaw
      this.filePath = `${dataDir}/.metadata/recall_checkpoint.json`;
    }
    this.logger = logger ?? noopLogger;
    this.lockOptions = lockOptions;
  }

  // ============================
  // Low-level I/O (internal)
  // ============================

  private async readRaw(): Promise<Checkpoint> {
    try {
      let raw: string | null;
      if (this.storage) {
        raw = await this.storage.readFile(this.filePath);
      } else {
        const fs = await import("node:fs/promises");
        raw = await fs.default.readFile(this.filePath, "utf-8");
      }
      if (!raw) return structuredClone(DEFAULT_CHECKPOINT);

      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // Merge with defaults for backward compat (old checkpoints lack new fields).
      // structuredClone avoids shallow-copy pitfall: without it, the nested
      // runner_states/pipeline_states objects in DEFAULT_CHECKPOINT would be
      // shared across all callers and mutated in place — corrupting the default.
      const cp = { ...structuredClone(DEFAULT_CHECKPOINT), ...parsed } as Checkpoint;

      // Migrate from old session_states format (pre-split)
      const oldStates = parsed.session_states as Record<string, Record<string, unknown>> | undefined;
      if (oldStates && !parsed.runner_states && !parsed.pipeline_states) {
        cp.runner_states = {};
        cp.pipeline_states = {};
        for (const [key, state] of Object.entries(oldStates)) {
          cp.runner_states[key] = {
            ...DEFAULT_RUNNER_STATE,
            last_captured_timestamp: (state.last_captured_timestamp as number) ?? 0,
            last_l1_cursor: (state.last_l1_cursor as number) ?? 0,
            last_scene_name: (state.last_scene_name as string) ?? "",
          };
          cp.pipeline_states[key] = {
            ...DEFAULT_PIPELINE_STATE,
            conversation_count: (state.conversation_count as number) ?? 0,
            last_extraction_time: (state.last_extraction_time as string) ?? "",
            last_extraction_updated_time: (state.last_extraction_updated_time as string) ?? "",
            last_active_time: (state.last_active_time as number) ?? 0,
            l2_pending_l1_count: (state.l2_pending_l1_count as number) ?? 0,
            l2_last_extraction_time: (state.l2_last_extraction_time as string) ?? "",
          };
        }
      } else {
        // Ensure per-session states have all fields with defaults
        if (cp.runner_states) {
          for (const [key, state] of Object.entries(cp.runner_states)) {
            cp.runner_states[key] = { ...DEFAULT_RUNNER_STATE, ...state };
          }
        }
        if (cp.pipeline_states) {
          for (const [key, state] of Object.entries(cp.pipeline_states)) {
            cp.pipeline_states[key] = { ...DEFAULT_PIPELINE_STATE, ...state };
          }
        }
      }
      return cp;
    } catch {
      return structuredClone(DEFAULT_CHECKPOINT);
    }
  }

  /** Atomic write: write to tmp file, then rename into place (fs mode). Storage mode: direct overwrite. */
  private async writeRaw(checkpoint: Checkpoint): Promise<void> {
    const content = JSON.stringify(checkpoint, null, 2);
    if (this.storage) {
      await this.storage.writeFile(this.filePath, content);
    } else {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const dir = path.default.dirname(this.filePath);
      await fs.default.mkdir(dir, { recursive: true });
      const tmp = `${this.filePath}.tmp.${randomBytes(4).toString("hex")}`;
      await fs.default.writeFile(tmp, content, "utf-8");
      await fs.default.rename(tmp, this.filePath);
    }
  }

  // ============================
  // Locked read-modify-write helper
  // ============================

  /**
   * Execute a mutating operation under the per-file lock.
   * `fn` receives the current checkpoint and may modify it in place;
   * the updated checkpoint is atomically written back.
   */
  private async mutate(fn: (cp: Checkpoint) => void | Promise<void>): Promise<Checkpoint> {
    // 进程内锁先行：同进程内的并发直接串行，避免无谓的分布式锁往返。
    return withFileLock(this.filePath, () =>
      this.withDistributedLock(async () => {
        // 必须在持有分布式锁后再读，否则读到的仍是他人临界区外的旧快照。
        const cp = await this.readRaw();
        await fn(cp);
        await this.writeRaw(cp);
        return cp;
      }),
    );
  }

  /**
   * 跨节点串行化 checkpoint 的 read-modify-write。
   *
   * 背景：service 模式下同一 instance 的所有 agent/session 共享同一个
   * checkpoint 对象（`{pathPrefix}/{instanceId}/.metadata/checkpoint.json`），
   * 而 writeRaw 是整对象覆盖。L1 的 Redis 锁是 session 级，不同session /
   * 不同 agent 可跨节点并发，因此若不额外互斥，后写者会用自己读到的旧快照
   * 覆盖先写者已提交的 runner_states，导致 L1 游标丢失。
   *
   * 未注入锁时（standalone / 单进程）直接执行：此时 withFileLock 已足够。
   */
  private async withDistributedLock<T>(fn: () => Promise<T>): Promise<T> {
    const opts = this.lockOptions;
    if (!opts) return fn();

    const ttlMs = opts.ttlMs ?? DEFAULT_LOCK_TTL_MS;
    const maxWaitMs = opts.maxWaitMs ?? DEFAULT_LOCK_MAX_WAIT_MS;
    const renewIntervalMs = opts.renewIntervalMs ?? Math.max(1_000, Math.floor(ttlMs / 3));
    const key = `checkpoint:${opts.lockKey}`;
    const startedAt = Date.now();
    const deadline = startedAt + maxWaitMs;

    let acquired = false;
    let delayMs = 20;
    while (Date.now() < deadline) {
      try {
        acquired = await opts.lock.acquireLock(key, this.ownerId, ttlMs);
      } catch (err) {
        // 锁后端故障：无法保证互斥。此时**不写**，交由上层重新入队。
        // （旧实现在这里无锁硬写，会覆盖其他节点的 runner_states。）
        opts.metrics?.onBackendError?.(key, err);
        throw new CheckpointLockUnavailableError(
          `checkpoint lock backend error for ${key}: ${err instanceof Error ? err.message : String(err)}`,
          key,
        );
      }
      if (acquired) break;
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs = Math.min(delayMs * 2, 500);
    }

    if (!acquired) {
      const waitedMs = Date.now() - startedAt;
      opts.metrics?.onRequeueRequired?.(key, waitedMs);
      // 关键行为变更：不再降级无锁写。
      // 无锁写会用旧快照覆盖他人已提交的数据（丢 L1 游标 → 永久重复抽取），
      // 代价远高于「本次放弃、重新入队后重跑」。
      throw new CheckpointLockUnavailableError(
        `failed to acquire ${key} within ${waitedMs}ms; skipping write (caller should requeue)`,
        key,
      );
    }
    opts.metrics?.onAcquireWait?.(key, Date.now() - startedAt);

    // ── 续约：防止临界区超过 TTL 后锁被别人抢走造成静默双写 ──
    let lockLost = false;
    const renewTimer = setInterval(() => {
      void (async () => {
        try {
          const renewed = await opts.lock.renewLock(key, this.ownerId, ttlMs);
          if (!renewed) {
            lockLost = true;
            clearInterval(renewTimer);
            opts.metrics?.onLockLost?.(key);
            this.logger.warn?.(`[CHECKPOINT] lock ${key} renew rejected (lost ownership)`);
          }
        } catch (err) {
          lockLost = true;
          clearInterval(renewTimer);
          opts.metrics?.onLockLost?.(key);
          this.logger.warn?.(
            `[CHECKPOINT] lock ${key} renew threw: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
    }, renewIntervalMs);
    // 不要让续约 timer 阻止进程退出
    (renewTimer as unknown as { unref?: () => void }).unref?.();

    try {
      const result = await fn();
      // 临界区执行期间锁曾丢失 → 本次写入可能与他人交错，不能当作成功。
      if (lockLost) {
        throw new CheckpointLockUnavailableError(
          `lock ${key} was lost during the critical section; write is not trustworthy`,
          key,
        );
      }
      return result;
    } finally {
      clearInterval(renewTimer);
      try {
        // 仅在仍持有锁时释放（丢锁后释放会误删新持有者的锁 —— 虽然后端有
        // owner 校验兜底，这里显式跳过更清晰）。
        if (!lockLost) await opts.lock.releaseLock(key, this.ownerId);
      } catch {
        // 锁会随 TTL 自动过期，释放失败无需中断主流程
      }
    }
  }

  // ============================
  // Public API — read-only
  // ============================

  /**
   * Read the current checkpoint (unlocked snapshot).
   *
   * NOTE: This does NOT acquire the file lock. The returned snapshot may be
   * stale if a concurrent `mutate()` is in progress. This is acceptable for
   * read-only uses (status display, deciding whether to run a pipeline step).
   *
   * For read-then-write patterns, always use `mutate()` instead — it acquires
   * the lock and re-reads from disk inside the critical section, ensuring the
   * update is based on the latest state.
   */
  async read(): Promise<Checkpoint> {
    return this.readRaw();
  }

  /** Write a full checkpoint (acquires lock + atomic write). */
  async write(checkpoint: Checkpoint): Promise<void> {
    return withFileLock(this.filePath, () => this.writeRaw(checkpoint));
  }

  // ============================
  // Public API — mutating (all serialized via file lock)
  // ============================

  // ============================
  // Persona methods (L3)
  // ============================

  async markPersonaGenerated(totalProcessed: number): Promise<void> {
    await this.mutate((cp) => {
      cp.last_persona_at = totalProcessed;
      cp.last_persona_time = new Date().toISOString();
      cp.memories_since_last_persona = 0;
      cp.request_persona_update = false;
      cp.persona_update_reason = "";
    });
  }

  async clearPersonaRequest(): Promise<void> {
    await this.mutate((cp) => {
      cp.request_persona_update = false;
      cp.persona_update_reason = "";
    });
  }

  async setPersonaUpdateRequest(reason: string): Promise<void> {
    await this.mutate((cp) => {
      cp.request_persona_update = true;
      cp.persona_update_reason = reason;
    });
  }

  async incrementScenesProcessed(): Promise<void> {
    const cp = await this.mutate((cp) => {
      cp.scenes_processed += 1;
    });
    this.logger.info(`[checkpoint] incrementScenesProcessed: scenes_processed=${cp.scenes_processed}`);
  }

  // ============================
  // Per-session helpers — runner state (L0/L1 owned)
  // ============================

  /**
   * Get or create runner session state for a session.
   */
  getRunnerState(cp: Checkpoint, sessionKey: string): RunnerSessionState {
    if (!cp.runner_states) {
      cp.runner_states = {};
    }
    let state = cp.runner_states[sessionKey];
    if (!state) {
      state = { ...DEFAULT_RUNNER_STATE };
      cp.runner_states[sessionKey] = state;
    }
    return state;
  }

  // ============================
  // Per-session helpers — pipeline state (PipelineManager owned)
  // ============================

  /**
   * Get or create pipeline session state for a session.
   */
  getPipelineState(cp: Checkpoint, sessionKey: string): PipelineSessionState {
    if (!cp.pipeline_states) {
      cp.pipeline_states = {};
    }
    let state = cp.pipeline_states[sessionKey];
    if (!state) {
      state = { ...DEFAULT_PIPELINE_STATE, last_active_time: Date.now() };
      cp.pipeline_states[sessionKey] = state;
    }
    return state;
  }

  /**
   * Get all pipeline states from checkpoint.
   */
  getAllPipelineStates(cp: Checkpoint): Record<string, PipelineSessionState> {
    return cp.pipeline_states ?? {};
  }

  /**
   * Merge pipeline session states into the checkpoint (used by pipeline persister).
   * Acquires the file lock so this is safe against concurrent mutations.
   *
   * This writes ONLY to `pipeline_states`, never touching `runner_states`.
   * This is the core guarantee that eliminates the split-brain overwrite bug.
   */
  async mergePipelineStates(states: Record<string, PipelineSessionState>): Promise<void> {
    await this.mutate((cp) => {
      if (!cp.pipeline_states) cp.pipeline_states = {};
      for (const [key, pState] of Object.entries(states)) {
        cp.pipeline_states[key] = {
          ...cp.pipeline_states[key],
          ...pState,
        };
      }
    });
  }

  // ============================
  // L1-specific methods
  // ============================

  /**
   * Mark L1 extraction completed: reset sinceL1 counter, advance L1 cursor,
   * and optionally save the last scene name for cross-batch continuity.
   *
   * @param cursorRecordedAtMs - The max recorded_at epoch ms of processed L0 messages.
   *   This becomes the new `last_l1_cursor` value (recorded_at semantics, not conversation timestamp).
   */
  async markL1ExtractionComplete(
    sessionKey: string,
    memoriesExtracted: number,
    cursorRecordedAtMs?: number,
    lastSceneName?: string,
    options?: { countForPersona?: boolean },
  ): Promise<void> {
    let regressed = false;
    await this.mutate((cp) => {
      const state = this.getRunnerState(cp, sessionKey);
      if (cursorRecordedAtMs) {
        // P0-2: 单调递增，绝不回退。
        //
        // cursorRecordedAtMs 由调用方基于 createL1Runner 开头那次**无锁快照**
        // 算出，中间跨越了整个 L1 LLM 抽取。若期间该session 的游标已被推进
        // （重投、drain、并发节点），直接赋值会把游标往回拨→ 同一批 L0 被
        // 反复抽取，新数据永远排不上。取大后写入天然幂等。
        if (cursorRecordedAtMs > state.last_l1_cursor) {
          state.last_l1_cursor = cursorRecordedAtMs;
        } else if (cursorRecordedAtMs < state.last_l1_cursor) {
          regressed = true;
        }
      }
      if (lastSceneName !== undefined) {
        state.last_scene_name = lastSceneName;
      }
      cp.total_memories_extracted += memoriesExtracted;
      if (options?.countForPersona !== false) {
        cp.memories_since_last_persona += memoriesExtracted;
      }
    });
    if (regressed) {
      this.logger.warn?.(
        `[checkpoint] markL1ExtractionComplete session=${sessionKey}: ` +
        `stale cursor ${cursorRecordedAtMs} < persisted value, kept the newer one` +
        `(concurrent advance detected; no rollback)`,
      );
    }
    this.logger.info(
      `[checkpoint] markL1ExtractionComplete session=${sessionKey}: ` +
      `extracted=${memoriesExtracted}, cursor=${cursorRecordedAtMs ?? "(unchanged)"}, ` +
      `lastScene="${lastSceneName ?? "(unchanged)"}"`,
    );
  }

  /**
   * Add newly extracted L1 memories to the profile-scoped persona counter.
   *
   * L1's cursor is session-scoped, while the L3 trigger is profile-scoped.
   * Keeping this increment separate prevents a global checkpoint from being
   * mistaken for the team+agent profile checkpoint during threshold checks.
   */
  async incrementMemoriesSinceLastPersona(memoriesExtracted: number): Promise<void> {
    if (!Number.isFinite(memoriesExtracted) || memoriesExtracted <= 0) return;
    await this.mutate((cp) => {
      cp.memories_since_last_persona += memoriesExtracted;
    });
    this.logger.info(
      `[checkpoint] incrementMemoriesSinceLastPersona extracted=${memoriesExtracted}`,
    );
  }

  /**
   * 单调修复全局计数器：仅当持久值 < 期望值时抬高到期望值。
   *
   * 用于替代此前 L2 runner 里的 `write({...staleSnapshot})` —— 后者是整对象
   * 覆盖且不受分布式锁保护，会抹掉其他节点并发写入的 runner_states。
   *
   * 本方法在 mutate 的临界区内重读，只写入参列出的标量字段，其余字段原样保留。
   *
   * @returns 是否实际发生了修复（用于上层决定是否告警）
   */
  async repairMonotonicCounters(expected: {
    scenes_processed?: number;
    total_processed?: number;
  }): Promise<boolean> {
    let repaired = false;
    await this.mutate((cp) => {
      if (expected.scenes_processed !== undefined && cp.scenes_processed < expected.scenes_processed) {
        cp.scenes_processed = expected.scenes_processed;
        repaired = true;
      }
      if (expected.total_processed !== undefined && cp.total_processed < expected.total_processed) {
        cp.total_processed = expected.total_processed;
        repaired = true;
      }
    });
    return repaired;
  }

  // ============================
  // Atomic capture (race-condition fix)
  // ============================

  /**
   * Atomically read the per-session cursor, execute the capture callback,
   * and advance the cursor — all within a single file-lock critical section.
   *
   * This eliminates the race window that existed when `read()` (unlocked) and
   * `advanceSessionCapturedTimestamp()` (locked) were separate calls:
   * two concurrent `agent_end` events could both read the same stale cursor
   * and record duplicate messages.
   *
   * ⚠️ 注意：`fn` 是业务回调（recordConversation → 写 L0），**必须**留在临界区内，
   * 否则「读游标 → 捕获 → 推进游标」的原子性被破坏，并发 agent_end 会重复记录。
   * 这使本方法的临界区显著长于其他 mutate 调用；安全性依赖 withDistributedLock
   * 的**续约机制**（renewLock）持续持锁，而不是依赖 TTL 覆盖最坏耗时。
   *
   * The callback receives `afterTimestamp` (the current per-session cursor)
   * and must return either:
   *   - `{ maxTimestamp, messageCount }` to advance the cursor, or
   *   - `null` to leave the cursor unchanged (nothing captured).
   *
   * L0 conversation count is also incremented inside the lock when messages
   * are captured, removing the need for a separate `incrementL0ConversationCount()` call.
   *
   * @param sessionKey   Per-session identifier
   * @param pluginStartTimestamp  Cold-start floor (used when no cursor exists yet)
   * @param fn  Async callback that performs the actual capture (recordConversation, etc.)
   */
  async captureAtomically(
    sessionKey: string,
    pluginStartTimestamp: number | undefined,
    fn: (afterTimestamp: number) => Promise<{ maxTimestamp: number; messageCount: number } | null>,
  ): Promise<void> {
    await this.mutate(async (cp) => {
      // Read the per-session cursor inside the lock
      const state = this.getRunnerState(cp, sessionKey);
      let afterTimestamp = state.last_captured_timestamp || 0;

      // Cold-start guard (same logic that was previously in auto-capture.ts)
      if (afterTimestamp === 0 && pluginStartTimestamp && pluginStartTimestamp > 0) {
        afterTimestamp = pluginStartTimestamp;
      }

      const result = await fn(afterTimestamp);

      if (result) {
        // Advance per-session cursor (runner-owned)
        state.last_captured_timestamp = result.maxTimestamp;
        // Global stats (aggregate only — not used for filtering)
        cp.last_captured_timestamp = Math.max(cp.last_captured_timestamp, result.maxTimestamp);
        cp.total_processed += result.messageCount;
        // Increment L0 conversation count (was a separate mutate() call before)
        cp.l0_conversations_count += 1;
      }
    });
  }

}

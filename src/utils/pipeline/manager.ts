/** Class shell. Siblings: l1.ts (L0/L1), timers.ts (L2/L3), session-state.ts, recovery.ts, shutdown.ts. */

import type { PipelineSessionState } from "../checkpoint.js";
import { SerialQueue } from "../serial-queue.js";
import { SessionFilter } from "../session-filter.js";
import type { Logger } from "../../core/types.js";
import { TAG, type CapturedMessage, type L1Runner, type L2Runner, type L3Runner, type PipelineConfig, type PipelineStatePersister, type SessionTimerState } from "./types.js";
import { recoverPendingSessions } from "./recovery.js";
import { destroy as destroyPipeline, flushSession as flushSessionPipeline } from "./shutdown.js";
import { notifyConversation as notifyConversationImpl } from "./l1.js";
export class MemoryPipelineManager {
  // Config (converted to ms internally) — read by sibling modules.
  l1IdleTimeoutMs = 0;
  everyNConversations = 0;
  enableWarmup = false;
  l2DelayAfterL1Ms = 0;
  l2MinIntervalMs = 0;
  l2MaxIntervalMs = 0;
  sessionActiveWindowMs = 0;

  // Queues (named for diagnostics)
  l1Queue = new SerialQueue("L1");
  l2Queue = new SerialQueue("L2");
  l3Queue = new SerialQueue("L3");

  // L3 dedup flag — owned by timers.ts but stored here for class state.
  l3Pending = false;
  l3Running = false;

  // Per-session state — read by sibling modules.
  sessionStates = new Map<string, PipelineSessionState>();
  sessionTimers = new Map<string, SessionTimerState>();
  messageBuffers = new Map<string, CapturedMessage[]>();
  l2LastRunTime = new Map<string, number>();

  // Callbacks
  l1Runner: L1Runner | null = null;
  l2Runner: L2Runner | null = null;
  l3Runner: L3Runner | null = null;
  persister: PipelineStatePersister | null = null;
  logger: Logger | undefined;
  sessionFilter: SessionFilter;
  destroyed = false;
  instanceId?: string;
  notifyCounter = 0;

  constructor(config: PipelineConfig, logger?: Logger, sessionFilter?: SessionFilter) {
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
    if (this.logger?.debug) {
      const dbg = (msg: string) => this.logger?.debug?.(`${TAG} ${msg}`);
      this.l1Queue.setDebugLogger(dbg);
      this.l2Queue.setDebugLogger(dbg);
      this.l3Queue.setDebugLogger(dbg);
    }
  }

  setL1Runner(runner: L1Runner): void { this.l1Runner = runner; }
  setL2Runner(runner: L2Runner): void { this.l2Runner = runner; }
  setL3Runner(runner: L3Runner): void { this.l3Runner = runner; }
  setPersister(persister: PipelineStatePersister): void { this.persister = persister; }

  /**
   * Restore session states from checkpoint and start the pipeline.
   * Sessions with pending counts are re-enqueued via `recoverPendingSessions`.
   */
  start(restoredStates?: Record<string, PipelineSessionState>): void {
    if (this.destroyed) return;
    if (restoredStates) {
      let skipped = 0;
      for (const [sessionKey, state] of Object.entries(restoredStates)) {
        if (this.sessionFilter.shouldSkip(sessionKey)) { skipped++; continue; }
        // Backfill warmup_threshold for sessions persisted before warm-up feature.
        const patched = { ...state };
        if (patched.warmup_threshold == null) patched.warmup_threshold = 0;
        this.sessionStates.set(sessionKey, patched);
      }
      this.logger?.info(
        `${TAG} Restored ${this.sessionStates.size} session state(s) from checkpoint` +
        (skipped > 0 ? ` (filtered ${skipped} internal)` : ""),
      );
    }
    recoverPendingSessions(this);
    this.logger?.info(`${TAG} Pipeline started`);
  }

  /** L0 entry: notify of a conversation round (see l1.ts for paths A/B). */
  async notifyConversation(sessionKey: string, messages: CapturedMessage[]): Promise<void> {
    await notifyConversationImpl(this, sessionKey, messages);
  }

  /** Per-session flush — see shutdown.ts for semantics. */
  flushSession(sessionKey: string): Promise<void> { return flushSessionPipeline(this, sessionKey); }

  /** Graceful shutdown with timeout protection. */
  destroy(): Promise<void> { return destroyPipeline(this); }

  // ============================
  // Public accessors (for testing / status)
  // ============================

  getSessionState(sessionKey: string): PipelineSessionState | undefined {
    const state = this.sessionStates.get(sessionKey);
    return state ? { ...state } : undefined;
  }

  getBufferedMessageCount(sessionKey: string): number { return this.messageBuffers.get(sessionKey)?.length ?? 0; }
  getSessionKeys(): string[] { return Array.from(this.sessionStates.keys()); }
  get isDestroyed(): boolean { return this.destroyed; }

  getQueueSizes(): {
    l1: number; l2: number; l3: number;
    l1Pending: boolean; l2Pending: boolean; l3Pending: boolean;
    l1Idle: boolean; l2Idle: boolean; l3Idle: boolean;
  } {
    return {
      l1: this.l1Queue.size, l2: this.l2Queue.size, l3: this.l3Queue.size,
      l1Pending: this.l1Queue.pending, l2Pending: this.l2Queue.pending, l3Pending: this.l3Queue.pending,
      l1Idle: this.l1Queue.idle, l2Idle: this.l2Queue.idle, l3Idle: this.l3Queue.idle,
    };
  }
}

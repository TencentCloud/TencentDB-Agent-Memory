/**
 * Pipeline types and shared constants.
 *
 * Extracted from the monolithic `pipeline-manager.ts` during Group-C
 * decomposition. No runtime code lives here — only types/interfaces
 * and the shared log tag.
 */

import type { PipelineSessionState } from "../checkpoint.js";
import type { ManagedTimer } from "../managed-timer.js";

/** A single captured message ready for L1 processing. */
export interface CapturedMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  /** ISO timestamp string */
  timestamp: string;
}

/** Pipeline configuration — all time values in seconds. */
export interface PipelineConfig {
  /**
   * Conversation count threshold to trigger L1 batch processing.
   * When a session's conversation_count reaches this value,
   * L1 is triggered immediately with all buffered messages.
   * Default: 5.
   */
  everyNConversations: number;

  /**
   * Enable warm-up mode for new sessions.
   * When enabled, the L1 trigger threshold starts at 1 and doubles after
   * each successful L1 run (1 → 2 → 4 → 8 → ... → everyNConversations),
   * allowing early sessions to be processed more aggressively.
   * Default: true.
   */
  enableWarmup: boolean;

  l1: {
    /** Idle timeout before triggering L1 (seconds, default: 60) */
    idleTimeoutSeconds: number;
  };

  l2: {
    /**
     * Delay after L1 completes before triggering L2 (seconds, default: 90).
     * Allows remote L1 to finish generating records asynchronously.
     */
    delayAfterL1Seconds: number;
    /** Minimum interval between L2 extractions per session (seconds, default: 900) */
    minIntervalSeconds: number;
    /**
     * Maximum interval between L2 extractions per session (seconds, default: 3600).
     * Even without new L1 completions, L2 will poll at this interval for active sessions.
     */
    maxIntervalSeconds: number;
    /**
     * Sessions inactive longer than this (hours, default: 24) stop L2 polling.
     * Prevents wasting resources on abandoned sessions.
     */
    sessionActiveWindowHours: number;
  };
}

/** Result returned by the L1 runner. */
export interface L1RunnerResult {
  /** Number of messages successfully processed */
  processedCount?: number;
}

/** L1 runner — batch-processes buffered messages for a session. */
export type L1Runner = (params: {
  sessionKey: string;
  msg: CapturedMessage[];
  bg_msg: CapturedMessage[];
}) => Promise<L1RunnerResult | void>;

/** Result returned by the L2 extraction runner. */
export interface L2RunnerResult {
  /** The latest `updated_at` cursor from the processed batch. */
  latestCursor?: string;
  /** True if no new records were found and extraction was skipped. */
  skipped?: boolean;
}

/** L2 extraction runner — processes a single session's records. */
export type L2Runner = (sessionKey: string, cursor?: string) => Promise<L2RunnerResult | void>;

/** L3 runner — generates persona from all sessions' scene data. */
export type L3Runner = () => Promise<void>;

/** Callback to persist session states to checkpoint. */
export type PipelineStatePersister = (states: Record<string, PipelineSessionState>) => Promise<void>;

/** Shared log tag for all pipeline modules. */
export const TAG = "[memory-tdai] [pipeline]";

/** Per-session timer state (in memory only). */
export interface SessionTimerState {
  /** L1 idle timer (resettable): debounces conversation activity. */
  l1Idle: ManagedTimer;
  /** L2 schedule timer (downward-only): next L2 fire time, only moves earlier. */
  l2Schedule: ManagedTimer;
  /** Whether an L1 task is already queued or running for this session. */
  l1Queued: boolean;
  /** Whether an L2 task is already queued or running for this session. */
  l2Queued: boolean;
  /** Consecutive L1 failure count for retry limiting. Reset on success or new conversation. */
  l1RetryCount: number;
}

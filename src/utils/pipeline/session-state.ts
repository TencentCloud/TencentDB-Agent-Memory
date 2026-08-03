/**
 * Session-state plumbing for the pipeline.
 *
 * Pure functions that take the `MemoryPipelineManager` instance and
 * operate on its state maps. No I/O outside the checkpoint persister
 * callback (via `persistStates`).
 *
 * Functions:
 * - `getOrCreateState` / `getOrCreateTimers` — lazy map factories
 * - `getEffectiveThreshold` / `advanceWarmupThreshold` — warm-up math
 * - `persistStates` — write all session state to checkpoint
 * - `gcStaleSessions` — evict cold sessions to bound memory
 */

import type { PipelineSessionState } from "../checkpoint.js";
import { ManagedTimer } from "../managed-timer.js";
import { TAG } from "./types.js";
import type { SessionTimerState } from "./types.js";
import type { MemoryPipelineManager } from "./manager.js";

/**
 * Effective conversation threshold for a session.
 * Warm-up mode starts at 1 and doubles after each L1 run until it
 * reaches `everyNConversations`, at which point warmup is considered
 * graduated (state.warmup_threshold = 0) and the steady-state config wins.
 */
export function getEffectiveThreshold(
  m: MemoryPipelineManager,
  state: PipelineSessionState,
): number {
  if (!m.enableWarmup) return m.everyNConversations;
  if (state.warmup_threshold <= 0) return m.everyNConversations;
  return Math.min(state.warmup_threshold, m.everyNConversations);
}

/** Advance warm-up threshold after a successful L1 run. Idempotent when already graduated. */
export function advanceWarmupThreshold(
  m: MemoryPipelineManager,
  state: PipelineSessionState,
): void {
  if (!m.enableWarmup) return;
  if (state.warmup_threshold <= 0) return;
  const next = state.warmup_threshold * 2;
  if (next >= m.everyNConversations) {
    state.warmup_threshold = 0;
    m.logger?.debug?.(`${TAG} Warm-up graduated → using steady-state threshold ${m.everyNConversations}`);
  } else {
    state.warmup_threshold = next;
    m.logger?.debug?.(`${TAG} Warm-up advanced → next threshold ${next}`);
  }
}

export function getOrCreateState(
  m: MemoryPipelineManager,
  sessionKey: string,
): PipelineSessionState {
  let state = m.sessionStates.get(sessionKey);
  if (!state) {
    state = {
      conversation_count: 0,
      last_extraction_time: "",
      last_extraction_updated_time: "",
      last_active_time: Date.now(),
      l2_pending_l1_count: 0,
      warmup_threshold: m.enableWarmup ? 1 : 0,
      l2_last_extraction_time: "",
    };
    m.sessionStates.set(sessionKey, state);
    m.logger?.debug?.(`${TAG} [${sessionKey}] Created new session state`);
  }
  return state;
}

export function getOrCreateTimers(
  m: MemoryPipelineManager,
  sessionKey: string,
): SessionTimerState {
  let timers = m.sessionTimers.get(sessionKey);
  if (!timers) {
    const isDestroyed = () => m.destroyed;
    timers = {
      l1Idle: new ManagedTimer(`L1-idle:${sessionKey}`, isDestroyed),
      l2Schedule: new ManagedTimer(`L2-schedule:${sessionKey}`, isDestroyed),
      l1Queued: false,
      l2Queued: false,
      l1RetryCount: 0,
    };
    m.sessionTimers.set(sessionKey, timers);
  }
  return timers;
}

export async function persistStates(m: MemoryPipelineManager): Promise<void> {
  if (!m.persister) return;
  const obj: Record<string, PipelineSessionState> = {};
  for (const [k, v] of m.sessionStates) obj[k] = { ...v };
  try {
    m.logger?.debug?.(`Persisting states: ${JSON.stringify(obj)}`);
    await m.persister(obj);
  } catch (err) {
    m.logger?.error(
      `${TAG} Failed to persist states: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Evict cold sessions from in-memory maps to prevent unbounded growth.
 * Eviction eligibility: inactive > activeWindow × 3, no queued/running
 * tasks, no buffered messages. Evicted sessions are fully restorable
 * from checkpoint on the next `notifyConversation()`.
 */
export function gcStaleSessions(m: MemoryPipelineManager): void {
  const now = Date.now();
  const maxInactiveMs = m.sessionActiveWindowMs * 3;
  let evicted = 0;
  for (const [sessionKey, state] of m.sessionStates) {
    if (now - state.last_active_time < maxInactiveMs) continue;
    const timers = m.sessionTimers.get(sessionKey);
    if (timers?.l1Queued || timers?.l2Queued) continue;
    const buffer = m.messageBuffers.get(sessionKey);
    if (buffer && buffer.length > 0) continue;
    if (timers) {
      timers.l1Idle.cancel();
      timers.l2Schedule.cancel();
    }
    m.sessionStates.delete(sessionKey);
    m.sessionTimers.delete(sessionKey);
    m.messageBuffers.delete(sessionKey);
    m.l2LastRunTime.delete(sessionKey);
    evicted++;
  }
  if (evicted > 0) {
    m.logger?.debug?.(
      `${TAG} Session GC: evicted ${evicted} cold session(s), ${m.sessionStates.size} remaining`,
    );
  }
}

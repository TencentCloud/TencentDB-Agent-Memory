/** L0 → L1 dispatch: notifyConversation, idle-timeout, enqueueL1, runL1. */

import { report } from "../../core/report/reporter.js";
import { TAG } from "./types.js";
import type { CapturedMessage } from "./types.js";
import type { MemoryPipelineManager } from "./manager.js";
import { advanceWarmupThreshold, gcStaleSessions, getEffectiveThreshold, getOrCreateState, getOrCreateTimers, persistStates } from "./session-state.js";
import { advanceL2Timer } from "./timers.js";

const L1_RETRY_DELAY_MS = 30_000;
const L1_MAX_RETRIES = 5;
const SESSION_GC_EVERY_N_NOTIFICATIONS = 50;

/** L0 entry point. Path A: threshold; Path B: idle timer (catch-up). */
export async function notifyConversation(m: MemoryPipelineManager, sessionKey: string, messages: CapturedMessage[]): Promise<void> {
  if (m.destroyed) return;
  if (m.sessionFilter.shouldSkip(sessionKey)) return;
  const state = getOrCreateState(m, sessionKey);
  state.conversation_count += 1;
  state.last_active_time = Date.now();
  const timers = getOrCreateTimers(m, sessionKey);
  timers.l1RetryCount = 0;
  const buffer = m.messageBuffers.get(sessionKey) ?? [];
  buffer.push(...messages);
  m.messageBuffers.set(sessionKey, buffer);
  const effectiveThreshold = getEffectiveThreshold(m, state);
  const warmupInfo = m.enableWarmup && state.warmup_threshold > 0 ? ` (warmup: ${state.warmup_threshold})` : "";
  m.logger?.debug?.(
    `${TAG} [${sessionKey}] notify: conversation_count=${state.conversation_count}/${effectiveThreshold}${warmupInfo}, ` +
    `buffered_messages=${buffer.length} (+${messages.length} new)`,
  );
  await persistStates(m);
  if (state.conversation_count >= effectiveThreshold) {
    m.logger?.debug?.(`${TAG} [${sessionKey}] Conversation threshold reached (${state.conversation_count}>=${effectiveThreshold}${warmupInfo}), triggering L1`);
    enqueueL1(m, sessionKey);
    return;
  }
  timers.l1Idle.schedule(m.l1IdleTimeoutMs, () => onL1IdleTimeout(m, sessionKey));
  m.logger?.debug?.(`${TAG} [${sessionKey}] L1 idle timer reset (${m.l1IdleTimeoutMs / 1000}s)`);
  m.notifyCounter += 1;
  if (m.notifyCounter >= SESSION_GC_EVERY_N_NOTIFICATIONS) {
    m.notifyCounter = 0;
    gcStaleSessions(m);
  }
}

/** Idle-timeout handler: enqueue L1 if there is any pending work. */
export function onL1IdleTimeout(m: MemoryPipelineManager, sessionKey: string): void {
  const buffer = m.messageBuffers.get(sessionKey);
  const state = m.sessionStates.get(sessionKey);
  if ((!buffer || buffer.length === 0) && (!state || state.conversation_count === 0)) {
    m.logger?.debug?.(`${TAG} [${sessionKey}] L1 idle timeout but no pending messages or conversations`);
    return;
  }
  m.logger?.debug?.(`${TAG} [${sessionKey}] L1 idle timeout fired (buffered=${buffer?.length ?? 0}, conversations=${state?.conversation_count ?? 0})`);
  enqueueL1(m, sessionKey, "idle_timeout");
}

/** Enqueue an L1 task. Idempotent per session while a task is in flight. */
export function enqueueL1(m: MemoryPipelineManager, sessionKey: string, triggerReason: "threshold" | "idle_timeout" | "flush" = "threshold"): void {
  const timers = getOrCreateTimers(m, sessionKey);
  if (timers.l1Queued) { m.logger?.debug?.(`${TAG} [${sessionKey}] L1 already queued, skipping`); return; }
  timers.l1Idle.cancel();
  timers.l1Queued = true;
  m.logger?.debug?.(`${TAG} [${sessionKey}] Enqueuing L1 (queue=${m.l1Queue.name})`);
  if (m.instanceId && m.logger) {
    const state = m.sessionStates.get(sessionKey);
    const buffer = m.messageBuffers.get(sessionKey);
    report("pipeline_l1_trigger", {
      sessionKey, triggerReason,
      conversationCount: state?.conversation_count ?? 0,
      bufferedMessageCount: buffer?.length ?? 0,
    });
  }
  m.l1Queue.add(async () => { await runL1(m, sessionKey); })
    .catch((err) => { m.logger?.error(`${TAG} [${sessionKey}] L1 task failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`); })
    .finally(() => { timers.l1Queued = false; });
}

/** Run an L1 task. On failure, messages go back to the buffer with bounded retry. */
export async function runL1(m: MemoryPipelineManager, sessionKey: string): Promise<void> {
  const state = m.sessionStates.get(sessionKey);
  if (!state) return;
  const buffer = m.messageBuffers.get(sessionKey) ?? [];
  m.messageBuffers.set(sessionKey, []);
  if (buffer.length === 0 && state.conversation_count === 0) {
    m.logger?.debug?.(`${TAG} [${sessionKey}] L1 skipped: no messages and no pending conversations`);
    return;
  }
  m.logger?.debug?.(`${TAG} [${sessionKey}] L1 running: messages=${buffer.length}, conversation_count=${state.conversation_count}`);

  if (!m.l1Runner) {
    m.logger?.warn(`${TAG} [${sessionKey}] No L1 runner set, skipping`);
    state.l2_pending_l1_count = state.conversation_count;
    state.conversation_count = 0;
    advanceWarmupThreshold(m, state);
    await persistStates(m);
    advanceL2Timer(m, sessionKey);
    return;
  }

  try {
    await m.l1Runner({ sessionKey, msg: buffer, bg_msg: [] });
    m.logger?.debug?.(`${TAG} [${sessionKey}] L1 complete: processed ${buffer.length} messages`);
  } catch (err) {
    m.logger?.error(`${TAG} [${sessionKey}] L1 runner failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    const currentBuffer = m.messageBuffers.get(sessionKey) ?? [];
    m.messageBuffers.set(sessionKey, [...buffer, ...currentBuffer]);
    m.logger?.debug?.(`${TAG} [${sessionKey}] L1 failure: restored ${buffer.length} messages to buffer (total=${buffer.length + currentBuffer.length})`);
    const timers = getOrCreateTimers(m, sessionKey);
    timers.l1RetryCount += 1;
    if (timers.l1RetryCount <= L1_MAX_RETRIES) {
      timers.l1Idle.schedule(L1_RETRY_DELAY_MS, () => onL1IdleTimeout(m, sessionKey));
      m.logger?.debug?.(`${TAG} [${sessionKey}] L1 retry scheduled in ${L1_RETRY_DELAY_MS / 1000}s (attempt ${timers.l1RetryCount}/${L1_MAX_RETRIES})`);
    } else {
      m.logger?.warn(`${TAG} [${sessionKey}] L1 max retries reached (${L1_MAX_RETRIES}), giving up auto-retry. ${buffer.length + currentBuffer.length} messages remain buffered. Will resume on next user conversation.`);
    }
    return;
  }

  const timers = getOrCreateTimers(m, sessionKey);
  timers.l1RetryCount = 0;
  state.l2_pending_l1_count = state.conversation_count;
  state.conversation_count = 0;
  advanceWarmupThreshold(m, state);
  await persistStates(m);
  advanceL2Timer(m, sessionKey);
}

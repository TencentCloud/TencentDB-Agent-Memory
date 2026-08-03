/** L2/L3 timer logic: per-session L2 schedule, L2/L3 queue dispatch, triggerL3. */

import { TAG } from "./types.js";
import type { L2RunnerResult } from "./types.js";
import type { MemoryPipelineManager } from "./manager.js";
import { getOrCreateTimers, persistStates } from "./session-state.js";

/** Advance the per-session L2 timer (downward-only). See plan §L2 timer. */
export function advanceL2Timer(m: MemoryPipelineManager, sessionKey: string): void {
  if (m.destroyed) return;
  const timers = getOrCreateTimers(m, sessionKey);
  const now = Date.now();
  const lastL2 = m.l2LastRunTime.get(sessionKey) ?? 0;
  const minIntervalFloor = lastL2 > 0 ? lastL2 + m.l2MinIntervalMs : 0;
  const desiredTime = Math.max(now + m.l2DelayAfterL1Ms, minIntervalFloor);
  const advanced = timers.l2Schedule.tryAdvanceTo(desiredTime, () => onL2TimerFired(m, sessionKey, "delay-after-l1"));
  if (!advanced) {
    m.logger?.debug?.(`${TAG} [${sessionKey}] L2 timer not advanced: current schedule is already earlier`);
    return;
  }
  const delaySec = Math.round((desiredTime - now) / 1000);
  const wasStr = timers.l2Schedule.scheduledTime > 0
    ? ` (was ${Math.round((timers.l2Schedule.scheduledTime - now) / 1000)}s)` : " (newly armed)";
  m.logger?.debug?.(`${TAG} [${sessionKey}] L2 timer advanced: firing in ${delaySec}s${wasStr}`);
}

/** Arm the L2 timer for the maxInterval guarantee after L2 completes. */
export function armL2MaxInterval(m: MemoryPipelineManager, sessionKey: string): void {
  if (m.destroyed) return;
  const timers = getOrCreateTimers(m, sessionKey);
  timers.l2Schedule.scheduleAt(Date.now() + m.l2MaxIntervalMs, () => onL2TimerFired(m, sessionKey, "max-interval"));
  m.logger?.debug?.(`${TAG} [${sessionKey}] L2 maxInterval timer armed: ${Math.round(m.l2MaxIntervalMs / 1000)}s`);
}

/** L2 timer fire handler. Cold sessions (max-interval) skip L2. */
export function onL2TimerFired(m: MemoryPipelineManager, sessionKey: string, source: "delay-after-l1" | "max-interval"): void {
  const state = m.sessionStates.get(sessionKey);
  if (!state) return;
  if (source === "max-interval" && Date.now() - state.last_active_time >= m.sessionActiveWindowMs) {
    m.logger?.debug?.(
      `${TAG} [${sessionKey}] L2 timer fired but session is cold ` +
      `(inactive ${Math.round((Date.now() - state.last_active_time) / 3600_000)}h), timer stopped. ` +
      `Will re-arm on next L1 event.`,
    );
    return;
  }
  enqueueL2(m, sessionKey, `timer:${source}`);
}

/** Enqueue an L2 task. Cancels pending L2 timer; warns on conflict. */
export function enqueueL2(m: MemoryPipelineManager, sessionKey: string, trigger: string): void {
  const timers = getOrCreateTimers(m, sessionKey);
  timers.l2Schedule.cancel();
  if (timers.l2Queued) {
    m.logger?.warn(
      `${TAG} [${sessionKey}] L2 enqueue conflict on queue "${m.l2Queue.name}": ` +
      `task already queued/running (trigger=${trigger}), skipping`,
    );
    return;
  }
  timers.l2Queued = true;
  m.logger?.debug?.(`${TAG} [${sessionKey}] Enqueuing L2 (trigger=${trigger}, queue=${m.l2Queue.name})`);
  m.l2Queue.add(async () => { await runL2(m, sessionKey); })
    .catch((err) => { m.logger?.error(`${TAG} [${sessionKey}] L2 task failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`); })
    .finally(() => { timers.l2Queued = false; });
}

/**
 * Run an L2 task: hand the session to the L2 runner, update state, and
 * arm the next L2 cycle (maxInterval). Also triggers L3 on completion.
 */
export async function runL2(m: MemoryPipelineManager, sessionKey: string): Promise<void> {
  const state = m.sessionStates.get(sessionKey);
  if (!state) return;
  if (!m.l2Runner) { m.logger?.warn(`${TAG} [${sessionKey}] No L2 runner set, skipping`); return; }
  m.logger?.debug?.(`${TAG} [${sessionKey}] L2 running: l2_pending_l1_count=${state.l2_pending_l1_count}`);
  const cursor = state.last_extraction_updated_time || undefined;
  let result: L2RunnerResult | void;
  try {
    result = await m.l2Runner(sessionKey, cursor);
  } catch (err) {
    m.logger?.error(`${TAG} [${sessionKey}] L2 runner failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    armL2MaxInterval(m, sessionKey);
    return;
  }
  state.l2_pending_l1_count = 0;
  // Cold-start opt: don't update l2LastRunTime when first L2 is skipped.
  const isFirstL2 = !m.l2LastRunTime.has(sessionKey);
  const wasSkipped = result?.skipped === true;
  if (isFirstL2 && wasSkipped) {
    m.logger?.info?.(`${TAG} [${sessionKey}] L2 cold-start skip: not updating l2LastRunTime (minInterval won't block next trigger)`);
    armL2MaxInterval(m, sessionKey);
    await persistStates(m);
    return;
  }
  state.last_extraction_time = new Date().toISOString();
  state.l2_last_extraction_time = new Date().toISOString();
  m.l2LastRunTime.set(sessionKey, Date.now());
  if (result?.latestCursor) {
    state.last_extraction_updated_time = result.latestCursor;
  } else if (!state.last_extraction_updated_time) {
    state.last_extraction_updated_time = new Date().toISOString();
  }
  await persistStates(m);
  m.logger?.debug?.(`${TAG} [${sessionKey}] L2 complete`);
  armL2MaxInterval(m, sessionKey);
  triggerL3(m);
}

/** Trigger L3 (persona). Dedup: if L3 is running, mark pending. */
export function triggerL3(m: MemoryPipelineManager): void {
  if (m.destroyed) return;
  if (m.l3Running) { m.l3Pending = true; m.logger?.debug?.(`${TAG} L3 already running, marking pending`); return; }
  m.logger?.debug?.(`${TAG} Triggering L3`);
  enqueueL3(m);
}

export function enqueueL3(m: MemoryPipelineManager): void {
  m.l3Running = true;
  m.l3Pending = false;
  m.logger?.debug?.(`${TAG} Enqueuing L3 (queue=${m.l3Queue.name})`);
  m.l3Queue.add(async () => { await runL3(m); })
    .catch((err) => { m.logger?.error(`${TAG} L3 task failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`); })
    .finally(() => {
      m.l3Running = false;
      if (m.l3Pending && !m.destroyed) {
        m.logger?.debug?.(`${TAG} L3 has pending work, re-running`);
        enqueueL3(m);
      }
    });
}

export async function runL3(m: MemoryPipelineManager): Promise<void> {
  if (!m.l3Runner) { m.logger?.warn(`${TAG} No L3 runner set, skipping`); return; }
  m.logger?.debug?.(`${TAG} L3 running`);
  try {
    await m.l3Runner();
    m.logger?.debug?.(`${TAG} L3 complete`);
  } catch (err) {
    m.logger?.error(`${TAG} L3 runner failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  }
}

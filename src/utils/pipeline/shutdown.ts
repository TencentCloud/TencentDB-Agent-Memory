/** Shutdown: `flushSession` (per-session), `destroy` (whole-scheduler), `_doFlush`. */

import { TAG } from "./types.js";
import type { MemoryPipelineManager } from "./manager.js";
import { persistStates } from "./session-state.js";
import { enqueueL1 } from "./l1.js";

/** Maximum time (ms) to wait for pipeline flush during destroy. */
const DESTROY_TIMEOUT_MS = 2_000;

/**
 * Per-session flush — scoped end-of-session handling. See the shim's
 * exported docs for the full semantic contract.
 */
export async function flushSession(m: MemoryPipelineManager, sessionKey: string): Promise<void> {
  if (m.destroyed) return;
  if (m.sessionFilter.shouldSkip(sessionKey)) return;
  const timers = m.sessionTimers.get(sessionKey);
  const buffer = m.messageBuffers.get(sessionKey);
  if (timers?.l1Idle.pending) timers.l1Idle.cancel();
  if (buffer && buffer.length > 0) {
    m.logger?.debug?.(`${TAG} [${sessionKey}] flushSession: enqueuing L1 for ${buffer.length} buffered message(s)`);
    enqueueL1(m, sessionKey, "flush");
  }
  await m.l1Queue.onIdle();
  m.logger?.debug?.(`${TAG} [${sessionKey}] flushSession: complete`);
}

/**
 * Graceful shutdown with timeout protection.
 * 1. Mark destroyed, stop accepting new work
 * 2. Flush pending L1/L2/L3 within DESTROY_TIMEOUT_MS
 * 3. If flush fails/times out, persist state for next-startup recovery
 * 4. Pending work is never lost — recoverPendingSessions handles it
 */
export async function destroy(m: MemoryPipelineManager): Promise<void> {
  if (m.destroyed) return;
  m.destroyed = true;
  m.logger?.info(`${TAG} Destroying pipeline (timeout=${DESTROY_TIMEOUT_MS}ms)...`);
  try {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      _doFlush(m),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("destroy timeout")), DESTROY_TIMEOUT_MS);
      }),
    ]).finally(() => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    });
    m.logger?.info(`${TAG} Pipeline flushed successfully`);
  } catch (err) {
    m.logger?.warn(
      `${TAG} Pipeline flush timed out or failed: ${err instanceof Error ? err.message : String(err)}. ` +
      `Pending work will be recovered on next startup.`,
    );
  }
  try {
    await persistStates(m);
  } catch (err) {
    m.logger?.error(`${TAG} Failed to persist states during destroy: ${err instanceof Error ? err.message : String(err)}`);
  }
  m.logger?.info(`${TAG} Pipeline destroyed`);
}

async function _doFlush(m: MemoryPipelineManager): Promise<void> {
  for (const [sessionKey, timers] of m.sessionTimers) {
    if (timers.l1Idle.pending) {
      timers.l1Idle.cancel();
      const buffer = m.messageBuffers.get(sessionKey);
      if (buffer && buffer.length > 0) {
        m.logger?.debug?.(`${TAG} [${sessionKey}] Flush: enqueuing L1 for ${buffer.length} buffered messages`);
        enqueueL1(m, sessionKey, "flush");
      }
    }
  }
  m.logger?.debug?.(`${TAG} Waiting for L1 queue to drain (size=${m.l1Queue.size})`);
  await m.l1Queue.onIdle();
  for (const [sessionKey, timers] of m.sessionTimers) {
    if (timers.l2Schedule.pending) {
      m.logger?.debug?.(`${TAG} [${sessionKey}] Flush: triggering L2 schedule timer`);
      timers.l2Schedule.flush();
    }
  }
  m.logger?.debug?.(`${TAG} Waiting for queues to drain (l2=${m.l2Queue.size}, l3=${m.l3Queue.size})`);
  await Promise.all([m.l2Queue.onIdle(), m.l3Queue.onIdle()]);
}

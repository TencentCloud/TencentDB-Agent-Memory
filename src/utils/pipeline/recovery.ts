/**
 * Pipeline checkpoint recovery.
 *
 * `recoverPendingSessions` is invoked by `MemoryPipelineManager.start()`
 * after restoring persisted session states. For every session that still
 * has pending work (`conversation_count > 0` or `l2_pending_l1_count > 0`)
 * we arm the L2 timer (downward-only) instead of enqueuing immediately,
 * so a startup mid-management-command does not race with the system
 * coming up. The timer will fire on its normal schedule.
 */

import { TAG } from "./types.js";
import type { MemoryPipelineManager } from "./manager.js";
import { advanceL2Timer } from "./timers.js";

export function recoverPendingSessions(m: MemoryPipelineManager): void {
  for (const [sessionKey, state] of m.sessionStates) {
    if (state.conversation_count === 0 && state.l2_pending_l1_count === 0) continue;
    m.logger?.debug?.(
      `${TAG} [${sessionKey}] Recovery: conversation_count=${state.conversation_count}, ` +
      `l2_pending_l1_count=${state.l2_pending_l1_count}, arming L2 timer`,
    );
    // Roll conversation_count into l2_pending_l1_count: messages are gone
    // (in-memory buffers don't survive restart), but the existence of
    // pending work should still drive an L2 cycle to reconcile state.
    state.l2_pending_l1_count = Math.max(state.l2_pending_l1_count, state.conversation_count);
    state.conversation_count = 0;
    advanceL2Timer(m, sessionKey);
  }
}

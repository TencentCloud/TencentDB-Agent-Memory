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
import { enqueueL1 } from "./l1.js";

export function recoverPendingSessions(m: MemoryPipelineManager): void {
  for (const [sessionKey, state] of m.sessionStates) {
    if (state.conversation_count === 0 && state.l2_pending_l1_count === 0) continue;
    m.logger?.debug?.(
      `${TAG} [${sessionKey}] Recovery: conversation_count=${state.conversation_count}, ` +
      `l2_pending_l1_count=${state.l2_pending_l1_count}, arming L2 timer`,
    );
    if (state.conversation_count > 0) {
      // L0 and any open cohort are durable even though the in-memory message
      // buffer is gone. Re-enter L1 so an orphaned assignment is recovered;
      // routing this straight to L2 permanently wedges state='running'.
      enqueueL1(m, sessionKey);
    } else {
      advanceL2Timer(m, sessionKey);
    }
  }
}

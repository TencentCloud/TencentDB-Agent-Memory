/**
 * register-l15-judge.ts — L1.5 judge entry point (pre-flush → attempt → retry).
 *
 * Extracted from index.ts registerOffload() judgeL15() (Group D decomposition).
 */
import type { OffloadStateManager } from "./state-manager.js";
import type { RegisterCtx } from "./register-ctx.js";
import { flushL1 } from "./register-flush.js";
import { attemptL15, l15FailSafe } from "./register-l15.js";
import { engineState } from "./engine.js";

const L15_RETRY_DELAY_MS = 3000;

/**
 * L1.5 judge entry point: pre-flush → attempt → single retry → fail-safe.
 * Mirrors index.ts judgeL15().
 */
export async function judgeL15(
  ctx: RegisterCtx,
  stateManager: OffloadStateManager,
  event: any,
  _ctx: any,
): Promise<void> {
  if (!ctx.backendClient) return;
  stateManager.l15Settled = false;

  const snapshotCount = stateManager.getPendingCount();
  if (snapshotCount > 0) {
    try {
      await flushL1(ctx, stateManager, "l15_pre_flush", false, snapshotCount);
    } catch (err) {
      ctx.logger.warn(`[context-offload] L1.5 pre-flush failed: ${err}`);
    }
  }

  const startIndex = stateManager.entryCounter;
  ctx.logger.debug?.(`[context-offload] L1.5 boundary startIndex=${startIndex} (pending flushed=${snapshotCount})`);

  if (await attemptL15(ctx, stateManager, startIndex)) return;

  const retry = async () => {
    await new Promise((r) => setTimeout(r, L15_RETRY_DELAY_MS));
    if (engineState.l15Disposed || stateManager.l15Settled) return;
    ctx.logger.debug?.("[context-offload] L1.5 retrying... (1/1)");
    if (await attemptL15(ctx, stateManager, startIndex)) return;
    ctx.logger.warn("[context-offload] L1.5 FAILED after 1 retry, activating fail-safe");
    await l15FailSafe(ctx, stateManager, startIndex);
  };
  retry().catch(() => {});
}

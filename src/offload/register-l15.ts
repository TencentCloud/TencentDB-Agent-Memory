/**
 * register-l15.ts — backend-aware L1.5 task-judgment helper (1 retry, fail-safe).
 *
 * Extracted from index.ts registerOffload() (Group D decomposition).
 * L1.5 determines task boundary. On failure (after 1 retry):
 *   - activeMmd cleared to null → L2 won't trigger
 *   - All null entries marked as "short" → won't pollute future L2
 *   - This turn has no MMD construction
 */
import type { OffloadStateManager } from "./state-manager.js";
import type { L15Request } from "./backend-client.js";
import type { RegisterCtx } from "./register-ctx.js";
import { listMmds, readMmd, readAllOffloadEntries } from "./storage.js";
import { parseMmdMeta } from "./mmd-meta.js";
import { normalizeJudgment, handleTaskTransition } from "./hooks/before-agent-start.js";
import { _buildL15RecentContext } from "./engine-history-helpers.js";

const L15_RETRY_DELAY_MS = 3000;

/** L1.5 fail-safe: push a short boundary instead of marking entries on disk. */
export async function l15FailSafe(
  ctx: RegisterCtx,
  stateManager: OffloadStateManager,
  startIndex: number,
): Promise<void> {
  stateManager.setActiveMmd(null, null);
  stateManager.pushBoundary({ startIndex, result: "short", targetMmd: null });
  await stateManager.save();
  stateManager.setMmdInjectionReady(false);
  stateManager.l15Settled = true;
  ctx.logger.warn(`[context-offload] L1.5 fail-safe: settled (boundary short @${startIndex}, activeMmd=null)`);
}

/** One L1.5 judge attempt. Returns true on success (boundary pushed). */
export async function attemptL15(
  ctx: RegisterCtx,
  stateManager: OffloadStateManager,
  startIndex: number,
): Promise<boolean> {
  const { backendClient, logger } = ctx;
  if (!backendClient) return false;
  try {
    const allMmds = await listMmds(stateManager.ctx);
    const availableMmds = allMmds.slice(-10);
    const { join } = await import("node:path");
    const mmdMetas: L15Request["availableMmdMetas"] = [];
    for (const mmdFile of availableMmds) {
      try {
        const content = await readMmd(stateManager.ctx, mmdFile);
        if (content) {
          mmdMetas.push(parseMmdMeta(mmdFile, join(stateManager.ctx.mmdsDir, mmdFile), content));
        }
      } catch { /* skip */ }
    }
    const currentMmdFilename = stateManager.getActiveMmdFile();
    let currentMmd: L15Request["currentMmd"] = null;
    if (currentMmdFilename) {
      const content = await readMmd(stateManager.ctx, currentMmdFilename);
      if (content) {
        currentMmd = { filename: currentMmdFilename, content, path: join(stateManager.ctx.mmdsDir, currentMmdFilename) };
      }
    }
    const recentMessages = _buildL15RecentContext(stateManager);

    stateManager.setMmdInjectionReady(false);
    const resp = await backendClient.l15Judge({ recentMessages, currentMmd, availableMmdMetas: mmdMetas });

    const judgment = normalizeJudgment(resp as unknown as Record<string, unknown>);
    if (!judgment) {
      logger.warn("[context-offload] L1.5: all-null response (backend LLM unavailable)");
      return false;
    }

    logger.debug?.(
      `[context-offload] L1.5: completed=${judgment.taskCompleted}, continuation=${judgment.isContinuation}, longTask=${judgment.isLongTask}, label=${judgment.newTaskLabel ?? "none"}, contFile=${judgment.continuationMmdFile ?? "none"}`,
    );

    // Flush residual null entries for the OLD mmd before task transition
    const prevMmdFile = currentMmdFilename;
    await handleTaskTransition(stateManager, judgment, logger);

    const newMmdFile = stateManager.getActiveMmdFile();
    const mmdSwitched = prevMmdFile && newMmdFile !== prevMmdFile;
    if (mmdSwitched) {
      const _flushStartIndex = startIndex;
      const _flushPrevMmd = prevMmdFile!;
      (async () => {
        try {
          const allEntries = await readAllOffloadEntries(stateManager.ctx);
          const residualEntries: typeof allEntries = [];
          for (let idx = 0; idx < allEntries.length && idx < _flushStartIndex; idx++) {
            const e = allEntries[idx];
            if ((e.node_id === null || e.node_id === "wait") && !(e.tool_call ?? "").includes("HEARTBEAT.md")) {
              residualEntries.push(e);
            }
          }
          if (residualEntries.length === 0) return;

          const residualByMmd = new Map<string, typeof residualEntries>();
          residualByMmd.set(_flushPrevMmd, residualEntries);

          logger.debug?.(
            `[context-offload] L1.5 task-switch flush: ${residualEntries.length} residual null entries (idx<${_flushStartIndex}) for old mmd=${_flushPrevMmd}, triggering forced L2`,
          );
          await ctx.runL2WithBackend(stateManager, residualByMmd, "task_switch_flush");
        } catch (flushErr) {
          logger.warn(`[context-offload] L1.5 task-switch flush failed: ${flushErr}`);
        }
      })().catch(() => {});
    }

    const activeMmdFile = stateManager.getActiveMmdFile();
    if (activeMmdFile) {
      stateManager.pushBoundary({ startIndex, result: "long", targetMmd: activeMmdFile });
      logger.debug?.(`[context-offload] L1.5 boundary: long @${startIndex} → ${activeMmdFile}`);
    } else {
      stateManager.pushBoundary({ startIndex, result: "short", targetMmd: null });
      logger.debug?.(`[context-offload] L1.5 boundary: short @${startIndex}`);
    }

    await stateManager.save();
    stateManager.setMmdInjectionReady(true);
    stateManager.l15Settled = true;
    logger.debug?.("[context-offload] L1.5: settled, MMD injection ready");
    return true;
  } catch (err) {
    logger.warn(`[context-offload] L1.5 attempt failed: ${err}`);
    return false;
  }
}


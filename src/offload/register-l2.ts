/**
 * register-l2.ts — backend-aware L2 trigger helper.
 *
 * Extracted from index.ts registerOffload() (Group D decomposition).
 * For each mmd: split entries into batches (≤L2_BATCH_SIZE), mark them "wait",
 * call backend l2Generate, apply MMD patch/write, backfill node_ids.
 */
import type { OffloadStateManager } from "./state-manager.js";
import type { L2Request } from "./backend-client.js";
import type { RegisterCtx } from "./register-ctx.js";
import { listMmds, readMmd, writeMmd, patchMmd, readAllOffloadEntries, rewriteAllOffloadEntries } from "./storage.js";
import { backfillNodeIds } from "./pipelines/l2-mermaid.js";
import { nowChinaISO } from "./time-utils.js";

const L2_BATCH_SIZE = 30; // max entries per L2 backend call to avoid oversized requests / timeouts

/** Backend-aware L2 executor (captures backendClient per call — stays in register-*). */
export async function runL2WithBackend(
  ctx: RegisterCtx,
  stateManager: OffloadStateManager,
  entriesByMmd: Map<string, any[]>,
  triggerSource: string,
): Promise<void> {
  const { backendClient, logger } = ctx;
  if (!backendClient) return;
  try {
    for (const [mmdFile, mmdEntries] of entriesByMmd) {
      const taskLabel = mmdFile.replace(/^\d+-/, "").replace(/\.mmd$/, "") || "unnamed-task";
      const prefixMatch = mmdFile.match(/^(\d+)-/);
      const mmdPrefix = prefixMatch ? prefixMatch[1] : "000";

      const batches: any[][] = [];
      for (let i = 0; i < mmdEntries.length; i += L2_BATCH_SIZE) {
        batches.push(mmdEntries.slice(i, i + L2_BATCH_SIZE));
      }
      logger.debug?.(`[context-offload] L2 (${triggerSource}): mmd=${mmdFile}, ${mmdEntries.length} entries → ${batches.length} batch(es) of ≤${L2_BATCH_SIZE}`);

      for (let bIdx = 0; bIdx < batches.length; bIdx++) {
        const batch = batches[bIdx];
        const batchWaitIds = new Set(batch.map((e: any) => e.tool_call_id as string));

        const existingMmd = await readMmd(stateManager.ctx, mmdFile);

        const req: L2Request = {
          existingMmd,
          newEntries: batch.map((e: any) => ({
            tool_call_id: e.tool_call_id,
            tool_call: e.tool_call,
            summary: e.summary,
            timestamp: e.timestamp,
          })),
          recentHistory: stateManager.cachedRecentHistory || null,
          currentTurn: stateManager.cachedLatestTurnMessages || null,
          taskLabel,
          mmdPrefix,
          mmdCharCount: existingMmd ? existingMmd.length : 0,
        };

        // Mark batch entries as "wait" before calling backend
        const allEntries = await readAllOffloadEntries(stateManager.ctx);
        let changed = false;
        for (const entry of allEntries) {
          if (batchWaitIds.has(entry.tool_call_id) && entry.node_id === null) {
            entry.node_id = "wait";
            changed = true;
          }
        }
        if (changed) await rewriteAllOffloadEntries(stateManager.ctx, allEntries);
        if (bIdx === 0) {
          stateManager.setLastL2TriggerTime(nowChinaISO());
          await stateManager.save();
        }

        try {
          const resp = await backendClient.l2Generate(req);

          if (!resp.fileAction) {
            logger.warn(`[context-offload] L2 [${mmdFile}] batch ${bIdx + 1}/${batches.length}: degraded response, applying fallback backfill`);
            await backfillNodeIds(stateManager.ctx, resp.nodeMapping ?? {}, batchWaitIds, logger, {
              mmdFallbackText: existingMmd ?? "",
              mmdPrefix,
            });
            continue;
          }

          if (resp.fileAction === "replace" && resp.replaceBlocks && resp.replaceBlocks.length > 0) {
            const patchOk = await patchMmd(stateManager.ctx, mmdFile, resp.replaceBlocks);
            logger.debug?.(`[context-offload] L2 [${mmdFile}] batch ${bIdx + 1}/${batches.length}: patchMmd: ${patchOk ? "ok" : "FAILED"} (${resp.replaceBlocks.length} blocks)`);
            if (!patchOk && resp.mmdContent) {
              await writeMmd(stateManager.ctx, mmdFile, resp.mmdContent);
              logger.debug?.(`[context-offload] L2 [${mmdFile}] batch ${bIdx + 1}/${batches.length}: fallback writeMmd: ${resp.mmdContent.length} chars`);
            }
          } else if (resp.mmdContent) {
            await writeMmd(stateManager.ctx, mmdFile, resp.mmdContent);
            logger.debug?.(`[context-offload] L2 [${mmdFile}] batch ${bIdx + 1}/${batches.length}: writeMmd: ${resp.mmdContent.length} chars`);
          }

          const mmdAfterWrite = await readMmd(stateManager.ctx, mmdFile);
          const mmdForBackfill =
            typeof mmdAfterWrite === "string" && mmdAfterWrite.trim().length > 0
              ? mmdAfterWrite
              : typeof existingMmd === "string" && existingMmd.trim().length > 0
                ? existingMmd
                : "";
          await backfillNodeIds(stateManager.ctx, resp.nodeMapping ?? {}, batchWaitIds, logger, {
            mmdFallbackText: mmdForBackfill,
            mmdPrefix,
          });

          logger.debug?.(`[context-offload] L2 [${mmdFile}] batch ${bIdx + 1}/${batches.length} (${triggerSource}): applied, action=${resp.fileAction}, mapping=${Object.keys(resp.nodeMapping ?? {}).length}`);
        } catch (err) {
          logger.error(`[context-offload] L2 [${mmdFile}] batch ${bIdx + 1}/${batches.length} failed: ${err}`);
        }
      }
    }
  } catch (err) {
    logger.error(`[context-offload] L2 failed: ${err}`);
  }
}

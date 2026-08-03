/**
 * register-flush.ts — backend-aware L1 flush helper (batching + retry + fallback).
 *
 * Extracted from index.ts registerOffload() (Group D decomposition).
 * Backend mode only: take pairs → filter heartbeats → write ref MD files →
 * split into batches → per-batch HTTP → retry up to MAX_L1_CHUNK_RETRIES →
 * generate local fallback entries when retries exhausted.
 */
import type { OffloadStateManager } from "./state-manager.js";
import type { L1Request } from "./backend-client.js";
import type { RegisterCtx } from "./register-ctx.js";
import { appendOffloadEntries, sanitizeText, writeRefMd } from "./storage.js";
import { _buildL1RecentContext } from "./engine-history-helpers.js";

const MAX_L1_CHUNK_RETRIES = 3;
const L1_BATCH_SIZE = 5; // matches backend toolPairs limit (1-5)

/**
 * Flush pending L1 tool pairs to the backend, with batching + retry + fallback.
 * Mirrors index.ts flushL1() (fire-and-forget semantics preserved by caller).
 */
export async function flushL1(
  ctx: RegisterCtx,
  stateManager: OffloadStateManager,
  triggerSource: string,
  _fireAndForget = false,
  maxCount?: number,
): Promise<void> {
  const { backendClient, logger } = ctx;
  if (!backendClient) return;
  if (!stateManager.hasPending()) return;

  const release = await stateManager.acquireL1Lock();
  try {
    const pendingCount = stateManager.getPendingCount();
    const takeCount = maxCount != null ? Math.min(maxCount, pendingCount) : pendingCount;
    const takenPairs = stateManager.takePending(takeCount);
    if (takenPairs.length === 0) return;

    // Filter heartbeat pairs
    const isHeartbeat = (p: typeof takenPairs[0]) => {
      try {
        const raw = typeof p.params === "string" ? p.params : JSON.stringify(p.params ?? "");
        return raw.includes("HEARTBEAT.md");
      } catch { return false; }
    };
    const beforeFilter = takenPairs.length;
    const pairs = takenPairs.filter((p) => !isHeartbeat(p));
    if (beforeFilter > pairs.length) {
      logger.debug?.(`[context-offload] L1: filtered ${beforeFilter - pairs.length} heartbeat pair(s)`);
    }
    if (pairs.length === 0) return;

    // L1.1: Write ref MD files locally (preserves raw tool results for L3 recovery)
    const refByToolCallId = new Map<string, string>();
    for (const p of pairs) {
      try {
        const resultStr = typeof p.result === "string"
          ? sanitizeText(p.result)
          : sanitizeText(JSON.stringify(p.result, null, 2));
        const content = `**Tool:** ${p.toolName}\n**Call ID:** ${p.toolCallId}\n\n**Result:**\n\`\`\`\n${resultStr}\n\`\`\``;
        const refPath = await writeRefMd(stateManager.ctx, p.timestamp, p.toolName, content);
        refByToolCallId.set(p.toolCallId, refPath);
      } catch (err) {
        logger.error(`[context-offload] L1.1 ref write error (${p.toolCallId}): ${err}`);
      }
    }

    // Split into batches of L1_BATCH_SIZE
    const batches: typeof pairs[] = [];
    for (let i = 0; i < pairs.length; i += L1_BATCH_SIZE) {
      batches.push(pairs.slice(i, i + L1_BATCH_SIZE));
    }
    logger.debug?.(`[context-offload] L1 (${triggerSource}): ${pairs.length} pairs → ${batches.length} batch(es) of ≤${L1_BATCH_SIZE}`);

    const recentMessages = _buildL1RecentContext(stateManager);
    logger.debug?.(`[context-offload] L1 recentMessages (${recentMessages.length} chars):\n${recentMessages}`);

    for (const chunk of batches) {
      const chunkKey = chunk[0].toolCallId;
      const prevFails = stateManager._l1ChunkFailCounts.get(chunkKey) ?? 0;

      try {
        const req: L1Request = {
          recentMessages,
          toolPairs: chunk.map((p) => ({
            toolName: p.toolName,
            toolCallId: p.toolCallId,
            params: typeof p.params === "string" ? sanitizeText(p.params) : p.params,
            result: typeof p.result === "string" ? sanitizeText(p.result as string) : p.result,
            timestamp: p.timestamp,
          })),
        };
        const resp = await backendClient.l1Summarize(req);

        stateManager._l1ChunkFailCounts.delete(chunkKey);
        if (resp.entries && resp.entries.length > 0) {
          for (const entry of resp.entries) {
            if (!entry.result_ref && refByToolCallId.has(entry.tool_call_id)) {
              entry.result_ref = refByToolCallId.get(entry.tool_call_id)!;
            }
          }
          await appendOffloadEntries(stateManager.ctx, resp.entries, undefined, logger);
          stateManager.entryCounter += resp.entries.length;
          logger.debug?.(`[context-offload] L1 batch OK: ${resp.entries.length} entries from ${chunk.length} pairs (entryCounter=${stateManager.entryCounter})`);
        }
      } catch (err) {
        const newFails = prevFails + 1;
        logger.warn(`[context-offload] L1 batch FAILED (${chunkKey}, attempt ${newFails}/${MAX_L1_CHUNK_RETRIES}): ${err}`);

        if (newFails >= MAX_L1_CHUNK_RETRIES) {
          logger.warn(`[context-offload] L1 batch DEGRADED: ${chunk.length} pairs → fallback entries (no LLM summary)`);
          stateManager._l1ChunkFailCounts.delete(chunkKey);
          const fallbackEntries: import("./types.js").OffloadEntry[] = [];
          for (const p of chunk) {
            const resultStr = typeof p.result === "string" ? p.result : JSON.stringify(p.result ?? "");
            const truncResult = resultStr.length > 300 ? resultStr.slice(0, 297) + "..." : resultStr;
            const truncParams = typeof p.params === "string"
              ? (p.params.length > 200 ? p.params.slice(0, 197) + "..." : p.params)
              : JSON.stringify(p.params ?? "").slice(0, 200);
            fallbackEntries.push({
              timestamp: p.timestamp,
              node_id: null,
              tool_call: `${p.toolName}(${truncParams})`,
              summary: `[L1 degraded] ${p.toolName}: ${truncResult}`,
              result_ref: refByToolCallId.get(p.toolCallId) ?? "",
              tool_call_id: p.toolCallId,
              score: 0,
            });
          }
          await appendOffloadEntries(stateManager.ctx, fallbackEntries, undefined, logger);
          stateManager.entryCounter += fallbackEntries.length;
          logger.debug?.(`[context-offload] L1 fallback: wrote ${fallbackEntries.length} degraded entries`);
        } else {
          stateManager._l1ChunkFailCounts.set(chunkKey, newFails);
          for (const p of chunk) {
            stateManager.processedToolCallIds.delete(p.toolCallId);
            stateManager.pendingToolPairs.push(p as any);
          }
          logger.debug?.(`[context-offload] L1 batch: re-enqueued ${chunk.length} pairs (retry ${newFails}/${MAX_L1_CHUNK_RETRIES})`);
        }
      }
    }
  } finally {
    release();
  }
}

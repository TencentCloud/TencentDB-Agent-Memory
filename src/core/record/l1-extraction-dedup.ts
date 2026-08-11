/**
 * L1 dedup-or-store branch helper.
 * Split from l1-extractor.ts.
 */
import { batchDedup } from "./l1-dedup.js";
import type { ExtractedMemory, MemoryRecord } from "./l1-writer.js";
import type { IMemoryStore } from "../store/types.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { LLMRunner, Logger } from "../types.js";
import { applyDecisions, storeAllDirectly } from "./l1-extraction-store.js";

const TAG = "[memory-tdai][l1-extractor]";

export interface RunDedupOrStoreParams {
  memoriesWithIds: Array<ExtractedMemory & { record_id: string }>;
  enableDedup: boolean;
  config: unknown;
  logger?: Logger;
  model?: string;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
  conflictRecallTopK?: number;
  embeddingTimeoutMs?: number;
  llmRunner?: LLMRunner;
  projectId?: string;
  baseDir: string;
  sessionKey: string;
  sessionId?: string;
}

/**
 * Run batch conflict detection (when enabled) then store; on dedup failure,
 * store everything directly. Returns stored records.
 */
export async function runDedupOrStore(
  params: RunDedupOrStoreParams,
): Promise<MemoryRecord[]> {
  const {
    memoriesWithIds,
    enableDedup,
    config,
    logger,
    model,
    vectorStore,
    embeddingService,
    conflictRecallTopK,
    embeddingTimeoutMs,
    llmRunner,
    projectId,
    baseDir,
    sessionKey,
    sessionId,
  } = params;

  if (enableDedup) {
    try {
      const { decisions, previousMetadata } = await batchDedup({
        memories: memoriesWithIds,
        config,
        logger,
        model,
        vectorStore,
        embeddingService,
        conflictRecallTopK,
        embeddingTimeoutMs,
        llmRunner,
        projectId,
      });

      return await applyDecisions({
        memoriesWithIds,
        decisions,
        previousMetadata,
        baseDir,
        sessionKey,
        sessionId,
        projectId,
        logger,
        vectorStore,
        embeddingService,
      });
    } catch (err) {
      logger?.warn?.(
        `${TAG} Batch dedup failed, storing all as new: ${err instanceof Error ? err.message : String(err)}`,
      );
      return storeAllDirectly(
        memoriesWithIds,
        baseDir,
        sessionKey,
        sessionId,
        projectId,
        logger,
        vectorStore,
        embeddingService,
      );
    }
  }

  return storeAllDirectly(
    memoriesWithIds,
    baseDir,
    sessionKey,
    sessionId,
    projectId,
    logger,
    vectorStore,
    embeddingService,
  );
}

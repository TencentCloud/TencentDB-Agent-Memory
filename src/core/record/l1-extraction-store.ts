/**
 * L1 store helpers: apply dedup decisions, direct store, metric reporting.
 * Split from l1-extractor.ts.
 */
import { writeMemory } from "./l1-writer.js";
import type { ExtractedMemory, MemoryRecord, DedupDecision } from "./l1-writer.js";
import type { IMemoryStore } from "../store/types.js";
import type { EmbeddingService } from "../store/embedding.js";
import { report } from "../report/reporter.js";
import type { Logger } from "../types.js";

const TAG = "[memory-tdai][l1-extractor]";

/**
 * Apply batch dedup decisions — write memories according to their decisions.
 */
export async function applyDecisions(params: {
  memoriesWithIds: Array<ExtractedMemory & { record_id: string }>;
  decisions: DedupDecision[];
  baseDir: string;
  sessionKey: string;
  sessionId?: string;
  projectId?: string;
  logger?: Logger;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
}): Promise<MemoryRecord[]> {
  const { memoriesWithIds, decisions, baseDir, sessionKey, sessionId, projectId, logger, vectorStore, embeddingService } = params;
  const storedRecords: MemoryRecord[] = [];

  // Build a map from record_id → decision
  const decisionMap = new Map<string, DedupDecision>();
  for (const d of decisions) {
    decisionMap.set(d.record_id, d);
  }

  for (const memoryWithId of memoriesWithIds) {
    const decision = decisionMap.get(memoryWithId.record_id) ?? {
      record_id: memoryWithId.record_id,
      action: "store" as const,
      target_ids: [],
    };

    try {
      const record = await writeMemory({
        memory: memoryWithId,
        decision,
        baseDir,
        sessionKey,
        sessionId,
        projectId,
        logger,
        vectorStore,
        embeddingService,
      });

      if (record) {
        storedRecords.push(record);
      }
    } catch (err) {
      logger?.warn?.(
        `${TAG} Write failed for memory "${memoryWithId.content.slice(0, 50)}...": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return storedRecords;
}

/**
 * Store all memories directly (no dedup).
 */
export async function storeAllDirectly(
  memoriesWithIds: Array<ExtractedMemory & { record_id: string }>,
  baseDir: string,
  sessionKey: string,
  sessionId: string | undefined,
  projectId: string | undefined,
  logger?: Logger,
  vectorStore?: IMemoryStore,
  embeddingService?: EmbeddingService,
): Promise<MemoryRecord[]> {
  const storedRecords: MemoryRecord[] = [];

  for (const memoryWithId of memoriesWithIds) {
    try {
      const record = await writeMemory({
        memory: memoryWithId,
        decision: {
          record_id: memoryWithId.record_id,
          action: "store",
          target_ids: [],
        },
        baseDir,
        sessionKey,
        sessionId,
        projectId,
        logger,
        vectorStore,
        embeddingService,
      });
      if (record) {
        storedRecords.push(record);
      }
    } catch (err) {
      logger?.warn?.(
        `${TAG} Write failed for memory "${memoryWithId.content.slice(0, 50)}...": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return storedRecords;
}

/**
 * Report the l1_extraction metric (plugin instance metrics).
 */
export function reportExtractionMetric(params: {
  instanceId: string;
  logger: Logger;
  sessionKey: string;
  inputMessageCount: number;
  extractedCount: number;
  storedRecords: MemoryRecord[];
  durationMs: number;
}): void {
  const { instanceId, logger, sessionKey, inputMessageCount, extractedCount, storedRecords, durationMs } = params;
  const memoriesByType: Record<string, number> = {};
  for (const r of storedRecords) {
    memoriesByType[r.type] = (memoriesByType[r.type] ?? 0) + 1;
  }
  report("l1_extraction", {
    sessionKey,
    inputMessageCount,
    memoriesExtracted: extractedCount,
    memoriesStored: storedRecords.length,
    memoriesStoredContent: storedRecords.map((r) => ({
      content: r.content,
      type: r.type,
      scene: r.scene_name ?? null,
    })),
    memoriesByType,
    totalDurationMs: durationMs,
    success: true,
    error: null,
  });
}

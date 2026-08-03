/**
 * L1 runner builder: reads L0 messages (VectorStore DB or JSONL fallback),
 * groups by sessionId, runs `extractL1Memories` for each group, and updates
 * the checkpoint cursor.
 */

import type { MemoryTdaiConfig } from "../../config.js";
import { extractL1Memories } from "../../core/record/l1-extractor.js";
import { readConversationMessagesGroupedBySessionId } from "../../core/conversation/l0-recorder.js";
import type { ConversationMessage } from "../../core/conversation/l0-recorder.js";
import { CheckpointManager } from "../checkpoint.js";
import type { IMemoryStore } from "../../core/store/types.js";
import type { EmbeddingService } from "../../core/store/embedding.js";
import type { PipelineLogger } from "./types.js";

const TAG = "[memory-tdai] [pipeline-factory]";

export function createL1Runner(opts: {
  pluginDataDir: string;
  cfg: MemoryTdaiConfig;
  openclawConfig: unknown;
  vectorStore: IMemoryStore | undefined;
  embeddingService: EmbeddingService | undefined;
  logger: PipelineLogger;
  /**
   * Getter for the plugin instance ID used for metric reporting.
   * Called at runner execution time (not at creation time).
   */
  getInstanceId?: () => string | undefined;
  /** Host-neutral LLM runner for L1 extraction (standalone/gateway mode). */
  llmRunner?: import("../../core/types.js").LLMRunner;
}): (params: { sessionKey: string }) => Promise<{ processedCount: number }> {
  const { pluginDataDir, cfg, openclawConfig, vectorStore, embeddingService, logger, getInstanceId, llmRunner } = opts;
  const config = openclawConfig as Record<string, unknown> | undefined;

  return async ({ sessionKey }) => {
    if (!config && !llmRunner) {
      logger.debug?.(`${TAG} [l1] No OpenClaw config and no LLM runner, skipping L1 extraction`);
      return { processedCount: 0 };
    }
    const checkpoint = new CheckpointManager(pluginDataDir, logger);
    const cp = await checkpoint.read();
    const runnerState = checkpoint.getRunnerState(cp, sessionKey);
    logger.info(`${TAG} [l1] Session ${sessionKey}: l1_cursor=${runnerState.last_l1_cursor || "(start)"}`);

    try {
      let groups: Array<{ sessionId: string; projectId: string; messages: ConversationMessage[] }>;
      let maxRecordedAtMs = 0;
      if (vectorStore && !vectorStore.isDegraded()) {
        const l1Cursor = runnerState.last_l1_cursor > 0 ? runnerState.last_l1_cursor : undefined;
        const dbGroups = await vectorStore.queryL0GroupedBySessionId(sessionKey, l1Cursor);
        groups = dbGroups.map((g) => ({
          sessionId: g.sessionId,
          projectId: g.projectId ?? "",
          messages: g.messages.map((m) => ({
            id: m.id, role: m.role as "user" | "assistant", content: m.content, timestamp: m.timestamp,
          })),
        }));
        for (const g of dbGroups) for (const m of g.messages) if (m.recordedAtMs > maxRecordedAtMs) maxRecordedAtMs = m.recordedAtMs;
        logger.debug?.(`${TAG} [l1] L0 data source: VectorStore DB`);
      } else {
        logger.debug?.(`${TAG} [l1] L0 data source: JSONL files (VectorStore unavailable)`);
        const jsonlGroups = await readConversationMessagesGroupedBySessionId(
          sessionKey, pluginDataDir, runnerState.last_l1_cursor || undefined, logger, 50,
        );
        groups = jsonlGroups.map((g) => ({
          sessionId: g.sessionId, projectId: g.projectId ?? "", messages: g.messages,
        }));
        for (const g of jsonlGroups) for (const m of g.messages) if (m.recordedAtMs > maxRecordedAtMs) maxRecordedAtMs = m.recordedAtMs;
      }
      if (groups.length === 0) {
        logger.debug?.(`${TAG} [l1] No new L0 messages for session ${sessionKey}`);
        return { processedCount: 0 };
      }
      const totalMessages = groups.reduce((sum, g) => sum + g.messages.length, 0);
      logger.info(`${TAG} [l1] Processing ${totalMessages} L0 messages across ${groups.length} sessionId group(s) for session ${sessionKey}`);

      let totalExtracted = 0;
      let totalStored = 0;
      let lastSceneName: string | undefined;
      for (const group of groups) {
        logger.debug?.(`${TAG} [l1] Group sessionId=${group.sessionId || "(empty)"}: ${group.messages.length} messages`);
        const l1Result = await extractL1Memories({
          messages: group.messages, sessionKey, sessionId: group.sessionId, projectId: group.projectId,
          baseDir: pluginDataDir, config,
          options: {
            enableDedup: cfg.extraction.enableDedup,
            maxMemoriesPerSession: cfg.extraction.maxMemoriesPerSession,
            model: cfg.extraction.model,
            previousSceneName: lastSceneName ?? (runnerState.last_scene_name || undefined),
            vectorStore, embeddingService,
            conflictRecallTopK: cfg.embedding.conflictRecallTopK,
            embeddingTimeoutMs: cfg.embedding.captureTimeoutMs ?? cfg.embedding.timeoutMs,
            llmRunner,
          },
          logger,
          instanceId: getInstanceId?.(),
        });
        totalExtracted += l1Result.extractedCount;
        totalStored += l1Result.storedCount;
        if (l1Result.lastSceneName) lastSceneName = l1Result.lastSceneName;
      }
      await checkpoint.markL1ExtractionComplete(sessionKey, totalStored, maxRecordedAtMs || undefined, lastSceneName);
      logger.info(`${TAG} [l1] L1 complete: extracted=${totalExtracted}, stored=${totalStored} (${groups.length} group(s))`);
      return { processedCount: totalMessages };
    } catch (err) {
      logger.error(`${TAG} [l1] L1 failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      throw err;
    }
  };
}

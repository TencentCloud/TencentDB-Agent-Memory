/**
 * High-level pipeline assembly: `createPipelineManager` (config mapping)
 * and `createPipeline` (full wiring: data dirs + stores + scheduler + L1
 * runner + persister + destroy hook).
 */

import { MemoryPipelineManager } from "../pipeline-manager.js";
import { SessionFilter } from "../session-filter.js";
import type { MemoryTdaiConfig } from "../../config.js";
import { initDataDirectories, initStores } from "./stores.js";
import { createL1Runner } from "./l1-runner.js";
import { createPersister } from "./persister.js";
import type { PipelineFactoryOptions, PipelineInstance, PipelineLogger } from "./types.js";

const TAG = "[memory-tdai] [pipeline-factory]";

/** Create a `MemoryPipelineManager` with the standard config mapping. */
export function createPipelineManager(
  cfg: MemoryTdaiConfig,
  logger: PipelineLogger,
  sessionFilter?: SessionFilter,
): MemoryPipelineManager {
  return new MemoryPipelineManager(
    {
      everyNConversations: cfg.pipeline.everyNConversations,
      enableWarmup: cfg.pipeline.enableWarmup,
      l1: { idleTimeoutSeconds: cfg.pipeline.l1IdleTimeoutSeconds },
      l2: {
        delayAfterL1Seconds: cfg.pipeline.l2DelayAfterL1Seconds,
        minIntervalSeconds: cfg.pipeline.l2MinIntervalSeconds,
        maxIntervalSeconds: cfg.pipeline.l2MaxIntervalSeconds,
        sessionActiveWindowHours: cfg.pipeline.sessionActiveWindowHours,
      },
    },
    logger,
    sessionFilter ?? new SessionFilter([]),
  );
}

/**
 * Create a fully wired pipeline: VectorStore + EmbeddingService +
 * MemoryPipelineManager with L1 runner and persister attached. Callers
 * attach L2/L3 runners via `createL2Runner` / `createL3Runner` afterwards.
 */
export async function createPipeline(opts: PipelineFactoryOptions): Promise<PipelineInstance> {
  const { pluginDataDir, cfg, openclawConfig, logger, sessionFilter, l1LlmRunner } = opts;
  initDataDirectories(pluginDataDir);
  const stores = await initStores(cfg, pluginDataDir, logger);
  const { vectorStore, embeddingService } = stores;
  const scheduler = createPipelineManager(cfg, logger, sessionFilter);
  scheduler.setL1Runner(createL1Runner({
    pluginDataDir, cfg, openclawConfig, vectorStore, embeddingService, logger, llmRunner: l1LlmRunner,
  }));
  scheduler.setPersister(createPersister(pluginDataDir, logger));
  const destroy = async () => {
    logger.info(`${TAG} Destroying pipeline...`);
    await scheduler.destroy();
    if (vectorStore) { logger.info(`${TAG} Closing VectorStore`); vectorStore.close(); }
    if (embeddingService?.close) {
      try { logger.info(`${TAG} Closing EmbeddingService`); await embeddingService.close(); }
      catch (err) { logger.warn(`${TAG} Error closing EmbeddingService: ${err instanceof Error ? err.message : String(err)}`); }
    }
    const { resetStores } = await import("./stores.js");
    resetStores(pluginDataDir);
    logger.info(`${TAG} Pipeline destroyed`);
  };
  return { scheduler, vectorStore, embeddingService, destroy };
}

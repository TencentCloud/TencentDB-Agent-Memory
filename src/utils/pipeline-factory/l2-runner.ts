/**
 * L2 runner builder: scene extraction. Reads L1 memory records (incremental
 * via VectorStore or JSONL fallback), runs SceneExtractor, returns the
 * latest cursor for pipeline-manager to track incremental progress.
 */

import type { MemoryTdaiConfig } from "../../config.js";
import { CheckpointManager } from "../checkpoint.js";
import { SceneExtractor } from "../../core/scene/scene-extractor.js";
import { pullProfilesToLocal, syncLocalProfilesToStore } from "../../core/profile/profile-sync.js";
import type { L2Runner } from "../pipeline-manager.js";
import type { IMemoryStore } from "../../core/store/types.js";
import type { PipelineLogger, } from "./types.js";
import { isConsolidationEnabled, supportsProfileSyncWrite, warnOnce } from "./types.js";

const TAG = "[memory-tdai] [pipeline-factory]";

export function createL2Runner(opts: {
  pluginDataDir: string;
  cfg: MemoryTdaiConfig;
  openclawConfig: unknown;
  vectorStore: IMemoryStore | undefined;
  logger: PipelineLogger;
  instanceId?: string;
  llmRunner?: import("../../core/types.js").LLMRunner;
}): L2Runner {
  const { pluginDataDir, cfg, openclawConfig, vectorStore, logger, instanceId, llmRunner } = opts;

  // P5 single-writer gate
  if (isConsolidationEnabled(cfg)) {
    warnOnce(logger, "[single-writer-gate] memory.consolidation.enabled=true: inline L2 scene extraction is a no-op (scene writes owned by the memory-keeper via POST /memory/apply)");
    return async (_sessionKey: string, cursor?: string) => ({ skipped: true, latestCursor: cursor || undefined });
  }

  let profileBaseline = new Map<string, { version: number; contentMd5: string; createdAtMs: number }>();

  return async (sessionKey: string, cursor?: string) => {
    logger.debug?.(`${TAG} [L2] session=${sessionKey}, updatedAfter=${cursor ?? "(full)"}`);
    if (!openclawConfig && !llmRunner) {
      logger.warn(`${TAG} [L2] No OpenClaw config and no LLM runner, skipping scene extraction`);
      return;
    }
    let records: Array<{ content: string; created_at: string; id: string; updatedAt: string; projectId: string }>;
    if (vectorStore?.pullProfiles && !vectorStore.isDegraded()) {
      profileBaseline = await pullProfilesToLocal(pluginDataDir, vectorStore, logger);
    }
    if (vectorStore && !vectorStore.isDegraded()) {
      const { queryMemoryRecords } = await import("../../core/record/l1-reader.js");
      const memRecords = await queryMemoryRecords(vectorStore, { sessionKey, updatedAfter: cursor }, logger);
      if (memRecords.length === 0) {
        logger.debug?.(`${TAG} [L2] No new L1 records since cursor (session=${sessionKey}, updatedAfter=${cursor ?? "(full)"}), skipping scene extraction`);
        return { skipped: true, latestCursor: cursor || undefined };
      }
      logger.debug?.(`${TAG} [L2] Incremental query returned ${memRecords.length} record(s) (session=${sessionKey})`);
      records = memRecords.map((r) => ({
        content: r.content, created_at: r.createdAt, id: r.id, updatedAt: r.updatedAt, projectId: r.projectId ?? "",
      }));
    } else {
      logger.debug?.(`${TAG} [L2] VectorStore unavailable, falling back to JSONL read (session=${sessionKey})`);
      const { readMemoryRecords } = await import("../../core/record/l1-reader.js");
      let sessionRecords = await readMemoryRecords(sessionKey, pluginDataDir, logger);
      if (cursor) {
        const beforeCount = sessionRecords.length;
        sessionRecords = sessionRecords.filter((r) => (r.updatedAt || r.createdAt || "") > cursor);
        logger.debug?.(`${TAG} [L2] JSONL time filter: ${beforeCount} → ${sessionRecords.length} record(s) (updatedAfter=${cursor})`);
      }
      if (sessionRecords.length === 0) {
        logger.debug?.(`${TAG} [L2] No new L1 records found (JSONL fallback, session=${sessionKey}), skipping scene extraction`);
        return { latestCursor: cursor || undefined };
      }
      records = sessionRecords.map((r) => ({
        content: r.content, created_at: r.createdAt, id: r.id, updatedAt: r.updatedAt, projectId: r.projectId ?? "",
      }));
    }
    // Scene blocks are per project, so one batch is extracted once per project.
    const byProject = new Map<string, typeof records>();
    for (const r of records) {
      const bucket = byProject.get(r.projectId);
      if (bucket) bucket.push(r); else byProject.set(r.projectId, [r]);
    }
    const preCheckpoint = new CheckpointManager(pluginDataDir, logger);
    const preState = await preCheckpoint.read();
    const preScenesProcessed = preState.scenes_processed;
    const preMemoriesSince = preState.memories_since_last_persona;
    const preTotalProcessed = preState.total_processed;
    let processed = 0;
    for (const [projectId, projectRecords] of byProject) {
      const extractor = new SceneExtractor({
        dataDir: pluginDataDir, projectId, config: openclawConfig!,
        model: cfg.persona.model, maxScenes: cfg.persona.maxScenes,
        sceneBackupCount: cfg.persona.sceneBackupCount, logger, instanceId, llmRunner,
      });
      const memories = projectRecords.map((r) => ({ content: r.content, created_at: r.created_at, id: r.id }));
      const result = await extractor.extract(memories);
      if (result.success) processed += result.memoriesProcessed;
      else logger.warn(`${TAG} [L2] Extraction failed for project=${projectId || "(none)"}: ${result.error ?? "unknown"}`);
    }
    const extractResult = { success: true, memoriesProcessed: processed };
    if (extractResult.success && extractResult.memoriesProcessed > 0) {
      const checkpoint = new CheckpointManager(pluginDataDir, logger);
      const postState = await checkpoint.read();
      if (postState.scenes_processed < preScenesProcessed || postState.total_processed < preTotalProcessed) {
        logger.warn(
          `${TAG} [L2] ⚠️ Checkpoint corruption detected! ` +
          `scenes_processed: ${preScenesProcessed} → ${postState.scenes_processed}, ` +
          `total_processed: ${preTotalProcessed} → ${postState.total_processed}, ` +
          `memories_since: ${preMemoriesSince} → ${postState.memories_since_last_persona}. Repairing...`,
        );
        await checkpoint.write({
          ...postState,
          scenes_processed: Math.max(postState.scenes_processed, preScenesProcessed),
          total_processed: Math.max(postState.total_processed, preTotalProcessed),
          memories_since_last_persona: Math.max(postState.memories_since_last_persona, preMemoriesSince),
        });
        logger.info(`${TAG} [L2] Checkpoint repaired`);
      }
      if (vectorStore && supportsProfileSyncWrite(vectorStore)) {
        await syncLocalProfilesToStore(pluginDataDir, vectorStore, profileBaseline, logger);
      }
      await checkpoint.incrementScenesProcessed();
      const latestCursor = records.reduce((latest, r) => (r.updatedAt > latest ? r.updatedAt : latest), "");
      logger.debug?.(`${TAG} [L2] Extraction complete: processed=${extractResult.memoriesProcessed}, latestCursor=${latestCursor}`);
      return { latestCursor: latestCursor || undefined };
    }
  };
}

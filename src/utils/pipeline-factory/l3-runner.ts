/** L3 runner builder: persona generation via PersonaTrigger + PersonaGenerator. */

import type { MemoryTdaiConfig } from "../../config.js";
import { CheckpointManager } from "../checkpoint.js";
import { PersonaTrigger } from "../../core/persona/persona-trigger.js";
import { PersonaGenerator } from "../../core/persona/persona-generator.js";
import { pullProfilesToLocal, syncLocalProfilesToStore } from "../../core/profile/profile-sync.js";
import type { L3Runner } from "../pipeline-manager.js";
import type { IMemoryStore } from "../../core/store/types.js";
import type { PipelineLogger } from "./types.js";
import { isConsolidationEnabled, supportsProfileSyncWrite, warnOnce } from "./types.js";

const TAG = "[memory-tdai] [pipeline-factory]";

export function createL3Runner(opts: {
  pluginDataDir: string;
  cfg: MemoryTdaiConfig;
  openclawConfig: unknown;
  vectorStore?: IMemoryStore;
  logger: PipelineLogger;
  instanceId?: string;
  llmRunner?: import("../../core/types.js").LLMRunner;
}): L3Runner {
  const { pluginDataDir, cfg, openclawConfig, vectorStore, logger, instanceId, llmRunner } = opts;

  if (isConsolidationEnabled(cfg)) {
    warnOnce(logger, "[single-writer-gate] memory.consolidation.enabled=true: inline L3 persona generation is a no-op (persona writes owned by the memory-keeper via POST /memory/apply)");
    return async () => undefined;
  }

  return async () => {
    const trigger = new PersonaTrigger({ dataDir: pluginDataDir, interval: cfg.persona.triggerEveryN, logger });
    const { should, reason } = await trigger.shouldGenerate();
    if (!should) { logger.debug?.(`${TAG} [L3] Persona generation not needed`); return; }
    if (!openclawConfig && !llmRunner) {
      logger.warn(`${TAG} [L3] No OpenClaw config and no LLM runner, skipping persona generation`);
      return;
    }
    let profileBaseline = new Map<string, { version: number; contentMd5: string; createdAtMs: number }>();
    if (vectorStore?.pullProfiles && !vectorStore.isDegraded()) {
      profileBaseline = await pullProfilesToLocal(pluginDataDir, vectorStore, logger);
    }
    logger.info(`${TAG} [L3] Starting persona generation: ${reason}`);
    const generator = new PersonaGenerator({
      dataDir: pluginDataDir, config: openclawConfig, model: cfg.persona.model,
      backupCount: cfg.persona.backupCount, logger, instanceId, llmRunner,
    });
    const genResult = await generator.generateLocalPersona(reason);
    if (!genResult) { logger.info(`${TAG} [L3] Persona generation skipped (no changes)`); return; }
    if (vectorStore && supportsProfileSyncWrite(vectorStore)) {
      await syncLocalProfilesToStore(pluginDataDir, vectorStore, profileBaseline, logger);
    }
    const checkpoint = new CheckpointManager(pluginDataDir, logger);
    const cp = await checkpoint.read();
    await checkpoint.markPersonaGenerated(cp.total_processed);
    logger.info(`${TAG} [L3] Persona generation succeeded`);
  };
}

import type { MemoryTdaiConfig } from "../../config.js";
import type { L1ExtractionDispatcher } from "../../core/record/l1-agent-types.js";
import type { EmbeddingService } from "../../core/store/embedding.js";
import type { IMemoryStore } from "../../core/store/types.js";
import {
  commitL1Cohort,
  listL1CohortAssignments,
} from "../../gateway/l1/l1-cohort-repo.js";
import { CheckpointManager } from "../checkpoint.js";
import { processL1Assignment } from "./l1-assignment-processor.js";
import { ensureOpenL1Cohort } from "./l1-cohort-source.js";
import type { PipelineLogger } from "./types.js";
import { L1DispatchError } from "../../core/record/l1-agent-errors.js";

const TAG = "[memory-tdai] [l1-agent]";

export function createL1Runner(opts: {
  pluginDataDir: string;
  cfg: MemoryTdaiConfig;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
  logger: PipelineLogger;
  dispatcher: L1ExtractionDispatcher;
}): (params: { sessionKey: string }) => Promise<{ processedCount: number }> {
  const run = async ({ sessionKey }: { sessionKey: string }) => {
    const checkpoint = new CheckpointManager(opts.pluginDataDir, opts.logger);
    const cp = await checkpoint.read();
    const state = checkpoint.getRunnerState(cp, sessionKey);
    const cohort = await ensureOpenL1Cohort({
      dataDir: opts.pluginDataDir,
      sessionKey,
      role: opts.cfg.extraction.role,
      state,
      dispatcher: opts.dispatcher,
      vectorStore: opts.vectorStore,
      logger: opts.logger,
    });
    if (!cohort) return { processedCount: 0 };
    let memoriesExtracted = 0;
    let lastSceneName: string | undefined;
    for (const assignment of listL1CohortAssignments(
      opts.pluginDataDir,
      cohort.cohortId,
    )) {
      const result = await processL1Assignment({
        dataDir: opts.pluginDataDir,
        role: opts.cfg.extraction.role,
        assignment,
        dispatcher: opts.dispatcher,
        vectorStore: opts.vectorStore,
        embeddingService: opts.embeddingService,
        logger: opts.logger,
      });
      if (!result.ok) {
        throw new L1DispatchError(
          "launch-failed",
          `L1 assignment ${assignment.assignmentId} did not reach commit`,
        );
      }
      memoriesExtracted += result.memoryCount;
      lastSceneName = result.lastSceneName ?? lastSceneName;
    }
    await checkpoint.finalizeL1Cohort({
      cohortId: cohort.cohortId,
      sessionKey,
      memoriesExtracted,
      cursorRecordedAtMs: cohort.endRecordedAtMs,
      cursorRecordId: cohort.endRecordId,
      lastSceneName,
    });
    if (
      !commitL1Cohort(
        opts.pluginDataDir,
        cohort.cohortId,
        new Date().toISOString(),
      )
    )
      throw new Error(`failed to commit L1 cohort ${cohort.cohortId}`);
    const processedCount = (JSON.parse(cohort.rowManifestJson) as unknown[])
      .length;
    opts.logger.info(
      `${TAG} cohort=${cohort.cohortId} processed=${processedCount} memories=${memoriesExtracted}`,
    );
    return { processedCount };
  };
  return (params) => opts.dispatcher.trackOperation
    ? opts.dispatcher.trackOperation(() => run(params))
    : run(params);
}

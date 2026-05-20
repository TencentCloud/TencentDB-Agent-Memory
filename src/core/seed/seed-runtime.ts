/**
 * Seed runtime: L0→L1→L2→L3 orchestration for the `seed` command.
 *
 * Uses the shared pipeline-factory for VectorStore/EmbeddingService init,
 * L1 runner, L2 runner, L3 runner, and persister wiring — keeping this
 * module focused on seed-specific concerns:
 * - Synchronous per-round L0 capture with progress reporting
 * - waitForL1Idle polling at batch boundaries
 * - Optional L1 waiting and final full-pipeline flush for callers that need
 *   extracted artifacts immediately
 * - Ctrl+C graceful shutdown
 *
 * By default, seed preserves the historical CLI behavior and waits for L1 at
 * batch boundaries. Bulk import callers can disable L1 waiting when they only
 * need L0 records to become searchable immediately.
 */

import path from "node:path";
import { parseConfig } from "../../config.js";
import type { MemoryTdaiConfig } from "../../config.js";
import { performAutoCapture } from "../hooks/auto-capture.js";
import { createPipeline, createL2Runner, createL3Runner } from "../../utils/pipeline-factory.js";
import type { PipelineInstance, PipelineLogger } from "../../utils/pipeline-factory.js";
import { CheckpointManager } from "../../utils/checkpoint.js";
import { readManifest, writeManifest } from "../../utils/manifest.js";
import { StandaloneLLMRunnerFactory } from "../../adapters/standalone/llm-runner.js";
import type { MemoryPipelineManager } from "../../utils/pipeline-manager.js";
import type { LLMRunner } from "../types.js";
import { queryMemoryRecords, readMemoryRecords } from "../record/l1-reader.js";
import type { MemoryRecord } from "../record/l1-reader.js";
import { SceneExtractor } from "../scene/scene-extractor.js";
import { pullProfilesToLocal, syncLocalProfilesToStore } from "../profile/profile-sync.js";
import type { IMemoryStore } from "../store/types.js";
import type {
  NormalizedInput,
  NormalizedSession,
  SeedProgress,
  SeedSummary,
} from "./types.js";
import { normalizeL1Concurrency } from "./constants.js";

const TAG = "[memory-tdai] [seed]";

// ============================
// Seed pipeline options
// ============================

export interface SeedRuntimeOptions {
  /** Directory to store all seed output (L0, checkpoint, vectors.db). */
  outputDir: string;
  /** OpenClaw config object (needed for LLM calls in L1). */
  openclawConfig: unknown;
  /** Raw plugin config (same shape as api.pluginConfig). */
  pluginConfig?: Record<string, unknown>;
  /** Original input file path (for manifest traceability). */
  inputFile?: string;
  /** Wait for L1 extraction to drain after each batch/session. */
  waitForL1?: boolean;
  /** Bounded L1 extraction concurrency for this seed run. */
  l1Concurrency?: number;
  /** Coalesce pending L2 records into batches during final full-pipeline flush. */
  l2BatchSize?: number;
  /** Wait for a final L1→L2→L3 flush before returning. */
  waitForFullPipeline?: boolean;
  /** Max time for the final L1→L2→L3 flush. */
  fullPipelineFlushTimeoutMs?: number;
  /** Whether the seed pipeline owns and should close store resources. */
  ownsStoreResources?: boolean;
  /** Logger instance. */
  logger: PipelineLogger;
  /** Progress callback (called after each round). */
  onProgress?: (progress: SeedProgress) => void;
}

// ============================
// Seed pipeline creation
// ============================

/**
 * Create a seed pipeline using the shared factory, with L2/L3 runners
 * wired via shared factory functions (same logic as index.ts live runtime).
 */
async function createSeedPipeline(opts: SeedRuntimeOptions): Promise<{ pipeline: PipelineInstance; cfg: MemoryTdaiConfig; l2l3LlmRunner?: LLMRunner }> {
  const { outputDir, openclawConfig, pluginConfig, logger } = opts;

  // Parse config — all values come from pluginConfig (or parseConfig defaults)
  const cfg = parseConfig(pluginConfig);
  if (opts.l1Concurrency !== undefined) {
    cfg.pipeline.l1Concurrency = normalizeL1Concurrency(opts.l1Concurrency, cfg.pipeline.l1Concurrency);
  }
  if (opts.waitForFullPipeline) {
    // Seed/import should not let L2/L3 consume LLM capacity while L0/L1 is
    // still ingesting. The final flush explicitly triggers pending L2 timers.
    cfg.pipeline.l2DelayAfterL1Seconds = Math.max(cfg.pipeline.l2DelayAfterL1Seconds, 24 * 60 * 60);
  }

  logger.info(
    `${TAG} Creating seed pipeline: outputDir=${outputDir}, ` +
    `everyN=${cfg.pipeline.everyNConversations}, l1Idle=${cfg.pipeline.l1IdleTimeoutSeconds}s, ` +
    `l1Concurrency=${cfg.pipeline.l1Concurrency}, ` +
    `l2Delay=${cfg.pipeline.l2DelayAfterL1Seconds}s, l2Min=${cfg.pipeline.l2MinIntervalSeconds}s, l2Max=${cfg.pipeline.l2MaxIntervalSeconds}s`,
  );

  // Create standalone LLM runners if cfg.llm is configured.
  // Seed always runs outside OpenClaw, so it needs standalone runners
  // unless an explicit openclawConfig is provided (rare).
  let l1LlmRunner: LLMRunner | undefined;
  let l2l3LlmRunner: LLMRunner | undefined;

  if (cfg.llm.enabled && cfg.llm.apiKey) {
    const runnerFactory = new StandaloneLLMRunnerFactory({
      config: {
        baseUrl: cfg.llm.baseUrl,
        apiKey: cfg.llm.apiKey,
        model: cfg.llm.model,
        maxTokens: cfg.llm.maxTokens,
        timeoutMs: cfg.llm.timeoutMs,
      },
      logger,
    });
    l1LlmRunner = runnerFactory.createRunner({ enableTools: false });
    l2l3LlmRunner = runnerFactory.createRunner({ enableTools: true });
    logger.info(`${TAG} Seed using standalone LLM: model=${cfg.llm.model}`);
  }

  // Use shared factory for everything: store init, L1 runner, persister, destroy
  const pipeline = await createPipeline({
    pluginDataDir: outputDir,
    cfg,
    openclawConfig,
    logger,
    l1LlmRunner,
    ownsStoreResources: opts.ownsStoreResources,
  });

  // Wire L2 runner via shared factory (same logic as index.ts live runtime)
  pipeline.scheduler.setL2Runner(createL2Runner({
    pluginDataDir: outputDir,
    cfg,
    openclawConfig,
    vectorStore: pipeline.vectorStore,
    logger,
    llmRunner: l2l3LlmRunner,
  }));

  // Wire L3 runner via shared factory (same logic as index.ts live runtime)
  pipeline.scheduler.setL3Runner(createL3Runner({
    pluginDataDir: outputDir,
    cfg,
    openclawConfig,
    vectorStore: pipeline.vectorStore,
    logger,
    llmRunner: l2l3LlmRunner,
  }));

  return { pipeline, cfg, l2l3LlmRunner };
}

// ============================
// waitForL1Idle
// ============================

/**
 * Poll pipeline queue status until L1 is idle for a given session.
 * Modeled after benchmark-ingest.ts waitForPipelineIdle() but focused on L1 only.
 */
async function waitForL1Idle(
  scheduler: MemoryPipelineManager,
  sessionKeys: string[],
  logger: PipelineLogger,
  opts: {
    pollIntervalMs?: number;
    stableRounds?: number;
    maxWaitMs?: number;
    failOnTimeout?: boolean;
  } = {},
): Promise<void> {
  const pollInterval = opts.pollIntervalMs ?? 1_000;
  const stableRounds = opts.stableRounds ?? 3;
  const maxWait = opts.maxWaitMs ?? 300_000; // 5 min default

  const startTime = Date.now();
  let consecutiveIdle = 0;

  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed > maxWait) {
      const message = `Max wait time reached (${(maxWait / 1000).toFixed(0)}s)`;
      if (opts.failOnTimeout) {
        throw new Error(`${TAG} [waitL1] ${message}`);
      }
      logger.warn(`${TAG} [waitL1] ${message}, proceeding`);
      break;
    }

    const queues = scheduler.getQueueSizes();
    const pendingSessionKeys = sessionKeys.filter((key) => scheduler.hasPendingL1Work(key));
    const pendingSessionCount = pendingSessionKeys.length;
    const isIdle = pendingSessionCount === 0;

    if (isIdle) {
      consecutiveIdle++;
      if (consecutiveIdle >= stableRounds) {
        logger.debug?.(`${TAG} [waitL1] L1 stable for ${stableRounds} consecutive polls`);
        return;
      }
    } else {
      if (queues.l1Idle && pendingSessionKeys.length > 0) {
        logger.warn(
          `${TAG} [waitL1] L1 queue is idle but ${pendingSessionKeys.length} session(s) still report pending work; flushing target sessions`,
        );
        await Promise.all(pendingSessionKeys.map((key) => scheduler.flushSession(key)));
      }
      consecutiveIdle = 0;
      logger.debug?.(
        `${TAG} [waitL1] Waiting: l1Queue=${queues.l1}, l1Pending=${queues.l1Pending}, l1Idle=${queues.l1Idle}, ` +
        `pendingSessions=${pendingSessionCount}/${sessionKeys.length}`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
}

// ============================
// Bulk L2/L3 flush for historical imports
// ============================

interface PendingL2SessionGroup {
  sessionKey: string;
  records: Array<{
    content: string;
    created_at: string;
    id: string;
    updatedAt: string;
  }>;
}

function supportsProfileSyncWrite(store?: IMemoryStore): boolean {
  return !!(store?.syncProfiles || store?.deleteProfiles);
}

function chunkPendingL2Groups(groups: PendingL2SessionGroup[], batchSize: number): PendingL2SessionGroup[][] {
  const chunks: PendingL2SessionGroup[][] = [];
  let current: PendingL2SessionGroup[] = [];
  let currentRecords = 0;

  for (const group of groups) {
    const groupSize = Math.max(1, group.records.length);
    if (current.length > 0 && currentRecords + groupSize > batchSize) {
      chunks.push(current);
      current = [];
      currentRecords = 0;
    }
    current.push(group);
    currentRecords += groupSize;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function collectPendingL2Groups(
  pipeline: PipelineInstance,
  outputDir: string,
  logger: PipelineLogger,
): Promise<{ pendingSessionKeys: string[]; groups: PendingL2SessionGroup[]; noRecordSessionKeys: string[] }> {
  const pendingSessionKeys = pipeline.scheduler.getPendingL2SessionKeys();
  const groups: PendingL2SessionGroup[] = [];
  const noRecordSessionKeys: string[] = [];

  for (const sessionKey of pendingSessionKeys) {
    const state = pipeline.scheduler.getSessionState(sessionKey);
    const cursor = state?.last_extraction_updated_time || undefined;
    let sessionRecords: MemoryRecord[] = [];

    if (pipeline.vectorStore && !pipeline.vectorStore.isDegraded()) {
      sessionRecords = await queryMemoryRecords(pipeline.vectorStore, {
        sessionKey,
        updatedAfter: cursor,
      }, logger);
    } else {
      sessionRecords = await readMemoryRecords(sessionKey, outputDir, logger);
      if (cursor) {
        sessionRecords = sessionRecords.filter((r) => (r.updatedAt || r.createdAt || "") > cursor);
      }
    }

    if (sessionRecords.length === 0) {
      noRecordSessionKeys.push(sessionKey);
      continue;
    }

    groups.push({
      sessionKey,
      records: sessionRecords
        .map((r) => ({
          content: r.content,
          created_at: r.createdAt,
          id: r.id,
          updatedAt: r.updatedAt,
        }))
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)),
    });
  }

  groups.sort((a, b) => {
    const aFirst = a.records[0]?.updatedAt ?? "";
    const bFirst = b.records[0]?.updatedAt ?? "";
    return aFirst.localeCompare(bFirst);
  });

  return { pendingSessionKeys, groups, noRecordSessionKeys };
}

async function flushSeedFullPipelineInBatches(
  pipeline: PipelineInstance,
  cfg: MemoryTdaiConfig,
  opts: SeedRuntimeOptions,
  openclawConfig: unknown,
  llmRunner: LLMRunner | undefined,
): Promise<void> {
  const batchSize = Math.max(1, Math.floor(opts.l2BatchSize ?? 1));
  const { logger, outputDir } = opts;
  const { pendingSessionKeys, groups, noRecordSessionKeys } = await collectPendingL2Groups(pipeline, outputDir, logger);
  const recordCount = groups.reduce((sum, group) => sum + group.records.length, 0);

  logger.info(
    `${TAG} Bulk L2 flush: pendingSessions=${pendingSessionKeys.length}, ` +
    `sessionsWithRecords=${groups.length}, records=${recordCount}, batchSize=${batchSize}`,
  );

  if (noRecordSessionKeys.length > 0) {
    await pipeline.scheduler.markL2FlushedForSessions(noRecordSessionKeys);
    logger.info(`${TAG} Bulk L2 flush: marked ${noRecordSessionKeys.length} session(s) with no new L1 records as flushed`);
  }

  if (recordCount > 0 && !openclawConfig && !llmRunner) {
    throw new Error(`${TAG} Bulk L2 flush requires OpenClaw config or a standalone LLM runner`);
  }

  let profileBaseline = new Map<string, { version: number; contentMd5: string; createdAtMs: number }>();
  if (pipeline.vectorStore && !pipeline.vectorStore.isDegraded() && supportsProfileSyncWrite(pipeline.vectorStore)) {
    profileBaseline = await pullProfilesToLocal(outputDir, pipeline.vectorStore, logger);
  }

  const chunks = chunkPendingL2Groups(groups, batchSize);
  const checkpoint = new CheckpointManager(outputDir, logger);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const records = chunk.flatMap((group) => group.records);
    const sessionKeys = chunk.map((group) => group.sessionKey);

    logger.info(
      `${TAG} Bulk L2 batch ${i + 1}/${chunks.length}: ` +
      `sessions=${sessionKeys.length}, records=${records.length}`,
    );

    const extractor = new SceneExtractor({
      dataDir: outputDir,
      config: openclawConfig,
      model: cfg.persona.model,
      maxScenes: cfg.persona.maxScenes,
      sceneBackupCount: cfg.persona.sceneBackupCount,
      logger,
      llmRunner,
    });

    const preState = await checkpoint.read();
    const extractResult = await extractor.extract(records.map((r) => ({
      content: r.content,
      created_at: r.created_at,
      id: r.id,
    })));

    if (!extractResult.success) {
      throw new Error(`${TAG} Bulk L2 batch ${i + 1}/${chunks.length} failed: ${extractResult.error ?? "unknown error"}`);
    }

    const postState = await checkpoint.read();
    if (
      postState.scenes_processed < preState.scenes_processed ||
      postState.total_processed < preState.total_processed
    ) {
      logger.warn(
        `${TAG} Bulk L2 checkpoint regression detected; repairing counters ` +
        `(scenes ${preState.scenes_processed}→${postState.scenes_processed}, ` +
        `total ${preState.total_processed}→${postState.total_processed})`,
      );
      await checkpoint.write({
        ...postState,
        scenes_processed: Math.max(postState.scenes_processed, preState.scenes_processed),
        total_processed: Math.max(postState.total_processed, preState.total_processed),
        memories_since_last_persona: Math.max(postState.memories_since_last_persona, preState.memories_since_last_persona),
      });
    }

    if (pipeline.vectorStore && supportsProfileSyncWrite(pipeline.vectorStore)) {
      await syncLocalProfilesToStore(outputDir, pipeline.vectorStore, profileBaseline, logger);
    }

    await checkpoint.incrementScenesProcessed();

    const latestCursorBySession = new Map<string, string>();
    for (const group of chunk) {
      const latest = group.records.reduce((cursor, record) => (
        record.updatedAt > cursor ? record.updatedAt : cursor
      ), "");
      if (latest) latestCursorBySession.set(group.sessionKey, latest);
    }
    await pipeline.scheduler.markL2FlushedForSessions(sessionKeys, latestCursorBySession);
  }

  if (recordCount > 0) {
    await checkpoint.setPersonaUpdateRequest("seed full-pipeline bulk L2 flush completed");
    logger.info(`${TAG} Bulk L2 flush complete; running final L3 persona pass`);
  } else {
    logger.info(`${TAG} Bulk L2 flush found no L1 records requiring scene extraction; running final L3 check`);
  }

  const l3Runner = createL3Runner({
    pluginDataDir: outputDir,
    cfg,
    openclawConfig,
    vectorStore: pipeline.vectorStore,
    logger,
    llmRunner,
  });
  await l3Runner();
}

// ============================
// Main execution function
// ============================

/**
 * Execute the seed pipeline: feed normalized input through L0 → L1.
 *
 * L2/L3 runners are wired. L1 completion is awaited by default, but callers can
 * disable L1 waiting for large L0-only historical imports.
 *
 * This is the core runtime called by `src/cli/commands/seed.ts` after
 * all input validation and user confirmation are complete.
 */
export async function executeSeed(
  input: NormalizedInput,
  opts: SeedRuntimeOptions,
): Promise<SeedSummary> {
  const { logger, onProgress } = opts;
  const startTime = Date.now();

  // Track interrupt signal
  let interrupted = false;
  const onSigint = () => {
    if (interrupted) {
      // Second Ctrl+C — force exit
      logger.warn(`${TAG} Force exit (second Ctrl+C)`);
      process.exit(1);
    }
    interrupted = true;
    logger.warn(`${TAG} Interrupt received, finishing current round and shutting down...`);
  };
  process.on("SIGINT", onSigint);

  let pipeline: PipelineInstance | undefined;
  let totalL0Recorded = 0;
  let roundsProcessed = 0;
  let fullPipelineFlushed = false;

  try {
    // Create and start pipeline (returns both the pipeline instance and the
    // seed-optimized config so we don't need to parse config again)
    const seed = await createSeedPipeline(opts);
    pipeline = seed.pipeline;
    const seedCfg = seed.cfg;
    const waitForL1 = opts.waitForL1 !== false;
    const l1Concurrency = seedCfg.pipeline.l1Concurrency;
    const l1WaitMaxMs = opts.waitForFullPipeline
      ? Math.max(
          opts.fullPipelineFlushTimeoutMs ?? 0,
          300_000,
          (seedCfg.llm.timeoutMs ?? 180_000) + 120_000,
        )
      : Math.max(300_000, (seedCfg.llm.timeoutMs ?? 180_000) + 120_000);
    const failOnL1Timeout = opts.waitForFullPipeline === true;

    const checkpoint = new CheckpointManager(opts.outputDir, logger);
    const restoredCheckpoint = await checkpoint.read();
    const restoredPipelineStates = checkpoint.getAllPipelineStates(restoredCheckpoint);
    pipeline.scheduler.start(restoredPipelineStates);
    logger.info(`${TAG} Pipeline restored ${Object.keys(restoredPipelineStates).length} checkpoint session state(s)`);
    logger.info(`${TAG} Pipeline started, processing ${input.sessions.length} session(s), ${input.totalRounds} round(s)`);

    // Seed-specific: use 0 so the cold-start guard in captureAtomically()
    // does NOT filter out historical messages. In live mode Date.now()
    // prevents the first agent_end from dumping full session history,
    // but seed intentionally feeds all historical data.
    const captureStartTimestamp = 0;

    // Process each session → each round.
    //
    // Key invariant: within a single session, after every
    // everyNConversations rounds we must wait for that session's L1 to finish
    // before feeding more rounds. Without the per-session pause, one L1 run
    // could read an oversized L0 batch and advance the cursor past messages
    // that were never eligible for extraction. For bulk imports we can still
    // parallelize across sessions, because each session keeps its own cursor.
    const everyN = seedCfg.pipeline.everyNConversations;

    const processSession = async (session: NormalizedSession): Promise<void> => {
      logger.info(`${TAG} Session: key="${session.sessionKey}" id="${session.sessionId}" rounds=${session.rounds.length}`);
      let l0RecordedSinceLastWait = 0;

      for (let ri = 0; ri < session.rounds.length; ri++) {
        if (interrupted) break;

        const round = session.rounds[ri]!;
        roundsProcessed++;

        // Build messages in the format expected by performAutoCapture.
        // Field must be named "timestamp" (not "ts") because l0-recorder's
        // extractUserAssistantMessages reads m.timestamp for incremental filtering.
        const messages = round.messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
        }));

        try {
          const result = await performAutoCapture({
            messages,
            sessionKey: session.sessionKey,
            sessionId: session.sessionId,
            cfg: seedCfg,
            pluginDataDir: opts.outputDir,
            logger,
            scheduler: pipeline.scheduler,
            pluginStartTimestamp: captureStartTimestamp,
            vectorStore: pipeline.vectorStore,
            embeddingService: pipeline.embeddingService,
          });

          totalL0Recorded += result.l0RecordedCount;
          l0RecordedSinceLastWait += result.l0RecordedCount;
        } catch (err) {
          logger.error(
            `${TAG} L0 capture failed for session="${session.sessionKey}" round=${ri}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
          );
        }

        // Report progress
        onProgress?.({
          currentRound: roundsProcessed,
          totalRounds: input.totalRounds,
          sessionKey: session.sessionKey,
          stage: "l0_captured",
        });

        // After every N rounds, wait for the triggered L1 to finish before
        // feeding the next batch. This keeps L1 batches aligned with the
        // everyNConversations boundary instead of letting all rounds pile up.
        const roundInSession = ri + 1; // 1-based
        if (waitForL1 && roundInSession % everyN === 0 && !interrupted) {
          const hasL1Work = l0RecordedSinceLastWait > 0 || pipeline.scheduler.hasPendingL1Work(session.sessionKey);
          if (!hasL1Work) {
            logger.debug?.(
              `${TAG} Skipping L1 wait after round ${roundInSession}/${session.rounds.length} ` +
              `for session="${session.sessionKey}" because no new L0 was captured`,
            );
            continue;
          }

          onProgress?.({
            currentRound: roundsProcessed,
            totalRounds: input.totalRounds,
            sessionKey: session.sessionKey,
            stage: "l1_waiting",
          });

          logger.info(
            `${TAG} Pausing after round ${roundInSession}/${session.rounds.length} ` +
            `for session="${session.sessionKey}" — waiting for L1 to drain`,
          );

          await pipeline.scheduler.flushSession(session.sessionKey);
          l0RecordedSinceLastWait = 0;

          await waitForL1Idle(
            pipeline.scheduler,
            [session.sessionKey],
            logger,
            {
              pollIntervalMs: 500,
              stableRounds: 2,
              maxWaitMs: l1WaitMaxMs,
              failOnTimeout: failOnL1Timeout,
            },
          );
        }
      }

      // After all rounds for this session, flush any residual L1 work (handles
      // the tail when total rounds is not a multiple of everyN). Polling alone
      // is not enough here: one-round historical sessions may never cross the
      // threshold and their idle timer can be minutes away.
      if (waitForL1 && !interrupted) {
        const hasTailL1Work = l0RecordedSinceLastWait > 0 || pipeline.scheduler.hasPendingL1Work(session.sessionKey);
        if (!hasTailL1Work) {
          logger.debug?.(`${TAG} Skipping final L1 wait for session="${session.sessionKey}" because no new L0 was captured`);
          return;
        }

        onProgress?.({
          currentRound: roundsProcessed,
          totalRounds: input.totalRounds,
          sessionKey: session.sessionKey,
          stage: "l1_waiting",
        });

        await pipeline.scheduler.flushSession(session.sessionKey);
        l0RecordedSinceLastWait = 0;

        await waitForL1Idle(
          pipeline.scheduler,
          [session.sessionKey],
          logger,
          {
            pollIntervalMs: 1_000,
            stableRounds: 3,
            maxWaitMs: l1WaitMaxMs,
            failOnTimeout: failOnL1Timeout,
          },
        );

        logger.info(`${TAG} L1 idle for session="${session.sessionKey}"`);
      }
    };

    if (waitForL1 && l1Concurrency > 1) {
      let nextSessionIndex = 0;
      const workerCount = Math.min(l1Concurrency, input.sessions.length);
      await Promise.all(Array.from({ length: workerCount }, async () => {
        while (!interrupted) {
          const session = input.sessions[nextSessionIndex++];
          if (!session) break;
          await processSession(session);
        }
      }));
    } else {
      for (const session of input.sessions) {
        if (interrupted) break;
        await processSession(session);
      }
    }

    // Final wait for all sessions
    if (waitForL1 && !interrupted) {
      const pendingKeys = input.sessions
        .map((s) => s.sessionKey)
        .filter((key) => pipeline.scheduler.hasPendingL1Work(key));
      if (pendingKeys.length > 0) {
        logger.info(`${TAG} Final L1 idle wait for ${pendingKeys.length} pending session(s)...`);
        await waitForL1Idle(
          pipeline.scheduler,
          pendingKeys,
          logger,
          {
            pollIntervalMs: 1_000,
            stableRounds: 3,
            maxWaitMs: Math.max(600_000, l1WaitMaxMs),
            failOnTimeout: failOnL1Timeout,
          },
        );
      } else {
        logger.debug?.(`${TAG} Final L1 idle wait skipped: no pending sessions`);
      }
    } else if (!waitForL1) {
      logger.info(`${TAG} L1 waiting disabled; returning after L0 capture`);
    }

    if (!interrupted && opts.waitForFullPipeline) {
      onProgress?.({
        currentRound: roundsProcessed,
        totalRounds: input.totalRounds,
        sessionKey: "*",
        stage: "l1_l2_l3_flushing",
      });

      logger.info(`${TAG} Final full pipeline flush requested (L1→L2→L3)...`);
      if ((opts.l2BatchSize ?? 1) > 1) {
        await flushSeedFullPipelineInBatches(
          pipeline,
          seedCfg,
          opts,
          opts.openclawConfig,
          seed.l2l3LlmRunner,
        );
      } else {
        await pipeline.scheduler.flushPendingWork({
          reason: "seed",
          timeoutMs: opts.fullPipelineFlushTimeoutMs ?? 900_000,
          pollIntervalMs: 100,
          stableRounds: 3,
          armFollowUpL2Timers: false,
        });
      }
      fullPipelineFlushed = true;
    }
  } finally {
    process.removeListener("SIGINT", onSigint);

    // Graceful shutdown
    if (pipeline) {
      try {
        await pipeline.destroy();
      } catch (err) {
        logger.error(`${TAG} Pipeline destroy error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const durationMs = Date.now() - startTime;

  const summary: SeedSummary = {
    sessionsProcessed: input.sessions.length,
    roundsProcessed,
    messagesProcessed: input.totalMessages,
    l0RecordedCount: totalL0Recorded,
    fullPipelineFlushed,
    durationMs,
    outputDir: opts.outputDir,
  };

  if (interrupted) {
    logger.warn(`${TAG} Seed interrupted after ${roundsProcessed}/${input.totalRounds} rounds`);
  } else {
    logger.info(
      `${TAG} Seed complete: sessions=${summary.sessionsProcessed}, ` +
      `rounds=${summary.roundsProcessed}, messages=${summary.messagesProcessed}, ` +
      `l0Recorded=${summary.l0RecordedCount}, duration=${(durationMs / 1000).toFixed(1)}s`,
    );
  }

  // Append seed info to manifest (non-fatal if it fails)
  try {
    const manifest = readManifest(opts.outputDir);
    if (manifest) {
      manifest.seed = {
        inputFile: opts.inputFile ? path.basename(opts.inputFile) : undefined,
        sessions: summary.sessionsProcessed,
        rounds: summary.roundsProcessed,
        messages: summary.messagesProcessed,
        fullPipelineFlushed: summary.fullPipelineFlushed,
        startedAt: new Date(startTime).toISOString(),
        completedAt: new Date().toISOString(),
      };
      writeManifest(opts.outputDir, manifest);
      logger.info(`${TAG} Manifest updated with seed info`);
    }
  } catch (err) {
    logger.warn(`${TAG} Failed to update manifest with seed info (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  return summary;
}

/**
 * L1 Memory Extractor — thin orchestrator over l1-extraction-* helpers.
 * Retries the LLM call once when the response is unparseable; reports
 * success:false after retry so the L1 runner preserves the cursor.
 */

import type { ConversationMessage } from "../conversation/l0-recorder.js";
import { generateMemoryId } from "./l1-writer.js";
import type { ExtractedMemory, MemoryRecord, MemoryScope } from "./l1-writer.js";
import { callLlmExtraction } from "./l1-extraction-llm.js";
import type { L1ExtractionResult, ExtractL1Params, SceneSegment } from "./l1-extraction-types.js";
import { filterQualifiedMessages, flattenScenes, prepareMemories } from "./l1-extraction-messages.js";
import { runDedupOrStore } from "./l1-extraction-dedup.js";
import { reportExtractionMetric } from "./l1-extraction-store.js";

const TAG = "[memory-tdai][l1-extractor]";

// Truncate overlong contents — recall caps at maxTotalRecallChars anyway,
// and a single >1500-char record eats the whole injection budget.
const MAX_CONTENT_CHARS = 600;

/**
 * Run the full L1 extraction pipeline on conversation messages.
 */
export async function extractL1Memories(params: ExtractL1Params): Promise<L1ExtractionResult> {
  const { messages, sessionKey, sessionId, projectId, baseDir, config, logger, instanceId: metricInstanceId } = params;
  const options = params.options ?? {};
  const maxNewMessages = options.maxMessagesPerExtraction ?? 10;
  const maxBgMessages = options.maxBackgroundMessages ?? 5;
  const enableDedup = options.enableDedup ?? true;
  const maxMemoriesPerSession = options.maxMemoriesPerSession ?? 10;

  if (messages.length === 0) {
    logger?.debug?.(`${TAG} No messages to extract from`);
    return { success: true, extractedCount: 0, storedCount: 0, records: [], sceneNames: [] };
  }

  const l1StartMs = Date.now();

  // Quality gate: filter messages through L1 extraction rules before LLM.
  const split = filterQualifiedMessages(messages, maxNewMessages, maxBgMessages, logger);
  if (split === null) {
    logger?.debug?.(`${TAG} All messages filtered out by L1 quality gate`);
    return { success: true, extractedCount: 0, storedCount: 0, records: [], sceneNames: [] };
  }

  const { newMessages, backgroundMessages } = split;
  logger?.debug?.(`${TAG} Extracting from ${newMessages.length} new (+ ${backgroundMessages.length} bg) [${split.qualifiedCount} of ${messages.length}]`);

  // Step 1: LLM extraction (scene segmentation + memory extraction), with one retry.
  const llmParams = { newMessages, backgroundMessages, previousSceneName: options.previousSceneName, config, logger, model: options.model, llmRunner: options.llmRunner };

  let outcome;
  try {
    outcome = await callLlmExtraction(llmParams);
    if (outcome.parseFailed) {
      logger?.warn?.(`${TAG} Extraction parse failed, retrying once`);
      outcome = await callLlmExtraction(llmParams);
    }
  } catch (err) {
    logger?.error?.(`${TAG} LLM extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    return { success: false, extractedCount: 0, storedCount: 0, records: [], sceneNames: [], error: "LLM extraction failed" };
  }
  if (outcome.parseFailed) {
    logger?.error?.(`${TAG} LLM extraction failed: response unparseable after retry`);
    return {
      success: false,
      extractedCount: 0,
      storedCount: 0,
      records: [],
      sceneNames: [],
      error: "extraction parse failed after retry",
    };
  }
  logger?.debug?.(`${TAG} LLM detected ${outcome.scenes.length} scene(s)`);

  // Step 2: Flatten all memories across scenes
  const { sceneNames, allExtracted } = flattenScenes(outcome.scenes, logger);
  logger?.debug?.(`${TAG} Total extracted memories: ${allExtracted.length} across ${outcome.scenes.length} scene(s)`);

  if (allExtracted.length === 0) {
    return {
      success: true,
      extractedCount: 0,
      storedCount: 0,
      records: [],
      sceneNames,
      lastSceneName: sceneNames[sceneNames.length - 1],
    };
  }

  // Limit per session
  let extracted = allExtracted;
  if (extracted.length > maxMemoriesPerSession) {
    logger?.debug?.(`${TAG} Limiting from ${extracted.length} to ${maxMemoriesPerSession} memories per session`);
    extracted = extracted.slice(0, maxMemoriesPerSession);
  }

  for (const m of extracted) {
    if (m.content.length > MAX_CONTENT_CHARS) {
      m.content = m.content.slice(0, MAX_CONTENT_CHARS);
    }
  }

  // Assign temporary IDs (needed for batch dedup). I3/I4 scope rules:
  // only literal "global" without project id leaks; scope normalized to
  // what will actually be persisted so dedup filters correctly.
  const memoriesWithIds = prepareMemories(extracted, projectId, sessionKey, logger);

  // Step 3: Batch Conflict Detection + Write
  const storedRecords = await runDedupOrStore({
    memoriesWithIds,
    enableDedup,
    config,
    logger,
    model: options.model,
    vectorStore: options.vectorStore,
    embeddingService: options.embeddingService,
    conflictRecallTopK: options.conflictRecallTopK,
    embeddingTimeoutMs: options.embeddingTimeoutMs,
    llmRunner: options.llmRunner,
    projectId,
    baseDir,
    sessionKey,
    sessionId,
  });

  logger?.info(`${TAG} Extraction complete: extracted=${extracted.length}, stored=${storedRecords.length}`);

  // l1_extraction metric
  if (metricInstanceId && logger) {
    reportExtractionMetric({
      instanceId: metricInstanceId, logger, sessionKey,
      inputMessageCount: messages.length, extractedCount: extracted.length,
      storedRecords, durationMs: Date.now() - l1StartMs,
    });
  }

  return { success: true, extractedCount: extracted.length, storedCount: storedRecords.length, records: storedRecords, sceneNames, lastSceneName: sceneNames[sceneNames.length - 1] };
}

// Re-export shared types for backward compatibility (l1-runner imports).
export type { SceneSegment, L1ExtractionResult } from "./l1-extraction-types.js";
export type { ExtractedMemory };

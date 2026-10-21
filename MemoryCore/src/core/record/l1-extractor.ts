/**
 * L1 Memory Extractor: extracts structured memories from L0 conversation messages
 * using a single LLM call with JSON-mode structured output.
 *
 * v3: Aligned with Kenty's prompt — scene segmentation + memory extraction in one call,
 * followed by batch conflict detection.
 *
 * Pipeline:
 * 1. Read recent messages from L0 (split into background + new)
 * 2. Call LLM to extract scene-segmented memories
 * 3. Batch conflict detection against existing records
 * 4. Write to L1 JSONL files
 */

import type { ConversationMessage } from "../conversation/l0-recorder.js";
import { formatExtractionPrompt, getExtractMemoriesSystemPrompt, type MemoryPromptMode } from "../prompts/l1-extraction.js";
import { batchDedup } from "./l1-dedup.js";
import { writeMemory, generateMemoryId } from "./l1-writer.js";
import type { ExtractedMemory, MemoryRecord, MemoryType, DedupDecision } from "./l1-writer.js";
import { CleanContextRunner } from "../../utils/clean-context-runner.js";
import { sanitizeJsonForParse, shouldExtractL1, findClosedThinkSpans, indexOfOutsideThinkSpan, lastIndexOfOutsideThinkSpan } from "../../utils/sanitize.js";
import type { IMemoryStore } from "../store/types.js";
import type { EmbeddingService } from "../store/embedding.js";
import { report } from "../report/reporter.js";
import { metricProducer } from "../report/kafka-metric-producer.js";
import { reportL1LatencyMetrics } from "../report/metric-tracking-l1-latency.js";
import type { LLMRunner, Logger, TraceContext } from "../types.js";
import { buildTraceParams } from "../types.js";
import { StorageAdapter } from "../storage/adapter.js";
import type { ResolvedMemoryPrompt } from "../memory-prompt/types.js";
import { composeMemorySystemPrompt } from "../memory-prompt/composer.js";
import { LocalStorageBackend } from "../storage/local-backend.js";
import {
  L1_EXTRACTION_JSON_SCHEMA,
  L1_EXTRACTION_SCHEMA_NAME,
  validateL1ExtractionOutput,
  type SceneSegment,
} from "../schema/l1-extraction.js";
import {
  buildGenerationLogIdentity,
  buildGenerationProvenance,
  buildPromptGenerationRef,
  MemoryGenerationLogStore,
} from "../memory-generation-log/store.js";
import { writeGenerationProvenanceBestEffort } from "../memory-generation-log/best-effort.js";
import {
  buildMemoryGenerationRefId,
  type MemoryGenerationLog,
} from "../memory-generation-log/types.js";

const TAG = "[memory-tdai][l1-extractor]";

// ============================
// Types
// ============================

// SceneSegment is now generated from the canonical zod schema
// (../schema/l1-extraction.ts) — one source of truth for the LLM output
// contract, the wire JSON Schema, and the TypeScript type.

export interface L1ExtractionResult {
  /** Whether extraction succeeded */
  success: boolean;
  /**
   * Canonical failure reason — populated iff `success === false`.
   * Consumed by createL1Runner to convert hard failures into a throw so the
   * checkpoint cursor stays put and the pipeline's existing retry/dead-letter
   * machinery takes over (issue #1210: no silent L0 batch loss).
   */
  errorReason?: L1EmptyReason;
  /** Number of memories extracted */
  extractedCount: number;
  /** Number of memories actually stored (after dedup) */
  storedCount: number;
  /** The memory records that were stored */
  records: MemoryRecord[];
  /** Scene names detected during extraction */
  sceneNames: string[];
  /** Last scene name (for continuity in next extraction) */
  lastSceneName?: string;
}

// ============================
// Core function
// ============================

/**
 * Run the full L1 extraction pipeline on conversation messages.
 *
 * @param messages - Filtered conversation messages (from L0 or directly from hook)
 * @param sessionKey - The session key
 * @param baseDir - Base data directory (~/.openclaw/memory-tdai/)
 * @param config - OpenClaw config (for LLM access)
 * @param options - Extraction options
 * @param logger - Optional logger
 */
export async function extractL1Memories(params: {
  messages: ConversationMessage[];
  sessionKey: string;
  sessionId?: string;
  taskId?: string;
  teamId?: string;
  userId?: string;
  agentId?: string;
  baseDir: string;
  config: unknown;
  options?: {
    /** Max new messages to send in one extraction call */
    maxMessagesPerExtraction?: number;
    /** Max background messages for context */
    maxBackgroundMessages?: number;
    /** Enable conflict detection */
    enableDedup?: boolean;
    /** Max memories extracted per call */
    maxMemoriesPerSession?: number;
    /** LLM model override */
    model?: string;
    /** Previous scene name for continuity */
    previousSceneName?: string;
    /** Prompt family for L1 extraction (default: chat). */
    promptMode?: MemoryPromptMode;
    /** Resolved custom strategy. Undefined preserves the current system prompt exactly. */
    memoryPrompt?: ResolvedMemoryPrompt;
    /** Vector store for cosine similarity candidate recall */
    vectorStore?: IMemoryStore;
    /** Embedding service for computing query vectors */
    embeddingService?: EmbeddingService;
    /** Top-K candidates for conflict recall (default: 5) */
    conflictRecallTopK?: number;
    /** Override embedding timeout for capture-path calls (milliseconds) */
    embeddingTimeoutMs?: number;
    /**
     * Host-neutral LLM runner. When provided, used instead of creating
     * a CleanContextRunner (decouples from OpenClaw runtime).
     */
    llmRunner?: LLMRunner;
  };
  logger?: Logger;
  /** Plugin instance ID for metric reporting (optional — metrics skipped if absent) */
  instanceId?: string;
  /**
   * StorageAdapter for L1 JSONL writes.
   * - service mode: must be provided (CosStorageBackend) — JSONL is the source of
   *   truth for backup/recovery; without storage, writes silently fall back to local
   *   pod fs and are lost on pod restart (CR-2 root cause, fixed 2026-05-19).
   * - standalone mode: caller usually provides LocalStorageBackend; if absent,
   *   writeMemory falls back to fs at `{baseDir}/records/{date}.jsonl`.
   */
  storage?: StorageAdapter;
}): Promise<L1ExtractionResult> {
  const { messages, sessionKey, sessionId, taskId, teamId, userId, agentId, baseDir, config, logger, instanceId: metricInstanceId, storage } = params;
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

  // Quality gate: filter messages through L1 extraction rules (length, symbols,
  // prompt injection, etc.) before sending to the LLM. L0 deliberately captures
  // everything; the strict filtering happens here at L1 stage.
  const qualifiedMessages = messages.filter((m) => shouldExtractL1(m.content));
  if (qualifiedMessages.length < messages.length) {
    logger?.debug?.(
      `${TAG} L1 quality filter: ${messages.length} → ${qualifiedMessages.length} messages ` +
      `(${messages.length - qualifiedMessages.length} filtered out)`,
    );
  }

  if (qualifiedMessages.length === 0) {
    logger?.debug?.(`${TAG} All messages filtered out by L1 quality gate`);
    return { success: true, extractedCount: 0, storedCount: 0, records: [], sceneNames: [] };
  }

  // Split messages into background (older) + new (recent)
  const newMessages = qualifiedMessages.slice(-maxNewMessages);
  const bgEndIdx = qualifiedMessages.length - newMessages.length;
  const backgroundMessages = bgEndIdx > 0
    ? qualifiedMessages.slice(Math.max(0, bgEndIdx - maxBgMessages), bgEndIdx)
    : [];

  logger?.debug?.(`${TAG} Extracting from ${newMessages.length} new messages (+ ${backgroundMessages.length} background) [${qualifiedMessages.length} qualified from ${messages.length} input]`);

  // Step 1: LLM extraction (scene segmentation + memory extraction)
  //
  // When we end up with 0 memories at any downstream branch we tag one of the
  // reasons defined by `L1EmptyReason` and let the `allExtracted.length === 0`
  // block below emit a single, greppable `l1-empty reason=<label>` line. This
  // is the ops handle we always wished we had — a silent 0-count run should
  // never happen again.
  let scenes: SceneSegment[];
  let earlyEmptyReason: L1EmptyReason | undefined;
  try {
    const outcome = await callLlmExtraction({
      newMessages,
      backgroundMessages,
      previousSceneName: options.previousSceneName,
      config,
      logger,
      model: options.model,
      promptMode: options.promptMode,
      memoryPrompt: options.memoryPrompt,
      traceContext: { teamId, userId, agentId, sessionId },
      llmRunner: options.llmRunner,
    });
    scenes = outcome.scenes;
    earlyEmptyReason = outcome.emptyReason;
    logger?.debug?.(`${TAG} LLM detected ${scenes.length} scene(s)`);
  } catch (err) {
    logger?.error(`${TAG} LLM extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    logger?.warn?.(
      `${TAG} l1-empty reason=llm_error sessionKey=${sessionKey} msg=${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}`,
    );
    return { success: false, errorReason: "llm_error", extractedCount: 0, storedCount: 0, records: [], sceneNames: [] };
  }

  // Flatten all memories across scenes
  const allExtracted: ExtractedMemory[] = [];
  const sceneNames: string[] = [];

  for (const scene of scenes) {
    sceneNames.push(scene.scene_name);
    for (const mem of scene.memories) {
      const memType = normalizeType(mem.type);
      if (!memType) {
        logger?.warn?.(`${TAG} Skipping memory with invalid type "${mem.type}"`);
        continue;
      }
      allExtracted.push({
        content: mem.content,
        type: memType,
        priority: typeof mem.priority === "number" ? mem.priority : 50,
        source_message_ids: Array.isArray(mem.source_message_ids) ? mem.source_message_ids : [],
        metadata: mem.metadata ?? {},
        scene_name: scene.scene_name,
      });
    }
  }

  logger?.debug?.(`${TAG} Total extracted memories: ${allExtracted.length} across ${scenes.length} scene(s)`);

  // ── Post-repair canonical validation (reviews F4) ─────────────────────
  // Final structural gate on whatever survived parsing / repair /
  // normalization — on EVERY outcome, empty ones included. A "legitimate
  // empty" must itself be structurally valid (e.g. a scene with an empty
  // scene_name fails the domain schema and is an invalid output, not an
  // empty success). Only then may the checkpoint advance.
  if (!validateL1ExtractionOutput(scenes)) {
    logger?.warn?.(`${TAG} Canonical validation failed on normalized scenes — treating as invalid output`);
    return {
      success: false,
      errorReason: "canonical_validation_failed",
      extractedCount: 0,
      storedCount: 0,
      records: [],
      sceneNames,
    };
  }

  if (allExtracted.length === 0) {
    // ── Diagnostic warn line: one greppable reason so ops can see WHY ──
    // Emitted only on the 0-count path (never on success), so log volume stays
    // low. Reason values are the closed set of `L1EmptyReason` — matches the
    // observability contract callers can build dashboards / alerts on.
    //
    // Priority when both are present:
    //   - `earlyEmptyReason` from parseExtractionResult (parse-side signal)
    //   - `normalized_all_dropped` fallback: parse succeeded with scenes, but
    //     the type-normalization loop above rejected every entry.
    const finalReason: L1EmptyReason =
      earlyEmptyReason ?? (scenes.length > 0 ? "normalized_all_dropped" : "empty_scenes");
    logger?.warn?.(
      `${TAG} l1-empty reason=${finalReason} sessionKey=${sessionKey} scenes=${scenes.length} inputMsgs=${messages.length}`,
    );

    // ── Failure semantics (issue #1210) ──
    // Only a *legit* empty outcome ("the model correctly said there is
    // nothing to extract") stays a success. Everything else — unusable model
    // output (no_json / parse_fail / not_array) or memories that were
    // generated but entirely dropped by normalization — is a hard failure:
    // success=false + errorReason, so createL1Runner throws instead of
    // advancing the checkpoint cursor (no silent L0 batch loss).
    const isHardFailure = finalReason !== "empty_scenes";

    // ── 评测指标：L1 提取率（提取为空的情况） ──
    if (metricInstanceId) {
      try {
        const l0Count = messages.length;
        metricProducer.send({ metric: "l0_input_count", instanceId: metricInstanceId, value: l0Count, source: "core" });
        metricProducer.send({ metric: "l1_extracted_count", instanceId: metricInstanceId, value: 0, source: "core" });
        if (l0Count > 0) {
          metricProducer.send({ metric: "l1_extraction_rate", instanceId: metricInstanceId, value: 0, source: "core" });
        }
      } catch {
        // 静默忽略，不影响业务逻辑
      }
    }
    return {
      success: !isHardFailure,
      ...(isHardFailure ? { errorReason: finalReason } : {}),
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

  // Assign temporary IDs to extracted memories (needed for batch dedup)
  const memoriesWithIds = extracted.map((m) => ({
    ...m,
    record_id: generateMemoryId(),
  }));

  // Step 2: Batch Conflict Detection + Write
  let storedRecords: MemoryRecord[];
  let dedupLatencyMs: number | null = null;
  const generationFinishedAt = Date.now();
  const generationIdentity = buildGenerationLogIdentity(
    "l1",
    generationFinishedAt,
    memoriesWithIds[0]?.record_id,
  );
  const generationPrompt = buildPromptGenerationRef(options.memoryPrompt, "l1");
  const generation = buildGenerationProvenance(generationIdentity, generationPrompt);

  if (enableDedup) {
    try {
      const dedupStartMs = Date.now();
      const decisions = await batchDedup({
        memories: memoriesWithIds,
        config,
        logger,
        model: options.model,
        promptMode: options.promptMode,
        vectorStore: options.vectorStore,
        embeddingService: options.embeddingService,
        conflictRecallTopK: options.conflictRecallTopK,
        embeddingTimeoutMs: options.embeddingTimeoutMs,
        llmRunner: options.llmRunner,
        traceContext: { teamId, userId, agentId, sessionId },
        ...(teamId || userId || agentId || sessionId || taskId ? { filter: { teamId, userId, agentId, sessionId, taskId } } : {}),
      });
      dedupLatencyMs = Date.now() - dedupStartMs;

      // ── 评测指标：去重决策分布 ──
      if (metricInstanceId) {
        try {
          const dedupCounts = { store: 0, update: 0, merge: 0, skip: 0 };
          for (const d of decisions) {
            if (d.action in dedupCounts) {
              dedupCounts[d.action as keyof typeof dedupCounts]++;
            }
          }
          metricProducer.send({ metric: "l1_dedup_store_count", instanceId: metricInstanceId, value: dedupCounts.store, source: "core" });
          metricProducer.send({ metric: "l1_dedup_update_count", instanceId: metricInstanceId, value: dedupCounts.update, source: "core" });
          metricProducer.send({ metric: "l1_dedup_merge_count", instanceId: metricInstanceId, value: dedupCounts.merge, source: "core" });
          metricProducer.send({ metric: "l1_dedup_skip_count", instanceId: metricInstanceId, value: dedupCounts.skip, source: "core" });
        } catch {
          // 静默忽略，不影响业务逻辑
        }
      }

      storedRecords = await applyDecisions({
        memoriesWithIds,
        decisions,
        baseDir,
        sessionKey,
        sessionId,
        taskId,
        teamId,
        userId,
        agentId,
        logger,
        vectorStore: options.vectorStore,
        embeddingService: options.embeddingService,
        storage,
      });

    } catch (err) {
      logger?.warn?.(`${TAG} Batch dedup failed, storing all as new: ${err instanceof Error ? err.message : String(err)}`);
      storedRecords = await storeAllDirectly(memoriesWithIds, baseDir, sessionKey, sessionId, taskId, teamId, userId, agentId, logger, options.vectorStore, options.embeddingService, storage);
    }
  } else {
    storedRecords = await storeAllDirectly(memoriesWithIds, baseDir, sessionKey, sessionId, taskId, teamId, userId, agentId, logger, options.vectorStore, options.embeddingService, storage);
  }

  const logStorage = storage ?? new StorageAdapter(new LocalStorageBackend(baseDir));
  const generationLogStore = new MemoryGenerationLogStore(logStorage, metricInstanceId ?? "standalone");
  const generationLog: MemoryGenerationLog = {
    schema_version: 1,
    log_id: generationIdentity.logId,
    generation_id: generationIdentity.generationId,
    instance_id: metricInstanceId ?? "standalone",
    layer: "l1",
    status: "succeeded",
    team_id: teamId,
    agent_id: agentId,
    user_id: userId,
    session_id: sessionId,
    task_id: taskId,
    prompt: generationPrompt,
    anchor_memory_id: storedRecords[0]?.id ?? memoriesWithIds[0]?.record_id,
    input_refs: newMessages.map((message) => ({ layer: "l0", record_id: message.id })),
    output_refs: storedRecords.map((record) => ({ layer: "l1", record_id: record.id })),
    model: options.model,
    prompt_mode: options.promptMode ?? "chat",
    started_at_ms: l1StartMs,
    finished_at_ms: generationFinishedAt,
    latency_ms: generationFinishedAt - l1StartMs,
  };
  await writeGenerationProvenanceBestEffort({
    layer: "l1",
    logger,
    writeLog: () => generationLogStore.write(generationLog, generationIdentity.key),
    writeRefs: options.vectorStore?.upsertMemoryGenerationRefs && storedRecords.length > 0
      ? async () => await options.vectorStore!.upsertMemoryGenerationRefs!(storedRecords.map((record) => ({
          generation_ref_id: buildMemoryGenerationRefId("l1", record.id),
          layer: "l1" as const,
          memory_id: record.id,
          ...generation,
          created_at_ms: generationFinishedAt,
        })))
      : undefined,
  });

  logger?.info(`${TAG} Extraction complete: extracted=${extracted.length}, stored=${storedRecords.length}`);

  // ── l1_extraction metric ──
  if (metricInstanceId && logger) {
    // Build type distribution of stored memories
    const memoriesByType: Record<string, number> = {};
    for (const r of storedRecords) {
      memoriesByType[r.type] = (memoriesByType[r.type] ?? 0) + 1;
    }
    report("l1_extraction", {
      sessionKey,
      inputMessageCount: messages.length,
      memoriesExtracted: extracted.length,
      memoriesStored: storedRecords.length,
      memoriesStoredContent: storedRecords.map((r) => ({
        content: r.content,
        type: r.type,
        scene: r.scene_name ?? null,
      })),
      memoriesByType,
      totalDurationMs: Date.now() - l1StartMs,
      success: true,
      error: null,
    });
  }

  // ── 评测指标：L1 提取率 ──
  if (metricInstanceId) {
    try {
      const l0Count = messages.length;
      const l1Count = extracted.length;
      metricProducer.send({ metric: "l0_input_count", instanceId: metricInstanceId, value: l0Count, source: "core" });
      metricProducer.send({ metric: "l1_extracted_count", instanceId: metricInstanceId, value: l1Count, source: "core" });
      if (l0Count > 0) {
        metricProducer.send({ metric: "l1_extraction_rate", instanceId: metricInstanceId, value: l1Count / l0Count, source: "core" });
      }
    } catch {
      // 静默忽略，不影响业务逻辑
    }
  }

  // ── 评测指标：L1 延迟 ──
  try {
    reportL1LatencyMetrics({
      instanceId: metricInstanceId ?? "",
      extractionLatencyMs: Date.now() - l1StartMs,
      dedupLatencyMs,
      hasError: false,
    });
  } catch {
    // 静默忽略
  }

  return {
    success: true,
    extractedCount: extracted.length,
    storedCount: storedRecords.length,
    records: storedRecords,
    sceneNames,
    lastSceneName: sceneNames[sceneNames.length - 1],
  };
}

// ============================
// LLM call
// ============================

/**
 * Call LLM to extract scene-segmented memories from conversation messages.
 */
async function callLlmExtraction(params: {
  newMessages: ConversationMessage[];
  backgroundMessages: ConversationMessage[];
  previousSceneName?: string;
  config: unknown;
  logger?: Logger;
  model?: string;
  promptMode?: MemoryPromptMode;
  memoryPrompt?: ResolvedMemoryPrompt;
  /** Host-neutral LLM runner — when provided, used instead of CleanContextRunner. */
  llmRunner?: LLMRunner;
  /** langfuse 上报身份四元组（team/user/agent/session）。 */
  traceContext?: TraceContext;
}): Promise<ParseExtractionOutcome> {
  const { newMessages, backgroundMessages, previousSceneName, config, logger, model, promptMode = "chat", memoryPrompt, llmRunner, traceContext } = params;

  const systemPrompt = composeMemorySystemPrompt(getExtractMemoriesSystemPrompt(promptMode), memoryPrompt);
  const userPrompt = formatExtractionPrompt({
    newMessages,
    backgroundMessages,
    previousSceneName,
  });

  // [l1-debug] ENTRY — what are we about to ask the LLM to extract?
  logger?.debug?.(
    `${TAG} [l1-debug] ENTRY taskId=l1-extraction, promptMode=${promptMode}, newMsgs=${newMessages.length}, bgMsgs=${backgroundMessages.length}, userPromptLen=${userPrompt.length}, sysPromptLen=${systemPrompt.length}, model=${model ?? "(default)"}, previousSceneName=${previousSceneName ? JSON.stringify(previousSceneName) : "(none)"}, runnerKind=${llmRunner ? "llmRunner" : "CleanContextRunner"}`,
  );

  let result: string;

  // langfuse trace 语义：让此次 L1 抽取在 UI 有稳定 name / 顶级 user/session 列
  // / 可筛选 tags。避免所有记忆抽取都显示为 Unnamed trace。
  const traceParams = buildTraceParams("memory.l1-extract", traceContext);

  if (llmRunner) {
    // Use the host-neutral LLMRunner interface. structuredOutput is a
    // best-effort capability: StandaloneLLMRunner constrains generation
    // (json_schema → json_object → legacy text, degrading only on explicit
    // provider capability errors); runners that don't know the field (OpenClaw
    // host, mocks) ignore it and run() still resolves with model text.
    result = await llmRunner.run({
      prompt: userPrompt,
      systemPrompt,
      taskId: "l1-extraction",
      timeoutMs: 180_000,
      structuredOutput: {
        schema: L1_EXTRACTION_JSON_SCHEMA,
        schemaName: L1_EXTRACTION_SCHEMA_NAME,
        validate: validateL1ExtractionOutput,
      },
      ...traceParams,
    });
  } else {
    // Fallback: create CleanContextRunner (OpenClaw path)
    const runner = new CleanContextRunner({
      config,
      modelRef: model,
      enableTools: false,
      logger,
    });

    result = await runner.run({
      prompt: userPrompt,
      systemPrompt,
      taskId: "l1-extraction",
      timeoutMs: 180_000,
      ...traceParams,
    });
  }

  return parseExtractionResult(result, logger);
}

/**
 * Coarse classification for a "why did we get zero memories" diagnostic line.
 * Emitted by `extractL1Memories` when the final memory count is 0, so ops can
 * distinguish "LLM returned garbage" from "LLM legitimately said nothing".
 *
 * All values except `empty_scenes` are HARD failures: `extractL1Memories`
 * returns success=false + errorReason, `createL1Runner` throws, the
 * checkpoint cursor stays put, and the pipeline's existing retry /
 * dead-letter machinery takes over (issue #1210).
 */
export type L1EmptyReason =
  | "llm_error"              // LLM call raised (thrown by callLlmExtraction)
  | "no_json"                // /\[[\s\S]*\]/ did not match in raw content
  | "parse_fail"             // JSON.parse threw on the extracted substring
  | "not_array"              // parse succeeded but result is not an array
  | "empty_scenes"           // legit empty: 0 scenes OR all scenes had 0 memories (success)
  | "normalized_all_dropped" // parse OK, memories emitted, but every entry failed type normalization
  | "invalid_memories_dropped" // memories emitted but every one structurally unusable (missing/empty/non-string content) — review F2
  | "invalid_scene_structure"  // scene entries malformed (non-object items; memories/message_ids present but not arrays) — review F4
  | "invalid_output_shape"     // whole response is a JSON object without a scenes array (wrong wrapper, e.g. {"decisions":[]}) — review F4
  | "unclosed_reasoning"     // <think> opened before the JSON payload but never closed — review F7
  | "canonical_validation_failed"; // normalized scenes still fail the canonical domain schema — review F4

interface ParseExtractionOutcome {
  scenes: SceneSegment[];
  /** Populated iff we ended with 0 memories across all scenes. */
  emptyReason?: L1EmptyReason;
}

/**
 * Parse the LLM's JSON response into SceneSegment array.
 * Expected format: [{scene_name, message_ids, memories: [...]}]
 *
 * Diagnostics contract:
 *   - Debug-level [l1-debug] lines dump raw content on NO_JSON / PARSE_FAIL
 *     (unchanged from prior behavior).
 *   - The returned `emptyReason` is the CANONICAL machine-readable label —
 *     `extractL1Memories` uses it to emit a single-line `l1-empty` warn when
 *     the final count is 0, and to decide success=false for hard failures.
 *     See L1EmptyReason for the closed set.
 *
 * Exported for unit tests (parser layers are tested directly).
 */
// ============================
// Payload location helpers live in ../../utils/sanitize.js
// (findClosedThinkSpans / indexOfOutsideThinkSpan) — shared with the dedup
// parser so both tolerate reasoning wrappers identically (review R4).
// ============================

export function parseExtractionResult(raw: string, logger?: Logger): ParseExtractionOutcome {
  try {
    // ── Locate the JSON payload WITHOUT rewriting the text (reviews R4/N1/F7) ──
    // The old approach stripped `<think>…</think>` from the whole response
    // before parsing, which corrupted legitimate memory content that happens
    // to contain a literal think pair (e.g. "<think>reasoning=false</think>"
    // inside a config-snippet memory). Instead: compute the closed-think
    // spans, find the payload boundaries among text OUTSIDE those spans, and
    // slice the ORIGINAL raw text — content literals survive verbatim.
    const spans = findClosedThinkSpans(raw);
    const arrayStart = indexOfOutsideThinkSpan("[", raw, spans);
    const objectStart = indexOfOutsideThinkSpan("{", raw, spans);
    const unclosedThinkIdx = indexOfOutsideThinkSpan("<think>", raw, spans);
    const payloadStart =
      arrayStart === -1 ? objectStart : objectStart === -1 ? arrayStart : Math.min(arrayStart, objectStart);

    // ── Unclosed-think guard (reviews F7 + N1) ─────────────────────────────
    // An unmatched `<think>` positioned BEFORE the JSON payload means the
    // model was still reasoning when output was cut: everything after it is
    // reasoning-in-progress and must never be salvaged for L1. Position
    // matters: a literal "<think>" INSIDE the payload (memory content) is
    // legal text and must not be rejected (regression N1).
    if (unclosedThinkIdx !== -1 && (payloadStart === -1 || unclosedThinkIdx < payloadStart)) {
      logger?.warn?.(
        `${TAG} Unclosed <think> wrapper before JSON payload — treating response as reasoning-in-progress`,
      );
      return { scenes: [], emptyReason: "unclosed_reasoning" };
    }

    // ── Top-level shape adjudication (review F4) ──────────────────────────
    // The contract (prompts + wire schema) is {"scenes": [...]}, with the
    // historical bare array still accepted. If the response's payload is a
    // JSON object, it must carry a `scenes` array — a wrong wrapper (e.g.
    // {"decisions": []}) is an invalid output, not an empty one.
    if (objectStart !== -1 && (arrayStart === -1 || objectStart < arrayStart)) {
      const objectEnd = lastIndexOfOutsideThinkSpan("}", raw, spans);
      if (objectEnd > objectStart) {
        const candidate = raw.slice(objectStart, objectEnd + 1);
        try {
          const whole = JSON.parse(sanitizeJsonForParse(candidate)) as unknown;
          if (whole && typeof whole === "object" && !Array.isArray(whole)) {
            const scenesField = (whole as Record<string, unknown>).scenes;
            if (!Array.isArray(scenesField)) {
              logger?.warn?.(`${TAG} Top-level JSON object without scenes array — invalid output shape`);
              return { scenes: [], emptyReason: "invalid_output_shape" };
            }
            return buildSceneOutcome(scenesField, logger);
          }
        } catch {
          // not a clean whole-response object — tolerate via the array path
        }
      }
    }

    if (arrayStart === -1) {
      logger?.warn?.(`${TAG} No JSON array found in extraction response`);
      // [l1-debug] NO_JSON — dump the full ORIGINAL raw so a novel think/model
      // variant leaves a trace for ops.
      const rawPreview = raw.slice(0, 2048);
      logger?.warn?.(
        `${TAG} [l1-debug] NO_JSON taskId=l1-extraction, rawLen=${raw.length}, closedThinkSpans=${spans.length}, rawFull=${JSON.stringify(rawPreview)}${raw.length > 2048 ? `…(+${raw.length - 2048})` : ""}`,
      );
      return { scenes: [], emptyReason: "no_json" };
    }
    const arrayEnd = lastIndexOfOutsideThinkSpan("]", raw, spans);
    if (arrayEnd <= arrayStart) {
      return { scenes: [], emptyReason: "no_json" };
    }
    const payload = raw.slice(arrayStart, arrayEnd + 1);

    // Sanitize control characters inside JSON string literals that LLM may produce.
    // Some weaker OpenAI-compatible models occasionally emit bare identifiers for
    // numeric fields (e.g. `"priority": sheet`). Repair only known safe fields and
    // retry once so one bad scalar does not drop the whole extraction result.
    const sanitized = sanitizeJsonForParse(payload);
    let parsed: unknown[];
    try {
      parsed = JSON.parse(sanitized) as unknown[];
    } catch (err) {
      const repaired = repairExtractionJson(sanitized);
      if (repaired === sanitized) throw err;
      parsed = JSON.parse(repaired) as unknown[];
      logger?.warn?.(`${TAG} Repaired non-strict extraction JSON: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!Array.isArray(parsed)) {
      logger?.warn?.(`${TAG} Extraction response is not an array`);
      return { scenes: [], emptyReason: "not_array" };
    }

    return buildSceneOutcome(parsed, logger);
  } catch (err) {
    logger?.warn?.(`${TAG} Failed to parse extraction result: ${err instanceof Error ? err.message : String(err)}`);
    logger?.warn?.(
      `${TAG} [l1-debug] PARSE_FAIL rawLen=${raw.length}, rawFull=${JSON.stringify(raw)}`,
    );
    return { scenes: [], emptyReason: "parse_fail" };
  }
}

/**
 * Build the normalized SceneSegment outcome from a parsed scenes array
 * (wrapper or bare). Enforces the scene-level structural contract (review
 * F4): structural errors are preserved as hard failures instead of being
 * silently erased by defaulting.
 */
function buildSceneOutcome(items: unknown[], logger?: Logger): ParseExtractionOutcome {
  const scenes: SceneSegment[] = [];
  let offeredMemories = 0;
  let invalidSceneItems = 0;
  for (const item of items) {
    // Review R1: an ARRAY is not a scene object (typeof [] === "object" would
    // let it slip through) — count it as an invalid scene item, never salvage
    // it into a defaulted "未知情境" pseudo-scene.
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      invalidSceneItems++;
      continue;
    }
    const s = item as Record<string, unknown>;

    // Review F4: fields present with the wrong shape are structural errors —
    // defaulting them to empty arrays would convert invalid output into a
    // bogus "legitimate empty" success.
    if ((s.memories !== undefined && !Array.isArray(s.memories)) ||
        (s.message_ids !== undefined && !Array.isArray(s.message_ids))) {
      logger?.warn?.(
        `${TAG} Scene "${typeof s.scene_name === "string" ? s.scene_name.slice(0, 40) : "(unnamed)"}" has non-array ${!Array.isArray(s.memories) ? "memories" : "message_ids"} — invalid scene structure`,
      );
      return { scenes: [], emptyReason: "invalid_scene_structure" };
    }

    // Review R1: an entry with NO scene structure at all (neither a non-empty
    // scene_name nor a memories array) must not be defaulted into a legit
    // empty scene — `{"scenes":[{}]}` / `{"scenes":[[]]}` are invalid output.
    const hasSceneName = typeof s.scene_name === "string" && s.scene_name.length > 0;
    const hasMemoriesField = Array.isArray(s.memories);
    if (!hasSceneName && !hasMemoriesField) {
      invalidSceneItems++;
      continue;
    }

    scenes.push({
      scene_name: typeof s.scene_name === "string" ? s.scene_name : "未知情境",
      message_ids: Array.isArray(s.message_ids) ? s.message_ids.map(String) : [],
      memories: Array.isArray(s.memories)
        ? (s.memories as Array<Record<string, unknown>>)
            .filter((m) => {
              // Count every emitted candidate BEFORE the structural filter —
              // review F2: "model offered memories but all were structurally
              // unusable" must be classifiable as an invalid output.
              offeredMemories++;
              return m && typeof m === "object" && typeof m.content === "string" && (m.content as string).length > 0;
            })
            .map((m) => ({
              content: String(m.content),
              type: String(m.type ?? "episodic"),
              priority: typeof m.priority === "number" ? m.priority : 50,
              source_message_ids: Array.isArray(m.source_message_ids) ? m.source_message_ids.map(String) : [],
              // Wire decode (review F1): the structured wire represents
              // unused metadata fields as required+nullable — strip null
              // entries so stored metadata carries only real values.
              metadata: decodeMetadata(m.metadata),
            }))
        : [],
    });
  }

  // Review F4: the array had entries but none of them were scene objects.
  if (scenes.length === 0 && invalidSceneItems > 0) {
    logger?.warn?.(`${TAG} All ${invalidSceneItems} scene entries were non-object values`);
    return { scenes: [], emptyReason: "invalid_scene_structure" };
  }

  const totalMemories = scenes.reduce((acc, sc) => acc + sc.memories.length, 0);
  // Review F2: candidates were offered but every one was structurally
  // unusable — an invalid output, NOT a legitimate empty extraction.
  if (totalMemories === 0 && offeredMemories > 0) {
    logger?.warn?.(`${TAG} All ${offeredMemories} offered memories failed structural filtering`);
    return { scenes: [], emptyReason: "invalid_memories_dropped" };
  }
  return {
    scenes,
    emptyReason: totalMemories === 0 ? "empty_scenes" : undefined,
  };
}

/** Wire→domain metadata decode: keep object values, drop null/undefined entries. */
function decodeMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined),
  );
}

function repairExtractionJson(json: string): string {
  return json
    .replace(
      /("priority"\s*:\s*)(?!-?\d+(?:\.\d+)?\s*[,}]|"[^"\\]*(?:\\.[^"\\]*)*"\s*[,}])([\s\S]*?)(?=,\s*"(?:content|type|priority|source_message_ids|metadata)"\s*:|[}\]])/g,
      (_m, prefix: string) => `${prefix}50`,
    )
    .replace(/,\s*([}\]])/g, "$1");
}

// ============================
// Write helpers
// ============================

/**
 * Apply batch dedup decisions — write memories according to their decisions.
 */
async function applyDecisions(params: {
  memoriesWithIds: Array<ExtractedMemory & { record_id: string }>;
  decisions: DedupDecision[];
  baseDir: string;
  sessionKey: string;
  sessionId?: string;
  taskId?: string;
  teamId?: string;
  userId?: string;
  agentId?: string;
  logger?: Logger;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
  storage?: StorageAdapter;
}): Promise<MemoryRecord[]> {
  const { memoriesWithIds, decisions, baseDir, sessionKey, sessionId, taskId, teamId, userId, agentId, logger, vectorStore, embeddingService, storage } = params;
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
        taskId,
        teamId,
        userId,
        agentId,
        logger,
        vectorStore,
        embeddingService,
        storage,
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
async function storeAllDirectly(
  memoriesWithIds: Array<ExtractedMemory & { record_id: string }>,
  baseDir: string,
  sessionKey: string,
  sessionId: string | undefined,
  taskId: string | undefined,
  teamId?: string,
  userId?: string,
  agentId?: string,
  logger?: Logger,
  vectorStore?: IMemoryStore,
  embeddingService?: EmbeddingService,
  storage?: StorageAdapter,
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
        taskId,
        teamId,
        userId,
        agentId,
        logger,
        vectorStore,
        embeddingService,
        storage,
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

// ============================
// Helpers
// ============================

const VALID_TYPES: MemoryType[] = ["persona", "episodic", "instruction", "work_fact", "work_task", "work_method", "work_artifact"];

function normalizeType(raw: string): MemoryType | null {
  const lower = raw.toLowerCase().trim();
  if (VALID_TYPES.includes(lower as MemoryType)) {
    return lower as MemoryType;
  }
  // Handle legacy type names
  if (lower === "episode") return "episodic";
  if (lower === "instruct") return "instruction";
  if (lower === "preference") return "persona"; // fold preference into persona
  return null;
}

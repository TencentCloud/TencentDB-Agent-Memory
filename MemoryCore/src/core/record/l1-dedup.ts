/**
 * L1 Memory Conflict Detection (Batch Mode): decides how to handle multiple new
 * memories against existing records in a single LLM call.
 *
 * Candidate recall uses the same strategy as memory_search (native hybrid, else
 * FTS ∥ client-vector + RRF). Isolation stays session-scoped via IsolationFilter;
 * search's cross-session filter is not reused.
 *
 * If neither FTS, client embedding, nor native hybrid is available, conflict
 * detection is skipped — all memories go straight to store.
 *
 * Two-phase approach:
 * 1. Candidate search per new memory (fast, no LLM)
 * 2. Batch LLM judgment on all new memories + their candidate pools (single call)
 */

import type { MemoryPromptMode } from "../../config.js";
import type { ExtractedMemory, MemoryRecord, DedupDecision, MemoryType } from "./l1-writer.js";
import { formatBatchConflictPrompt, getConflictDetectionSystemPrompt } from "../prompts/l1-dedup.js";
import type { CandidateMatch } from "../prompts/l1-dedup.js";
import { CleanContextRunner } from "../../utils/clean-context-runner.js";
import {
  sanitizeJsonForParse,
  findClosedThinkSpans,
  indexOfOutsideThinkSpan,
  lastIndexOfOutsideThinkSpan,
} from "../../utils/sanitize.js";
import type { IMemoryStore, IsolationFilter, L1SearchResult } from "../store/types.js";
import { hasClientEmbedding, type EmbeddingService } from "../store/embedding.js";
import type { LLMRunner, Logger, TraceContext } from "../types.js";
import { buildTraceParams } from "../types.js";
import { recallL1Candidates } from "../tools/l1-candidate-recall.js";
import {
  L1_DEDUP_JSON_SCHEMA,
  L1_DEDUP_SCHEMA_NAME,
  validateL1DedupOutput,
} from "../schema/l1-extraction.js";

const TAG = "[memory-tdai][l1-dedup]";

// ============================
// Core function (batch mode)
// ============================

/**
 * Batch conflict detection: compare all new memories against existing records
 * in a single LLM call.
 *
 * Candidate recall strategy:
 * 1. Native hybrid (TCVDB dense+sparse) when the store advertises it
 * 2. Otherwise FTS ∥ client-vector in parallel, RRF-merged (same as memory_search)
 * 3. Skip conflict detection entirely — all memories go straight to "store"
 *
 * Isolation is the caller's `filter` (production extraction is session-scoped).
 * Do not reuse search's cross-session isolation here.
 *
 * @param memories - Newly extracted memories (with record_id)
 * @param config - OpenClaw config (for LLM access)
 * @param logger - Optional logger
 * @param model - Optional model override
 * @param vectorStore - Optional vector store for candidate recall
 * @param embeddingService - Optional embedding service for computing query vectors
 * @param conflictRecallTopK - Top-K candidates to recall per new memory (default: 5)
 * @returns Array of dedup decisions, one per new memory
 */
export async function batchDedup(params: {
  memories: Array<ExtractedMemory & { record_id: string }>;
  config: unknown;
  logger?: Logger;
  model?: string;
  /** Prompt family for conflict detection (default: chat). */
  promptMode?: MemoryPromptMode;
  /** Vector store for cosine similarity candidate recall */
  vectorStore?: IMemoryStore;
  /** Embedding service for computing query vectors */
  embeddingService?: EmbeddingService;
  /** Top-K candidates per new memory (default: 5) */
  conflictRecallTopK?: number;
  /** Override embedding timeout for capture-path calls (milliseconds) */
  embeddingTimeoutMs?: number;
  /** Host-neutral LLM runner — when provided, used instead of CleanContextRunner. */
  llmRunner?: LLMRunner;
  /** Isolation filter applied to candidate recall so dedup never crosses tenants. */
  filter?: IsolationFilter;
  /** langfuse 上报身份四元组（team/user/agent/session），透传给 llmRunner。 */
  traceContext?: TraceContext;
}): Promise<DedupDecision[]> {
  const { memories, config, logger, model, promptMode = "chat", vectorStore, embeddingService, llmRunner, filter, traceContext } = params;
  const topK = params.conflictRecallTopK ?? 5;

  if (memories.length === 0) {
    return [];
  }

  const storeAll = () =>
    memories.map((m) => ({
      record_id: m.record_id,
      action: "store" as const,
      target_ids: [],
    }));

  // Determine what recall capabilities are available
  const hasVectorData = !!vectorStore && (await vectorStore.countL1()) > 0;
  const hasFts = vectorStore?.isFtsAvailable() ?? false;
  const nativeHybrid = !!(
    vectorStore &&
    typeof vectorStore.getCapabilities === "function" &&
    vectorStore.getCapabilities().nativeHybridSearch &&
    typeof vectorStore.searchL1Hybrid === "function"
  );

  // Fast path: no recall capability at all → skip dedup
  if (!hasVectorData && !hasFts && !nativeHybrid) {
    logger?.debug?.(`${TAG} No vector data and no FTS available, skipping conflict detection for ${memories.length} memories`);
    return storeAll();
  }

  // D8: a keyword-only backend (e.g. Mongo/mongot BM25) reports vectorSearch=false
  // via capabilities — don't waste embed calls on a store that cannot vector-search;
  // the shared recall helper then degrades to the FTS leg. `?? true` keeps legacy
  // stores that predate the capability surface on the vector path.
  const vectorCapable = (
    typeof vectorStore?.getCapabilities === "function"
      ? vectorStore.getCapabilities().vectorSearch
      : undefined
  ) ?? true;

  // Phase 1: Find candidates — unified hybrid recall (native-hybrid, else
  // FTS ∥ client-vector RRF via recallL1Candidates). A keyword-only store
  // (vectorCapable=false) or a Noop embedding service degrades to the FTS leg
  // inside the shared helper; vector failures are non-fatal there.
  logger?.debug?.(`${TAG} Using hybrid candidate recall (topK=${topK})`);
  const matches = await findCandidates(memories, vectorStore!, vectorCapable ? embeddingService : undefined, topK, logger, params.embeddingTimeoutMs, filter, hasVectorData);

  // Check if any memory has candidates
  const hasAnyCandidates = matches.some((m) => m.candidates.length > 0);

  if (!hasAnyCandidates) {
    logger?.debug?.(`${TAG} No similar records found for any memory, all will be stored`);
    return storeAll();
  }

  // Phase 2: Batch LLM judgment
  return runLlmJudgment(matches, memories, config, logger, model, promptMode, llmRunner, traceContext);
}

/**
 * Phase 2: Run batch LLM judgment on candidate matches.
 */
async function runLlmJudgment(
  matches: CandidateMatch[],
  memories: Array<ExtractedMemory & { record_id: string }>,
  config: unknown,
  logger: Logger | undefined,
  model: string | undefined,
  promptMode: MemoryPromptMode,
  llmRunner?: LLMRunner,
  traceContext?: TraceContext,
): Promise<DedupDecision[]> {
  logger?.debug?.(`${TAG} Running batch conflict detection for ${memories.length} memories (promptMode=${promptMode})`);

  try {
    const userPrompt = formatBatchConflictPrompt(matches);
    const systemPrompt = getConflictDetectionSystemPrompt(promptMode);
    let result: string;

    // langfuse trace 语义：见 l1-extractor.ts 里的说明。dedup 是 L1 的子步骤，
    // 用独立 name 便于在 UI 上区分 "抽取阶段" vs "去重判定阶段"。
    const traceParams = buildTraceParams("memory.l1-dedup", traceContext);

    if (llmRunner) {
      // Use the host-neutral LLMRunner interface. structuredOutput is
      // best-effort (issue #1210): constrains the decision array when the
      // runner supports it; ignored otherwise. The dedup algorithm itself
      // (recall, actions, fallback semantics) is unchanged.
      result = await llmRunner.run({
        prompt: userPrompt,
        systemPrompt,
        taskId: "l1-conflict-detection",
        timeoutMs: 180_000,
        structuredOutput: {
          schema: L1_DEDUP_JSON_SCHEMA,
          schemaName: L1_DEDUP_SCHEMA_NAME,
          validate: validateL1DedupOutput,
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
        taskId: "l1-conflict-detection",
        timeoutMs: 180_000,
        ...traceParams,
      });
    }

    const decisions = parseBatchResult(result, memories, logger);
    return decisions;
  } catch (err) {
    logger?.warn?.(
      `${TAG} Batch conflict detection failed, defaulting all to store: ${err instanceof Error ? err.message : String(err)}`,
    );
    return memories.map((m) => ({
      record_id: m.record_id,
      action: "store" as const,
      target_ids: [],
    }));
  }
}

// ============================
// Candidate recall
// ============================

function hitToMemoryRecord(r: L1SearchResult): MemoryRecord {
  return {
    id: r.record_id,
    content: r.content,
    type: r.type as MemoryRecord["type"],
    priority: r.priority,
    scene_name: r.scene_name,
    source_message_ids: [],
    metadata: r.metadata_json
      ? (() => { try { return JSON.parse(r.metadata_json); } catch { return {}; } })()
      : {},
    timestamps: [r.timestamp_str].filter(Boolean),
    createdAt: "",
    updatedAt: "",
    sessionKey: r.session_key,
    sessionId: r.session_id,
  };
}

/**
 * Hybrid candidate recall (aligned with memory_search):
 * batch-embed when a client embedder exists, then per-memory recallL1Candidates
 * (native hybrid, else FTS ∥ vector + RRF). Exclude self-batch IDs afterwards.
 */
async function findCandidates(
  memories: Array<ExtractedMemory & { record_id: string }>,
  vectorStore: IMemoryStore,
  embeddingService: EmbeddingService | undefined,
  topK: number,
  logger: Logger | undefined,
  embeddingTimeoutMs: number | undefined,
  filter: IsolationFilter | undefined,
  hasVectorData: boolean,
): Promise<CandidateMatch[]> {
  const newRecordIds = new Set(memories.map((m) => m.record_id));
  const nativeHybrid = !!(
    typeof vectorStore.getCapabilities === "function" &&
    vectorStore.getCapabilities().nativeHybridSearch &&
    typeof vectorStore.searchL1Hybrid === "function"
  );

  let queryEmbeddings: Float32Array[] | undefined;
  let vectorSvc = embeddingService;
  if (hasClientEmbedding(embeddingService) && !nativeHybrid) {
    if (hasVectorData) {
      try {
        queryEmbeddings = await embeddingService.embedBatch(
          memories.map((m) => m.content),
          embeddingTimeoutMs ? { timeoutMs: embeddingTimeoutMs } : undefined,
        );
      } catch (err) {
        logger?.warn?.(
          `${TAG} embedBatch failed (non-fatal, FTS may still run): ${err instanceof Error ? err.message : String(err)}`,
        );
        vectorSvc = undefined;
      }
    } else {
      vectorSvc = undefined;
    }
  }

  const recallTopK = topK + memories.length;
  const matches: CandidateMatch[] = [];

  for (let i = 0; i < memories.length; i++) {
    const mem = memories[i];
    const recalled = await recallL1Candidates({
      query: mem.content,
      topK: recallTopK,
      vectorStore,
      embeddingService: vectorSvc,
      logger,
      filter,
      queryEmbedding: queryEmbeddings?.[i],
      embeddingTimeoutMs,
      logTag: TAG,
    });

    const candidates: MemoryRecord[] = recalled.hits
      .filter((r) => !newRecordIds.has(r.record_id))
      .slice(0, topK)
      .map(hitToMemoryRecord);

    matches.push({ newMemory: mem, candidates });
  }

  logger?.debug?.(
    `${TAG} Candidate recall: ${matches.map((m) => `${m.newMemory.record_id}→${m.candidates.length}`).join(", ")}`,
  );

  return matches;
}

// ============================
// Result parsing
// ============================

const VALID_TYPES: MemoryType[] = ["persona", "episodic", "instruction", "work_fact", "work_task", "work_method", "work_artifact"];

/**
 * Parse the LLM's batch conflict detection JSON response.
 *
 * Expected format: [{record_id, action, target_ids, merged_content, merged_type, merged_priority, merged_timestamps}]
 */
/** Exported for unit tests (parser layers are tested directly). */
export function parseBatchResult(
  raw: string,
  memories: Array<ExtractedMemory & { record_id: string }>,
  logger?: Logger,
): DedupDecision[] {
  try {
    // ── Reasoning-wrapper-aware payload location (review R4, mirrors
    // parseExtractionResult): locate the decision array among text OUTSIDE
    // closed <think> spans and slice the ORIGINAL raw text, so literal think
    // tags inside merged_content survive verbatim and stray `[` in think
    // prose cannot anchor the array match.
    const spans = findClosedThinkSpans(raw);
    const unclosedThinkIdx = indexOfOutsideThinkSpan("<think>", raw, spans);
    const arrayStart = indexOfOutsideThinkSpan("[", raw, spans);

    if (unclosedThinkIdx !== -1 && (arrayStart === -1 || unclosedThinkIdx < arrayStart)) {
      logger?.warn?.(`${TAG} Unclosed <think> wrapper before decisions payload — unparsable`);
      return fallbackStoreAll(memories);
    }
    if (arrayStart === -1) {
      logger?.warn?.(`${TAG} No JSON array found in conflict detection response`);
      return fallbackStoreAll(memories);
    }
    const arrayEnd = lastIndexOfOutsideThinkSpan("]", raw, spans);
    if (arrayEnd <= arrayStart) {
      return fallbackStoreAll(memories);
    }
    const payload = raw.slice(arrayStart, arrayEnd + 1);

    // Sanitize control characters inside JSON string literals that LLM may produce
    const sanitized = sanitizeJsonForParse(payload);
    const parsed = JSON.parse(sanitized) as unknown[];

    if (!Array.isArray(parsed)) {
      logger?.warn?.(`${TAG} Conflict detection response is not an array`);
      return fallbackStoreAll(memories);
    }

    // Build decisions from LLM output
    const decisions: DedupDecision[] = [];
    const validActions = ["store", "update", "merge", "skip"];

    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const d = item as Record<string, unknown>;

      const recordId = String(d.record_id ?? "");
      // Skip entries with empty/missing record_id — they are LLM hallucinations
      if (!recordId) {
        logger?.debug?.(`${TAG} Skipping decision with empty record_id`);
        continue;
      }
      const action = String(d.action ?? "store");

      if (!validActions.includes(action)) {
        logger?.warn?.(`${TAG} Invalid action "${action}" for record ${recordId}, defaulting to store`);
      }

      decisions.push({
        record_id: recordId,
        action: validActions.includes(action) ? (action as DedupDecision["action"]) : "store",
        target_ids: Array.isArray(d.target_ids) ? d.target_ids.map(String) : [],
        merged_content: typeof d.merged_content === "string" ? d.merged_content : undefined,
        merged_type: VALID_TYPES.includes(d.merged_type as MemoryType) ? (d.merged_type as MemoryType) : undefined,
        merged_priority: typeof d.merged_priority === "number" ? d.merged_priority : undefined,
        merged_timestamps: Array.isArray(d.merged_timestamps) ? d.merged_timestamps.map(String) : undefined,
      });
    }

    // Ensure all memories have a decision (fill missing with "store")
    const decidedIds = new Set(decisions.map((d) => d.record_id));
    for (const mem of memories) {
      if (!decidedIds.has(mem.record_id)) {
        logger?.debug?.(`${TAG} No decision for record ${mem.record_id}, defaulting to store`);
        decisions.push({
          record_id: mem.record_id,
          action: "store",
          target_ids: [],
        });
      }
    }

    return decisions;
  } catch (err) {
    logger?.warn?.(`${TAG} Failed to parse conflict detection result: ${err instanceof Error ? err.message : String(err)}`);
    return fallbackStoreAll(memories);
  }
}

/**
 * Fallback: store all memories when parsing fails.
 */
function fallbackStoreAll(memories: Array<ExtractedMemory & { record_id: string }>): DedupDecision[] {
  return memories.map((m) => ({
    record_id: m.record_id,
    action: "store" as const,
    target_ids: [],
  }));
}

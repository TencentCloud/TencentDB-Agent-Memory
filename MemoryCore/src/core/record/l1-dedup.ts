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
import { sanitizeJsonForParse } from "../../utils/sanitize.js";
import type { IMemoryStore, IsolationFilter, L1SearchResult } from "../store/types.js";
import { hasClientEmbedding, type EmbeddingService } from "../store/embedding.js";
import type { LLMRunner, Logger, TraceContext } from "../types.js";
import { buildTraceParams } from "../types.js";
import { recallL1Candidates } from "../tools/l1-candidate-recall.js";

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
  const hasVectorData = vectorStore && (await vectorStore.countL1()) > 0;
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
      // Use the host-neutral LLMRunner interface
      result = await llmRunner.run({
        prompt: userPrompt,
        systemPrompt,
        taskId: "l1-conflict-detection",
        timeoutMs: 180_000,
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
function parseBatchResult(
  raw: string,
  memories: Array<ExtractedMemory & { record_id: string }>,
  logger?: Logger,
): DedupDecision[] {
  try {
    // ── Strip inline reasoning wrappers (A₂-style thinking models) ───────
    // Mirror of l1-extractor.ts@ccaa5dc3: A₂ models (minimax-m3 / GLM-4-
    // thinking / qwq-32b / some vLLM DeepSeek-R1) inline reasoning as
    // `<think>…</think>` inside `content`. Their think prose here frequently
    // contains stray `[` (candidate id refs like `[rec_a1]`, JSON preview
    // sketches, priority tags), which fatally derails the greedy
    // `/\[[\s\S]*\]/` array-match below by anchoring it inside the think
    // section. So we peel `<think>` blocks BEFORE the array-match fires.
    //
    // Same safeguards as l1-extractor:
    //   • non-greedy `*?` + explicit `</think>` requirement — truncated
    //     think tags (max_tokens cap) fall through as-is instead of eating
    //     the rest of the response, and the fallbackStoreAll safety net in
    //     the caller then quietly stores everything (dedup no-op).
    //   • `g` flag — multi-segment thinking is fully stripped.
    //   • Preserve untouched `raw` for the [l1-dedup-debug] log path so
    //     ops can still see original wire content when they need to debug
    //     a novel A₂ variant.
    //
    // A₁ models (minimax-m2.7 / deepseek-v4-pro / o1 / o3 / Claude thinking
    // API) put reasoning in a separate reasoning_content field, so `content`
    // never has <think> here — the replace is a no-op (backward-compatible,
    // per [[default-no-config-backward-compat]]).
    const stripped = raw.replace(/<think>[\s\S]*?<\/think>\s*/g, "");

    // Strip markdown code block wrappers
    let cleaned = stripped.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }

    // Extract JSON array
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (!arrayMatch) {
      logger?.warn?.(`${TAG} No JSON array found in conflict detection response`);
      return fallbackStoreAll(memories);
    }

    // Sanitize control characters inside JSON string literals that LLM may produce
    const sanitized = sanitizeJsonForParse(arrayMatch[0]);
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

// ============================
// Same-batch target collision resolution
// ============================

/**
 * Merge same-batch update/merge decisions colliding on the same existing
 * record(s) into ONE merged record (folded decisions become "skip"), so two
 * new memories derived from the same superseded original never coexist with
 * divergent copies of a value. LLM failure returns the input unchanged.
 */
export async function resolveTargetCollisions(params: {
  decisions: DedupDecision[];
  memories: Array<ExtractedMemory & { record_id: string }>;
  config?: unknown;
  logger?: Logger;
  model?: string;
  llmRunner?: LLMRunner;
  vectorStore?: IMemoryStore;
  traceContext?: TraceContext;
}): Promise<DedupDecision[]> {
  const { decisions, memories, config, logger, model, llmRunner, vectorStore, traceContext } = params;
  const active = decisions.filter(
    (d) => (d.action === "update" || d.action === "merge") && d.target_ids.length > 0,
  );
  if (active.length < 2) return decisions;

  const root = new Map<string, string>(active.map((d) => [d.record_id, d.record_id]));
  const find = (x: string): string => {
    while (root.get(x) !== x) x = root.get(x)!;
    return x;
  };
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      if (active[i].target_ids.some((t) => active[j].target_ids.includes(t))) {
        const ra = find(active[i].record_id);
        const rb = find(active[j].record_id);
        if (ra !== rb) root.set(ra, rb);
      }
    }
  }

  const groups = new Map<string, DedupDecision[]>();
  for (const d of active) {
    const k = find(d.record_id);
    const g = groups.get(k);
    if (g) g.push(d);
    else groups.set(k, [d]);
  }

  let changed = false;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const merged = await mergeCollidingGroup(group, memories, vectorStore, config, logger, model, llmRunner, traceContext);
    if (!merged) continue;

    const keeper = group[0];
    keeper.action = "merge";
    keeper.target_ids = [...new Set(group.flatMap((d) => d.target_ids))];
    if (merged.merged_content) keeper.merged_content = merged.merged_content;
    if (merged.merged_type) keeper.merged_type = merged.merged_type;
    if (typeof merged.merged_priority === "number") keeper.merged_priority = merged.merged_priority;
    if (merged.merged_timestamps?.length) keeper.merged_timestamps = merged.merged_timestamps;
    for (const d of group.slice(1)) d.action = "skip";
    changed = true;
    logger?.debug?.(
      `${TAG} Target collision: ${group.length} new memories hit the same existing record(s), merged into ${keeper.record_id}`,
    );
  }

  return decisions;
}

async function mergeCollidingGroup(
  group: DedupDecision[],
  memories: Array<ExtractedMemory & { record_id: string }>,
  vectorStore: IMemoryStore | undefined,
  config: unknown,
  logger: Logger | undefined,
  model: string | undefined,
  llmRunner: LLMRunner | undefined,
  traceContext: TraceContext | undefined,
): Promise<Partial<DedupDecision> | null> {
  try {
    const byId = new Map(memories.map((m) => [m.record_id, m]));
    const newItems = group
      .map((d) => byId.get(d.record_id))
      .filter((m): m is ExtractedMemory & { record_id: string } => !!m)
      .map((m) => ({ record_id: m.record_id, content: m.content, type: m.type, priority: m.priority }));
    if (newItems.length < 2) return null;

    let targetItems: Array<{ record_id: string; content: string }> = [];
    const targetIds = [...new Set(group.flatMap((d) => d.target_ids))];
    if (vectorStore && targetIds.length > 0) {
      const rows = await vectorStore.queryL1Records({ recordIds: targetIds });
      targetItems = rows.map((r) => ({ record_id: r.record_id, content: r.content }));
    }

    const userPrompt = [
      "以下多条新记忆在冲突检测中命中了同一条（或同一组）已有记忆，需要合并为一条最终记忆，避免同批派生出新旧值并存的矛盾记录。",
      "",
      "## 被命中的已有记忆",
      targetItems.length > 0 ? JSON.stringify(targetItems, null, 2) : "（无）",
      "",
      "## 相互冲突的新记忆",
      JSON.stringify(newItems, null, 2),
      "",
      "同一事实有多个值时，以对话中出现得更晚的值为准；其余记忆中仍成立的信息保留进合并结果。输出语言与新记忆一致。",
      '严格输出单个 JSON 对象：{"merged_content": "...", "merged_type": "persona|episodic|instruction|work_fact|work_task|work_method|work_artifact", "merged_priority": 85, "merged_timestamps": ["..."]}',
    ].join("\n");

    const traceParams = buildTraceParams("memory.l1-collision-merge", traceContext);
    const runArgs = {
      prompt: userPrompt,
      systemPrompt: "你是记忆合并器。把多条相互冲突的新记忆合并为一条，只输出 JSON 对象，不输出任何解释。",
      taskId: "l1-collision-merge",
      timeoutMs: 120_000,
      ...traceParams,
    };
    const result = llmRunner
      ? await llmRunner.run(runArgs)
      : await new CleanContextRunner({ config, modelRef: model, enableTools: false, logger }).run(runArgs);

    const cleaned = result
      .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
      .trim()
      .replace(/^```(?:json)?\s*\n?/, "")
      .replace(/\n?```\s*$/, "");
    const obj = cleaned.match(/\{[\s\S]*\}/);
    if (!obj) {
      logger?.warn?.(`${TAG} Collision merge: no JSON object in response`);
      return null;
    }
    const parsed = JSON.parse(sanitizeJsonForParse(obj[0])) as Record<string, unknown>;
    if (typeof parsed.merged_content !== "string" || !parsed.merged_content.trim()) {
      logger?.warn?.(`${TAG} Collision merge: missing merged_content`);
      return null;
    }
    return {
      merged_content: parsed.merged_content,
      merged_type: VALID_TYPES.includes(parsed.merged_type as MemoryType)
        ? (parsed.merged_type as MemoryType)
        : undefined,
      merged_priority: typeof parsed.merged_priority === "number" ? parsed.merged_priority : undefined,
      merged_timestamps: Array.isArray(parsed.merged_timestamps) ? parsed.merged_timestamps.map(String) : undefined,
    };
  } catch (err) {
    logger?.warn?.(
      `${TAG} Collision merge failed, keeping original decisions: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

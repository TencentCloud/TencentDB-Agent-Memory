/**
 * Public types, shared log tag, and recall-path constants for the
 * auto-recall hook. No runtime code beyond the constant declarations.
 */

import type { MemoryRecord } from "../../record/l1-reader.js";
import type { L1SearchResult } from "../../store/types.js";

export const TAG = "[memory-tdai] [recall]";
export const RECALL_TRUNCATION_SUFFIX =
  "…（已截断；可用 tdai_memory_search 或 tdai_conversation_search 查看详情）";
export const MIN_TRUNCATED_RECALL_LINE_CHARS = 40;
export const RECALL_LINE_SEPARATOR = "\n";

/**
 * Memory tools usage guide — injected at the end of memory context so the
 * main agent knows how to actively retrieve deeper information.
 */
export const MEMORY_TOOLS_GUIDE = `<memory-tools-guide>
## 记忆工具调用指南

当上方注入的记忆片段不足以回答用户问题时，可主动调用以下工具获取更多信息：

- **tdai_memory_search**：搜索结构化记忆（L1），适用于回忆用户偏好、历史事件节点、规则等关键信息。
- **tdai_conversation_search**：搜索原始对话（L0），适用于查找具体消息原文、时间线、上下文细节；也可用于补充或校验 memory_search 的结果。
- **read_file**（Scene Navigation 中的路径）：当已定位到相关情境，且需要该场景的完整画像、事件经过或阶段结论时使用。

### ⚠️ 调用次数限制
每轮对话中，tdai_memory_search 和 tdai_conversation_search **合计最多调用 3 次**。
- 首次搜索无结果时，可换关键词或换工具重试，但总调用次数不要超过 3 次。
- 若 3 次搜索后仍无结果，说明该信息不在记忆中，请直接根据已有信息回复用户，不要继续搜索。
</memory-tools-guide>`;

/** A single recalled L1 memory with its search score and type. */
export interface RecalledMemory {
  content: string;
  score: number;
  type: string;
}

/**
 * Version of the `RecallItem` projection (tz-10 C10.7). Bumped when the shape
 * or the meaning of `provenance.status` changes, so a consumer can tell a
 * pre-tz-05 projection from native scope/provenance data.
 */
export const RECALL_ITEM_SCHEMA_VERSION = 1;

/**
 * Structured recall element — what the strategies actually found, before it
 * is rendered for the prompt (tz-10 C10.3). The rendered line is a projection
 * of `formatable`, never the other way round: parsing a line back into fields
 * is what lost ids and scores before tz-10a.
 *
 * tz-10b's `MemoryItem` = `RecallItem & { tokenCost: number }` — the budget
 * and tokenizer belong to the assembler, not to the search path.
 */
export interface RecallItem {
  schemaVersion: typeof RECALL_ITEM_SCHEMA_VERSION;
  /** Store record id. Empty only when the backend does not expose one. */
  memoryId: string;
  kind: "l1";
  content: string;
  /** Everything the renderer needs — single source of the injected line. */
  formatable: FormatableMemory;
  scope: {
    /** null until tz-05 gives records a real owner (C10.7). */
    userId: string | null;
    /** Project the record is tagged to; "" / undefined = untagged. */
    projectId?: string;
    /** 'global' | 'project' | undefined (legacy rows predate scoping). */
    scope?: string;
    sessionKey?: string;
    sessionId?: string;
  };
  provenance: {
    /** L0 messages behind the record; [] until tz-05 (C10.7). */
    sourceIds: string[];
    producer: string;
    createdAt: string;
    updatedAt: string;
    /** "unknown" = projected without native provenance (pre-tz-05). */
    status: "native" | "projected" | "unknown";
  };
  /** `raw` = score as the store returned it; `final` = after every multiplier. */
  score: { raw: number; final: number; reasons: string[] };
}

/** Where a recall diagnostic came from (tz-10 C10.5). */
export type RecallDiagnosticStage =
  "repo" | "scope" | "strategy" | "budget" | "render";

/**
 * One machine-readable note about the recall path. A failure that produces a
 * diagnostic is NOT the same as "no memories" — that conflation is exactly
 * what tz-10 C10.5 forbids.
 */
export interface RecallDiagnostic {
  stage: RecallDiagnosticStage;
  code: string;
  message: string;
  itemId?: string;
}

export interface RecallResult {
  /** L1 relevant memories — prepended to user prompt text (dynamic, per-turn) */
  prependContext?: string;
  /** Stable recall context appended to system prompt (persona, scene nav, tools guide — cacheable) */
  appendSystemContext?: string;
  /** L1 memories that were recalled (with scores), for metric reporting */
  recalledL1Memories?: RecalledMemory[];
  /** L3 Persona raw content loaded during recall (null if none) */
  recalledL3Persona?: string | null;
  /** Effective search strategy used */
  recallStrategy?: string;
  /** Why the result looks the way it does — repo/scope/budget notes (tz-10 C10.5). */
  diagnostics?: RecallDiagnostic[];
}

/** Single source of truth for a memory that can be formatted for the LLM. */
export interface FormatableMemory {
  type: string;
  content: string;
  scene_name?: string;
  /** Activity time range start (段时间 start), may be empty */
  activity_start_time?: string;
  /** Activity time range end (段时间 end), may be empty */
  activity_end_time?: string;
  /** Activity point-in-time (点时间: when it happened), may be empty */
  timestamp?: string;
}

export interface ScoredRecord {
  record: MemoryRecord;
  score: number;
}

/** Timing breakdown from memory search. */
export interface SearchTiming {
  ftsMs: number;
  embeddingMs: number;
  ftsHits: number;
  embeddingHits: number;
}

export interface SearchResult {
  /** Rendered projection of `items`, in the same order. */
  lines: string[];
  items: RecallItem[];
  timing: SearchTiming;
  diagnostics: RecallDiagnostic[];
}

/** What one strategy leg returns: its hits plus why candidates were dropped. */
export interface StrategyResult {
  items: RecallItem[];
  diagnostics: RecallDiagnostic[];
}

/** Search strategy (config-driven). */
export type RecallStrategy = "keyword" | "embedding" | "hybrid";
/** Used for L2/L3 type-rerank. */
export type TypeWeights =
  { instruction: number; persona: number; episodic: number } | undefined;
// Re-export to keep external API stable when callers only have access to ./types.ts.
export type { L1SearchResult };

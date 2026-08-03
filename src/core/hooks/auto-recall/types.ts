/**
 * Public types, shared log tag, and recall-path constants for the
 * auto-recall hook. No runtime code beyond the constant declarations.
 */

import type { MemoryRecord } from "../../record/l1-reader.js";
import type { L1SearchResult } from "../../store/types.js";

export const TAG = "[memory-tdai] [recall]";
export const RECALL_TRUNCATION_SUFFIX = "…（已截断；可用 tdai_memory_search 或 tdai_conversation_search 查看详情）";
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
  lines: string[];
  timing: SearchTiming;
}

/** Search strategy (config-driven). */
export type RecallStrategy = "keyword" | "embedding" | "hybrid";
/** Used for L2/L3 type-rerank. */
export type TypeWeights = { instruction: number; persona: number; episodic: number } | undefined;
// Re-export to keep external API stable when callers only have access to ./types.ts.
export type { L1SearchResult };

/**
 * Public types, shared log tag, and recall-path constants for the
 * auto-recall hook. No runtime code beyond the constant declarations.
 */

import type { MemoryRecord } from "../../record/l1-reader.js";
import type { ContextEnvelope } from "../../context/types.js";

/**
 * The item/diagnostic contracts live in the context domain — the assembler owns
 * them, and search is one of their producers. Re-exported here so the recall
 * path keeps importing them from where it always did, without the two modules
 * importing each other.
 */
import type {
  RecallDiagnostic,
  RecallItem,
} from "../../context/types.js";

export {
  RECALL_ITEM_SCHEMA_VERSION,
  type FormatableMemory,
  type RecallDiagnostic,
  type RecallDiagnosticStage,
  type RecallItem,
} from "../../context/types.js";
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
  /** Why the result looks the way it does — repo/scope/budget notes (tz-10 C10.5). */
  diagnostics?: RecallDiagnostic[];
  /**
   * What the assembly decided (tz-10b). Internal: the HTTP response keeps
   * carrying text, and this is the object that explains it. Absent when there
   * was nothing to assemble.
   */
  envelope?: ContextEnvelope;
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
export type TypeWeights = { instruction: number; persona: number; episodic: number } | undefined;
// Re-export to keep external API stable when callers only have access to ./types.ts.
export type { L1SearchResult };

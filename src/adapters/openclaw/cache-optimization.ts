/**
 * OpenClaw cache-optimization adapter.
 *
 * Pure, host-neutral helpers that shape recalled memory content for
 * prompt-cache friendliness with prefix-matching providers
 * (OpenAI-compatible: DeepSeek, MiMo, etc.).
 *
 * This module follows the adapter-layer convention established for recall
 * injection: host-specific *shaping* lives under `src/adapters/openclaw/`,
 * keeping TDAI Core's recall path free of presentation concerns while the
 * logic itself remains a pure, independently-testable function.
 *
 * The functions here have no OpenClaw runtime dependencies, so they can be
 * reused by the core recall path and unit-tested in isolation.
 */

/**
 * Memory tools usage guide — injected at the end of stable context so the
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

export type CacheOptimizationMode = "none" | "stable_wrapper" | "split_system";

export interface CacheOptimizationInput {
  /** Cache optimization strategy (from recall.cacheOptimization). */
  cacheOptimization: CacheOptimizationMode;
  /** Stable persona content (L3). Placed before CACHE_BOUNDARY in split_system mode. */
  personaContent?: string;
  /** Stable scene navigation (L2). */
  sceneNavigation?: string;
  /** Dynamic L1 memory lines (changes every turn). */
  memoryLines: string[];
  /** Separator used to join memory lines. */
  separator: string;
  /** When true, deduplicate identical memory lines before shaping. */
  dedup?: boolean;
}

export interface CacheOptimizationResult {
  /** Persona placed BEFORE CACHE_BOUNDARY (split_system only). */
  prependSystemAddition?: string;
  /** Stable content after CACHE_BOUNDARY (persona/scene/tools). */
  appendSystemContext?: string;
  /** Dynamic L1 memories for the user-prompt prefix (wrapped for stability). */
  prependContext?: string;
}

/**
 * Remove exact-duplicate memory lines while preserving first-seen order.
 *
 * Defensive against double-injection (e.g. when a record is returned by both
 * the keyword and embedding paths and survives RRF merge with differing
 * formatting). Deterministic and side-effect free.
 */
export function dedupeRecallLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

/**
 * Build cache-optimized prompt context from recalled pieces.
 *
 * Pure function — identical output for identical input. This is the single
 * source of truth for how `none` / `stable_wrapper` / `split_system` shape the
 * prompt; the core recall path and any adapter both delegate here.
 *
 * Strategy matrix:
 *   - "none" (legacy): prependContext = <relevant-memories> (no stable wrapper,
 *     no empty placeholder). Persona + scene + tools live in appendSystemContext.
 *   - "stable_wrapper": same stable parts, but prependContext is wrapped in
 *     <memory-context state="active|empty"> so the outer prefix is consistent
 *     across turns (empty placeholder keeps structure when no memory recalled).
 *   - "split_system": additionally moves persona into prependSystemAddition
 *     (placed BEFORE CACHE_BOUNDARY for caching); scene + tools stay after.
 */
export function buildCacheOptimizedContext(input: CacheOptimizationInput): CacheOptimizationResult {
  const { cacheOptimization, personaContent, sceneNavigation, separator } = input;
  const memoryLines = input.dedup ? dedupeRecallLines(input.memoryLines) : input.memoryLines;

  const useStableWrapper = cacheOptimization === "stable_wrapper" || cacheOptimization === "split_system";
  const useSplitSystem = cacheOptimization === "split_system";

  const stableParts: string[] = [];
  let prependSystemAddition: string | undefined;

  if (useSplitSystem) {
    // Split mode: persona goes BEFORE CACHE_BOUNDARY (prependSystemAddition).
    // Scene nav + tools guide stay in appendSystemContext (after boundary).
    if (personaContent) {
      prependSystemAddition = `<user-persona>\n${personaContent}\n</user-persona>`;
    }
    if (sceneNavigation) {
      stableParts.push(`<scene-navigation>\n${sceneNavigation}\n</scene-navigation>`);
    }
  } else {
    // Legacy / stable_wrapper: all stable content in appendSystemContext.
    if (personaContent) {
      stableParts.push(`<user-persona>\n${personaContent}\n</user-persona>`);
    }
    if (sceneNavigation) {
      stableParts.push(`<scene-navigation>\n${sceneNavigation}\n</scene-navigation>`);
    }
  }

  // Dynamic part: L1 relevant memories (changes every turn) → prependContext.
  let prependContext: string | undefined;
  if (useStableWrapper) {
    if (memoryLines.length > 0) {
      prependContext =
        `<memory-context state="active">\n以下是当前对话召回的相关记忆，不代表当前任务进程，仅作为参考：\n\n${memoryLines.join(separator)}\n</memory-context>`;
    } else {
      // Empty placeholder keeps the prefix stable even when no memories recalled.
      prependContext = `<memory-context state="empty"></memory-context>`;
    }
  } else {
    // Legacy mode: <relevant-memories> (no stable wrapper, no empty placeholder).
    if (memoryLines.length > 0) {
      prependContext =
        `<relevant-memories>\n以下是当前对话召回的相关记忆，不代表当前任务进程，仅作为参考：\n\n${memoryLines.join(separator)}\n</relevant-memories>`;
    }
  }

  if (stableParts.length > 0 || prependContext || prependSystemAddition) {
    stableParts.push(MEMORY_TOOLS_GUIDE);
  }

  const appendSystemContext = stableParts.length > 0 ? stableParts.join("\n\n") : undefined;

  return { prependSystemAddition, appendSystemContext, prependContext };
}

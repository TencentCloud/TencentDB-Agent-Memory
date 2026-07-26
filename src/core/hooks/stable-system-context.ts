/**
 * Stable (cacheable) system context assembly.
 *
 * Recall output is split into two regions with very different cache
 * behaviour:
 *
 *   stable   — persona, scene navigation, memory-tools guide.  Identical
 *              across turns for as long as the underlying profile files are
 *              unchanged, so it can live inside a provider's reusable prefix.
 *   dynamic  — L1 relevant memories.  Different on nearly every turn.
 *
 * This module owns the stable half.  It is deliberately pure and free of I/O
 * so the property that actually matters for prompt caching — *the same inputs
 * must produce byte-identical output on every turn* — can be asserted
 * directly in tests rather than inferred from a live recall run.
 *
 * Placement of the resulting block (before or after the host's cache
 * boundary) is a host concern and is decided in the OpenClaw adapter, not
 * here.  See `src/adapters/openclaw/system-context-placement.ts`.
 */

import { dedupeStableSystemPromptAdditions } from "../../utils/system-prompt-dedupe.js";

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

export interface StableSystemContextInput {
  /** L3 persona content, already stripped of scene navigation. */
  persona?: string;
  /** L2 scene navigation block. */
  sceneNavigation?: string;
  /**
   * Whether the turn also carries dynamic recall.  The tools guide is only
   * worth its tokens when there is memory context to reason about, so it is
   * appended when either a stable part or dynamic recall exists.
   */
  hasDynamicRecall: boolean;
}

export interface StableSystemContextResult {
  /** Assembled stable block, or undefined when there is nothing stable. */
  text?: string;
  /** Sources that survived dedupe, in emission order. */
  sources: string[];
  /** Sources dropped because an identical block was already present. */
  removedSources: string[];
  /** Characters saved by dedupe. */
  removedChars: number;
}

/**
 * Assemble the stable system context for one turn.
 *
 * The output depends only on `input`.  Notably it does NOT depend on the
 * dynamic recall text, the turn index, the session, or the clock — that
 * independence is what keeps the provider's reusable prefix intact while L1
 * recall churns underneath it.
 */
export function buildStableSystemContext(
  input: StableSystemContextInput,
): StableSystemContextResult {
  const parts: Array<{ source: string; text: string }> = [];

  // Normalize before wrapping. The profile files are rewritten by the L2/L3
  // pipeline, so a gained or lost trailing newline is routine — and once the
  // content is wrapped in a tag, that whitespace is interior and no longer
  // reachable by the outer trim in the dedupe step. Left alone it would
  // change the block's bytes and invalidate the cached prefix for a turn
  // whose profile did not meaningfully change.
  const persona = normalizeStableBlock(input.persona);
  const sceneNavigation = normalizeStableBlock(input.sceneNavigation);

  if (persona) {
    parts.push({ source: "persona", text: `<user-persona>\n${persona}\n</user-persona>` });
  }
  if (sceneNavigation) {
    parts.push({
      source: "scene-navigation",
      text: `<scene-navigation>\n${sceneNavigation}\n</scene-navigation>`,
    });
  }
  if (parts.length > 0 || input.hasDynamicRecall) {
    parts.push({ source: "memory-tools-guide", text: MEMORY_TOOLS_GUIDE });
  }

  const deduped = dedupeStableSystemPromptAdditions(parts);
  return {
    text: deduped.text,
    sources: deduped.kept.map((part) => part.source ?? "unknown"),
    removedSources: deduped.removed.map((part) => part.source ?? "unknown"),
    removedChars: deduped.removedChars,
  };
}

/**
 * Collapse line-ending and trailing-whitespace churn that carries no meaning
 * for the model, so equal profile content always yields equal bytes.
 */
function normalizeStableBlock(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const normalized = text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
  return normalized || undefined;
}

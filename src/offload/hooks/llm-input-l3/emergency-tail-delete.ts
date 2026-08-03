/**
 * emergency-tail-delete.ts — Tail deletion fallback for emergency compress.
 * Extracted from llm-input-l3.ts (Group D decomposition).
 *
 * When head-delete is blocked by a user message at index 0, delete the
 * largest deletable tool-pair group from the tail to make progress.
 */
import { tiktokenCount, jsonReplacer } from "../../context-token-tracker.js";
import {
  extractToolCallId,
  extractAllToolUseIds,
  isAssistantMessageWithToolUse,
  isToolResultMessage,
} from "../../l3-helpers.js";
import type { PluginLogger } from "../../types.js";
import { findLastUserMessageIndex } from "./user-protection.js";
import { EMERGENCY_MIN_MESSAGES_TO_KEEP } from "./score-cascade-constants.js";

/**
 * Emergency tail-delete: when head-delete is blocked by user message at index 0,
 * delete the largest deletable **tool pair group** (assistant[tool_use] + all its
 * toolResults) to avoid orphaned tool_use/tool_result (Anthropic 400 error).
 *
 * Strategy:
 * 1. Scan messages to build "tool pair groups" — each group is an assistant
 *    message with tool_use blocks + all its corresponding toolResult messages.
 * 2. Score each group by total token count.
 * 3. Delete the largest group. Repeat until below target.
 */
export function _emergencyTailDelete(
  messages: any[],
  targetTokens: number,
  currentTokens: number,
  deletedToolCallIds: string[],
  logger: PluginLogger,
): { count: number; tokens: number } {
  let totalDeleted = 0;
  let totalTokensDeleted = 0;

  while (currentTokens - totalTokensDeleted > targetTokens && messages.length > EMERGENCY_MIN_MESSAGES_TO_KEEP) {
    const lastUserIdx = findLastUserMessageIndex(messages);

    const groups: Array<{ indices: number[]; tokens: number; toolCallIds: string[] }> = [];
    const claimed = new Set<number>();

    // Pass 1: Find assistant(tool_use) messages and their paired toolResults
    for (let i = 1; i < messages.length; i++) {
      if (claimed.has(i)) continue;
      if (i === lastUserIdx) continue;
      const msg = messages[i];
      const tuIds = extractAllToolUseIds(msg);
      if (tuIds.length > 0 && isAssistantMessageWithToolUse(msg)) {
        const groupIndices = [i];
        const groupToolCallIds = [...tuIds];
        claimed.add(i);
        const tuIdSet = new Set(tuIds);
        for (let j = i + 1; j < messages.length; j++) {
          if (claimed.has(j)) continue;
          if (j === lastUserIdx) continue;
          if (isToolResultMessage(messages[j])) {
            const tid = extractToolCallId(messages[j]);
            if (tid && tuIdSet.has(tid)) {
              groupIndices.push(j);
              claimed.add(j);
              tuIdSet.delete(tid);
              if (tuIdSet.size === 0) break;
            }
          }
        }
        let groupTokens = 0;
        for (const idx of groupIndices) {
          groupTokens += tiktokenCount(JSON.stringify(messages[idx], jsonReplacer));
        }
        groups.push({ indices: groupIndices, tokens: groupTokens, toolCallIds: groupToolCallIds });
      }
    }

    // Pass 2: Orphaned toolResult messages (no paired assistant)
    for (let i = 1; i < messages.length; i++) {
      if (claimed.has(i)) continue;
      if (i === lastUserIdx) continue;
      if (messages.length - i <= 1) continue;
      const msg = messages[i];
      if (isToolResultMessage(msg)) {
        const tid = extractToolCallId(msg);
        const t = tiktokenCount(JSON.stringify(msg, jsonReplacer));
        groups.push({ indices: [i], tokens: t, toolCallIds: tid ? [tid] : [] });
        claimed.add(i);
      }
    }

    // Pass 3: Plain assistant messages (no tool_use)
    for (let i = 1; i < messages.length; i++) {
      if (claimed.has(i)) continue;
      if (i === lastUserIdx) continue;
      if (messages.length - i <= 1) continue;
      const msg = messages[i];
      const role = msg.role ?? msg.message?.role ?? msg.type;
      if (role === "assistant") {
        const t = tiktokenCount(JSON.stringify(msg, jsonReplacer));
        groups.push({ indices: [i], tokens: t, toolCallIds: [] });
        claimed.add(i);
      }
    }

    if (groups.length === 0) break;

    groups.sort((a, b) => b.tokens - a.tokens);
    const best = groups[0];
    if (best.tokens <= 0) break;
    if (messages.length - best.indices.length < EMERGENCY_MIN_MESSAGES_TO_KEEP) break;

    const sortedIndices = [...best.indices].sort((a, b) => b - a);
    for (const idx of sortedIndices) {
      messages.splice(idx, 1);
    }
    for (const tid of best.toolCallIds) {
      deletedToolCallIds.push(tid);
    }
    totalDeleted += best.indices.length;
    totalTokensDeleted += best.tokens;
    logger.debug?.(
      `[context-offload] EMERGENCY tail-delete: removed ${best.indices.length} msgs (group tokens=${best.tokens}, ids=[${best.toolCallIds.slice(0, 3).join(",")}${best.toolCallIds.length > 3 ? "..." : ""}]), remaining≈${currentTokens - totalTokensDeleted}`,
    );
  }

  return { count: totalDeleted, tokens: totalTokensDeleted };
}

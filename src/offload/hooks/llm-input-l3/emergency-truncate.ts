/**
 * emergency-truncate.ts — In-place truncation of an oversized message
 * as a last-resort fallback during emergency compress.
 * Extracted from llm-input-l3.ts (Group D decomposition).
 */
import { tiktokenCount, jsonReplacer, invalidateTokenCache } from "../../context-token-tracker.js";
import {
  extractToolCallId,
  extractAllToolUseIds,
  extractToolUseIdFromAssistant,
  isAssistantMessageWithToolUse,
  isToolResultMessage,
} from "../../l3-helpers.js";
import type { PluginLogger } from "../../types.js";
import { findLastUserMessageIndex } from "./user-protection.js";
import { _truncateAssistantToolUseContent, _setMessageContent, _stripLargeFields } from "./emergency-helpers.js";

/**
 * Emergency truncate: when both head-delete and tail-delete are blocked
 * (e.g. only MIN_KEEP messages remain but one is 142K tokens), truncate
 * the LARGEST message content in-place to break the deadlock.
 *
 * Strategy:
 * 1. Find the largest non-user message by token count.
 * 2. If it's a tool result, replace content with a truncated stub.
 * 3. If truncation fails or message is protected, try deleting it entirely
 *    (ignoring MIN_KEEP for this single critical operation).
 */
export function _emergencyTruncateOversized(
  messages: any[],
  targetTokens: number,
  currentTokens: number,
  deletedToolCallIds: string[],
  logger: PluginLogger,
): { tokensSaved: number } {
  const lastUserIdx = findLastUserMessageIndex(messages);
  let bestIdx = -1;
  let bestTokens = 0;

  for (let i = 0; i < messages.length; i++) {
    if (i === lastUserIdx) continue;
    const msg = messages[i];
    if (msg._mmdContextMessage || msg._mmdInjection) continue;
    const tokens = tiktokenCount(JSON.stringify(msg, jsonReplacer));
    if (tokens > bestTokens) {
      bestTokens = tokens;
      bestIdx = i;
    }
  }

  if (bestIdx < 0 || bestTokens <= 0) return { tokensSaved: 0 };

  // Skip if the largest message is already small enough — truncation would
  // make it LARGER (stub text overhead > original content). ~600 tokens is
  // the approximate size of the stub + preview.
  if (bestTokens < 600) return { tokensSaved: 0 };

  const msg = messages[bestIdx];
  const role = msg.role ?? msg.message?.role ?? msg.type;
  const isAssistantTU = isAssistantMessageWithToolUse(msg);
  const toolCallId = extractToolCallId(msg) ?? extractToolUseIdFromAssistant(msg);

  try {
    if (isAssistantTU) {
      _truncateAssistantToolUseContent(msg, bestTokens, logger);
    } else {
      const stubText =
        `[Tool output truncated for context management. Original ~${bestTokens} tokens, role=${role}${toolCallId ? `, id=${toolCallId}` : ""}]`;
      _setMessageContent(msg, stubText);
      _stripLargeFields(msg);
    }
    invalidateTokenCache(msg);
    if (msg._cachedTokens !== undefined) delete msg._cachedTokens;
    if (msg._tokenCount !== undefined) delete msg._tokenCount;

    const afterTokens = tiktokenCount(JSON.stringify(msg, jsonReplacer));
    const saved = bestTokens - afterTokens;

    if (toolCallId) deletedToolCallIds.push(toolCallId);

    logger.warn(
      `[context-offload] EMERGENCY truncate-in-place: idx=${bestIdx}, role=${role}, isToolUse=${isAssistantTU}, ` +
      `${bestTokens}→${afterTokens} tokens (saved=${saved}), id=${toolCallId ?? "N/A"}`,
    );
    return { tokensSaved: saved };
  } catch (truncErr) {
    logger.warn(`[context-offload] EMERGENCY truncate failed (${truncErr}), force-deleting msg idx=${bestIdx}`);
    let totalSaved = bestTokens;
    const tuIds = isAssistantTU ? new Set(extractAllToolUseIds(msg)) : null;
    messages.splice(bestIdx, 1);
    if (toolCallId) deletedToolCallIds.push(toolCallId);

    if (tuIds && tuIds.size > 0) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (!isToolResultMessage(messages[i])) continue;
        const tid = extractToolCallId(messages[i]);
        if (tid && tuIds.has(tid)) {
          totalSaved += tiktokenCount(JSON.stringify(messages[i], jsonReplacer));
          messages.splice(i, 1);
          deletedToolCallIds.push(tid);
          tuIds.delete(tid);
          if (tuIds.size === 0) break;
        }
      }
    }
    return { tokensSaved: totalSaved };
  }
}

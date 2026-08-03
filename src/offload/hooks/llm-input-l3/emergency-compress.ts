/**
 * emergency-compress.ts — Last-resort L3 compression.
 * Extracted from llm-input-l3.ts (Group D decomposition).
 */
import { buildTiktokenContextSnapshot, tiktokenCount, jsonReplacer } from "../../context-token-tracker.js";
import { findHistoryMmdInsertionPoint, findActiveMmdInsertionPoint } from "../../mmd-injector.js";
import {
  extractToolCallId,
  extractToolUseIdFromAssistant,
  isToolResultMessage,
  isToolUseInAssistant,
} from "../../l3-helpers.js";
import type { PluginLogger } from "../../types.js";
import { capDeleteCountForUserMessage } from "./user-protection.js";
import { _emergencyTailDelete } from "./emergency-tail-delete.js";
import { _emergencyTruncateOversized } from "./emergency-truncate.js";
import { EMERGENCY_MIN_MESSAGES_TO_KEEP } from "./score-cascade-constants.js";

export function emergencyCompress(
  messages: any[],
  targetTokens: number,
  countTokens: (t: string) => number,
  sysPrompt: string | null,
  promptText: string | null,
  logger: PluginLogger,
): { deletedCount: number; deletedToolCallIds: string[]; remainingTokens: number } {
  const mmdMsgs: { msg: any }[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]._mmdContextMessage || messages[i]._mmdInjection) {
      mmdMsgs.unshift({ msg: messages.splice(i, 1)[0] });
    }
  }

  const deletedToolCallIds: string[] = [];
  let deletedCount = 0;

  // Single full snapshot at entry, then incremental subtraction in the loop
  let currentTokens = buildTiktokenContextSnapshot("emergency_est", messages, sysPrompt, promptText).totalTokens;

  while (messages.length > EMERGENCY_MIN_MESSAGES_TO_KEEP) {
    if (currentTokens <= targetTokens) break;
    const excessRatio = Math.min(0.5, (currentTokens - targetTokens) / currentTokens);
    let deleteCount2 = Math.max(1, Math.ceil(messages.length * excessRatio));
    deleteCount2 = Math.min(deleteCount2, messages.length - EMERGENCY_MIN_MESSAGES_TO_KEEP);
    while (deleteCount2 < messages.length - EMERGENCY_MIN_MESSAGES_TO_KEEP) {
      const nextMsg = messages[deleteCount2];
      const role = nextMsg?.role ?? nextMsg?.message?.role ?? nextMsg?.type;
      if (role === "toolResult" || role === "tool") { deleteCount2++; } else { break; }
    }
    deleteCount2 = capDeleteCountForUserMessage(messages, deleteCount2);
    if (deleteCount2 <= 0) {
      // Head-delete is blocked (user message at index 0).
      // Fallback: delete the LARGEST non-user messages from the tail to make progress.
      // This is the last resort — emergency MUST make progress.
      const tailDeleted = _emergencyTailDelete(messages, targetTokens, currentTokens, deletedToolCallIds, logger);
      deletedCount += tailDeleted.count;
      currentTokens -= tailDeleted.tokens;
      if (tailDeleted.count <= 0) {
        // Both head-delete and tail-delete are stuck.
        // Last-resort: truncate the LARGEST message content in-place.
        const truncResult = _emergencyTruncateOversized(messages, targetTokens, currentTokens, deletedToolCallIds, logger);
        currentTokens -= truncResult.tokensSaved;
        if (truncResult.tokensSaved <= 0) break; // truly nothing left to do
      }
      continue;
    }
    // Calculate deleted tokens before splicing (incremental subtraction)
    const deletedTokens = tiktokenCount(JSON.stringify(messages.slice(0, deleteCount2), jsonReplacer));
    const toDelete = messages.splice(0, deleteCount2);
    currentTokens -= deletedTokens;
    for (const msg of toDelete) {
      if (isToolResultMessage(msg) || isToolUseInAssistant(msg)) {
        const toolCallId = extractToolCallId(msg) ?? extractToolUseIdFromAssistant(msg);
        if (toolCallId) deletedToolCallIds.push(toolCallId);
      }
    }
    deletedCount += toDelete.length;
  }

  // Restore MMD messages and compensate token count
  for (const { msg } of mmdMsgs) {
    const mmdTokens = tiktokenCount(JSON.stringify(msg, jsonReplacer));
    if (msg._mmdContextMessage === "history" || msg._mmdInjection) {
      const restoreIdx = findHistoryMmdInsertionPoint(messages);
      messages.splice(restoreIdx, 0, msg);
    } else {
      // Active MMD: use the same insertion logic as mmd-injector to avoid
      // breaking tool_call/tool_result pairing or user→assistant alternation.
      const insertIdx = findActiveMmdInsertionPoint(messages);
      messages.splice(insertIdx, 0, msg);
    }
    currentTokens += mmdTokens;
  }

  return { deletedCount, deletedToolCallIds, remainingTokens: currentTokens };
}

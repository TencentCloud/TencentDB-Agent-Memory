/**
 * aggressive-compress.ts — One-shot aggressive L3 compression.
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
import type { OffloadEntry, PluginLogger } from "../../types.js";
import type { OffloadStateManager } from "../../state-manager.js";
import { capDeleteCountForUserMessage, findLastUserMessageIndex } from "./user-protection.js";
import { AGGRESSIVE_MIN_MESSAGES_TO_KEEP } from "./score-cascade-constants.js";

/**
 * Compute how many messages to delete from the head to bring total tokens
 * below threshold.  One-shot: accumulate per-message token costs from the
 * head until enough tokens have been removed.
 */
export function computeAggressiveDeleteCount(
  messages: any[],
  remainingTokens: number,
  aggressiveThreshold: number,
  countTokens: (t: string) => number,
  maxDeletable: number,
): number {
  if (messages.length === 0 || maxDeletable <= 0) return 0;
  if (remainingTokens <= aggressiveThreshold) return 0; // already below target
  // Need to remove (remainingTokens - aggressiveThreshold) tokens from messages
  const tokensToDelete = remainingTokens - aggressiveThreshold;
  const perMsg = messages.map((m: any) => countTokens(JSON.stringify(m)));
  let acc = 0;
  let deleteCount = 0;
  for (let i = 0; i < messages.length && deleteCount < maxDeletable; i++) {
    acc += perMsg[i];
    deleteCount = i + 1;
    if (acc >= tokensToDelete) break;
  }
  // Minimum progress guarantee: if head messages are tiny (offloaded summaries)
  // and we couldn't reach tokensToDelete, ensure at least 20% of messages are deleted.
  if (acc < tokensToDelete && deleteCount > 0) {
    const minByCount = Math.max(1, Math.ceil(messages.length * 0.2));
    deleteCount = Math.max(deleteCount, Math.min(minByCount, maxDeletable));
  }
  return deleteCount;
}

export function adjustDeleteCountForToolPairing(messages: any[], initialDeleteCount: number): number {
  if (initialDeleteCount <= 0 || initialDeleteCount >= messages.length) return initialDeleteCount;
  let count = initialDeleteCount;
  while (count < messages.length && isToolResultMessage(messages[count])) count++;
  return count;
}

/**
 * One-shot aggressive compression.  Computes the exact cut point to bring
 * tokens below threshold in a single pass, then splices once.
 * No multi-round while loop — O(N) tiktoken + O(1) splice.
 */
export async function aggressiveCompressUntilBelowThreshold(
  messages: any[],
  offloadMap: Map<string, OffloadEntry>,
  currentTaskNodeIds: Set<string>,
  deleteRatio: number,
  stateManager: OffloadStateManager,
  logger: PluginLogger,
  aggressiveThreshold: number,
  countTokens: (t: string) => number,
  sysPrompt: string | null,
  promptText: string | null,
): Promise<{ deletedCount: number; rounds: number; remainingTokens: number; allDeletedToolCallIds: string[]; stalledByUserMsg?: boolean }> {
  const allDeletedToolCallIds: string[] = [];
  let remainingTokens = buildTiktokenContextSnapshot("l3_aggressive_est", messages, sysPrompt, promptText).totalTokens;
  let stalledByUserMsg = false;

  logger.debug?.(`[context-offload] L3-aggressive entry: msgs=${messages.length}, remainingTokens=${remainingTokens}, threshold=${aggressiveThreshold}, minKeep=${AGGRESSIVE_MIN_MESSAGES_TO_KEEP}`);

  if (remainingTokens < aggressiveThreshold || messages.length <= AGGRESSIVE_MIN_MESSAGES_TO_KEEP) {
    return { deletedCount: 0, rounds: 0, remainingTokens, allDeletedToolCallIds, stalledByUserMsg };
  }

  // ── Extract MMD messages before computing delete count ──
  const mmdMsgs: { msg: any }[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]._mmdContextMessage || messages[i]._mmdInjection) {
      mmdMsgs.unshift({ msg: messages.splice(i, 1)[0] });
    }
  }

  // ── One-shot: compute exactly how many to delete to reach threshold ──
  const maxDeletable = Math.max(0, messages.length - AGGRESSIVE_MIN_MESSAGES_TO_KEEP);
  let deleteCount = computeAggressiveDeleteCount(messages, remainingTokens, aggressiveThreshold, countTokens, maxDeletable);
  deleteCount = adjustDeleteCountForToolPairing(messages, deleteCount);
  const preCapCount = deleteCount;
  deleteCount = capDeleteCountForUserMessage(messages, deleteCount);
  if (deleteCount < preCapCount) {
    logger.debug?.(`[context-offload] L3-AGGRESSIVE capDeleteCountForUserMessage: ${preCapCount} → ${deleteCount} (lastUserIdx=${findLastUserMessageIndex(messages)})`);
  }

  if (deleteCount <= 0) {
    stalledByUserMsg = true;
    logger.warn(`[context-offload] L3-aggressive STALLED: deleteCount=0 (user msg at head?), remaining≈${remainingTokens}, msgs=${messages.length}`);
    // Restore MMD messages
    for (const { msg } of mmdMsgs) {
      if (msg._mmdContextMessage === "history" || msg._mmdInjection) {
        messages.splice(findHistoryMmdInsertionPoint(messages), 0, msg);
      } else {
        messages.splice(findActiveMmdInsertionPoint(messages), 0, msg);
      }
    }
    return { deletedCount: 0, rounds: 1, remainingTokens, allDeletedToolCallIds, stalledByUserMsg };
  }

  // ── Calculate deleted token cost and splice ──
  const deletedTokens = tiktokenCount(JSON.stringify(messages.slice(0, deleteCount), jsonReplacer));
  const toDelete = messages.splice(0, deleteCount);

  // Collect tool call IDs
  for (const msg of toDelete) {
    const toolCallId = extractToolCallId(msg) ?? extractToolUseIdFromAssistant(msg);
    if ((isToolResultMessage(msg) || isToolUseInAssistant(msg)) && toolCallId && allDeletedToolCallIds.length < 200) {
      allDeletedToolCallIds.push(toolCallId);
    }
  }

  remainingTokens -= deletedTokens;
  logger.debug?.(
    `[context-offload] L3-AGGRESSIVE one-shot: deleted=${toDelete.length} msgs, remaining≈${remainingTokens}, msgsLeft=${messages.length}, ` +
    `toolCallIds=[${allDeletedToolCallIds.slice(0, 5).join(",")}${allDeletedToolCallIds.length > 5 ? `...+${allDeletedToolCallIds.length - 5}` : ""}]`,
  );

  // ── Restore MMD context messages ──
  for (const { msg } of mmdMsgs) {
    if (msg._mmdContextMessage === "history" || msg._mmdInjection) {
      const restoreIdx = findHistoryMmdInsertionPoint(messages);
      messages.splice(restoreIdx, 0, msg);
    } else {
      const insertIdx = findActiveMmdInsertionPoint(messages);
      messages.splice(insertIdx, 0, msg);
    }
  }

  return { deletedCount: toDelete.length, rounds: 1, remainingTokens, allDeletedToolCallIds, stalledByUserMsg };
}

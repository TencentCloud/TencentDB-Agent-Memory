/**
 * score-cascade.ts — Mild L3 compression via score cascade.
 * Extracted from llm-input-l3.ts (Group D decomposition).
 *
 * The replacement loop is split into its own helper (score-cascade-replace.ts)
 * to keep this file ≤150 lines.
 */
import type { OffloadEntry, PluginLogger } from "../../types.js";
import {
  normalizeToolCallIdForLookup,
  getOffloadEntry,
  isToolResultMessage,
  isOnlyToolUseAssistant,
  isAssistantMessageWithToolUse,
  extractToolCallId,
  extractAllToolUseIds,
  replaceWithSummary,
  replaceAssistantToolUseWithSummary,
  compressNonCurrentToolUseBlocks,
} from "../../l3-helpers.js";
import { applyMildCascadeReplacements } from "./score-cascade-replace.js";
import { MILD_CASCADE_FLOOR_SCORE, MILD_CASCADE_MIN_COUNT, MILD_CASCADE_INITIAL_SCORE } from "./score-cascade-constants.js";

export function compressByScoreCascade(
  messages: any[],
  offloadMap: Map<string, OffloadEntry>,
  currentTaskNodeIds: Set<string>,
  scanRatio: number,
  logger: PluginLogger,
  minCount = MILD_CASCADE_MIN_COUNT,
  initialScore = MILD_CASCADE_INITIAL_SCORE,
): { replacedCount: number; lastOffloadedId: string | null; finalThreshold: number; replacedToolCallIds: string[]; replacedDetails: Array<{ toolCallId: string; score: number; summaryPreview: string; originalLength?: number; summaryLength?: number }> } {
  const totalMessages = messages.length;
  const scanEnd = Math.floor(totalMessages * scanRatio);
  const candidates: any[] = [];
  for (let i = 0; i < scanEnd; i++) {
    const msg = messages[i];
    if (msg._offloaded) continue;
    if (!isToolResultMessage(msg)) {
      if (isOnlyToolUseAssistant(msg)) {
        const tuIds = extractAllToolUseIds(msg);
        if (tuIds.length > 0) {
          let allHaveEntry = true;
          let minScore = Infinity;
          const tuEntries: OffloadEntry[] = [];
          for (const tuId of tuIds) {
            const entry = getOffloadEntry(offloadMap, tuId);
            if (!entry) { allHaveEntry = false; break; }
            tuEntries.push(entry);
            const s = entry.score ?? 5;
            if (s < minScore) minScore = s;
          }
          if (allHaveEntry && tuEntries.length > 0) {
            candidates.push({
              msgIndex: i, toolCallId: tuIds[0], offloadEntry: tuEntries[0],
              score: minScore, isAssistantToolUse: true,
              allToolUseIds: tuIds, allOffloadEntries: tuEntries,
            });
          }
        }
      }
      continue;
    }
    const toolCallId = extractToolCallId(msg);
    if (!toolCallId) continue;
    const offloadEntry = getOffloadEntry(offloadMap, toolCallId);
    if (!offloadEntry) continue;
    candidates.push({ msgIndex: i, toolCallId, offloadEntry, score: offloadEntry.score ?? 5 });
  }
  if (candidates.length === 0) {
    logger.debug?.(`[context-offload] L3-MILD: 0 candidates in scan range (0..${scanEnd}/${totalMessages}), offloadMap=${offloadMap.size} entries`);
    return { replacedCount: 0, lastOffloadedId: null, finalThreshold: initialScore, replacedToolCallIds: [], replacedDetails: [] };
  }
  candidates.sort((a: any, b: any) => b.score - a.score);

  // Score distribution: count candidates at each score level
  const scoreDist = new Map<number, number>();
  for (const c of candidates) {
    const s = c.score;
    scoreDist.set(s, (scoreDist.get(s) ?? 0) + 1);
  }
  const scoreDistStr = [...scoreDist.entries()].sort((a, b) => b[0] - a[0]).map(([s, n]) => `score=${s}:${n}`).join(", ");
  logger.debug?.(`[context-offload] L3-MILD: ${candidates.length} candidates (scan 0..${scanEnd}/${totalMessages}), distribution=[${scoreDistStr}], offloadMap=${offloadMap.size}`);

  const toolCallIdToResultIdx = new Map<string, number>();
  const toolCallIdToAssistantIdx = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (isToolResultMessage(m)) {
      const tid = extractToolCallId(m);
      if (tid) {
        toolCallIdToResultIdx.set(tid, i);
        const tidNorm = normalizeToolCallIdForLookup(tid);
        if (tidNorm !== tid) toolCallIdToResultIdx.set(tidNorm, i);
      }
    }
    if (isAssistantMessageWithToolUse(m)) {
      const tuIds = extractAllToolUseIds(m);
      for (const tuId of tuIds) {
        toolCallIdToAssistantIdx.set(tuId, i);
        const tuIdNorm = normalizeToolCallIdForLookup(tuId);
        if (tuIdNorm !== tuId) toolCallIdToAssistantIdx.set(tuIdNorm, i);
      }
    }
  }

  const replaceResult = applyMildCascadeReplacements({
    messages,
    candidates,
    offloadMap,
    toolCallIdToResultIdx,
    toolCallIdToAssistantIdx,
    initialScore,
    minCount,
    logger,
  });
  if (replaceResult.replacedIds.size > 0) {
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (isAssistantMessageWithToolUse(msg)) {
        compressNonCurrentToolUseBlocks(msg, offloadMap, currentTaskNodeIds, replaceResult.replacedIds);
      }
    }
  }
  return {
    replacedCount: replaceResult.replacedCount,
    lastOffloadedId: replaceResult.lastOffloadedId,
    finalThreshold: replaceResult.activeThreshold,
    replacedToolCallIds: replaceResult.replacedToolCallIdList,
    replacedDetails: replaceResult.replacedDetails,
  };
}

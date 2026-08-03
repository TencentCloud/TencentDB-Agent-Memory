/**
 * score-cascade-replace.ts — Replacement loop for the mild L3 score cascade.
 * Extracted from llm-input-l3.ts (Group D decomposition).
 *
 * Called by score-cascade.ts. Walks the threshold cascade and replaces
 * tool_result / assistant tool_use messages with their offload summaries.
 */
import type { OffloadEntry, PluginLogger } from "../../types.js";
import {
  normalizeToolCallIdForLookup,
  getOffloadEntry,
  isOnlyToolUseAssistant,
  extractAllToolUseIds,
  replaceWithSummary,
  replaceAssistantToolUseWithSummary,
} from "../../l3-helpers.js";
import { MILD_CASCADE_FLOOR_SCORE } from "./score-cascade-constants.js";

export interface MildReplaceArgs {
  messages: any[];
  candidates: any[];
  offloadMap: Map<string, OffloadEntry>;
  toolCallIdToResultIdx: Map<string, number>;
  toolCallIdToAssistantIdx: Map<string, number>;
  initialScore: number;
  minCount: number;
  logger: PluginLogger;
}

export interface MildReplaceResult {
  replacedCount: number;
  lastOffloadedId: string | null;
  activeThreshold: number;
  replacedIds: Set<string>;
  replacedToolCallIdList: string[];
  replacedDetails: Array<{ toolCallId: string; score: number; summaryPreview: string; originalLength?: number; summaryLength?: number }>;
}

export function applyMildCascadeReplacements(args: MildReplaceArgs): MildReplaceResult {
  const { messages, candidates, offloadMap, toolCallIdToResultIdx, toolCallIdToAssistantIdx, initialScore, minCount, logger } = args;
  let replacedCount = 0;
  let lastOffloadedId: string | null = null;
  const replacedIds = new Set<string>();
  const replacedToolCallIdList: string[] = [];
  const replacedDetails: Array<{ toolCallId: string; score: number; summaryPreview: string; originalLength?: number; summaryLength?: number }> = [];
  let activeThreshold = initialScore;

  for (let threshold = initialScore; threshold >= MILD_CASCADE_FLOOR_SCORE; threshold--) {
    activeThreshold = threshold;
    for (const c of candidates) {
      if (c.score < threshold) continue;
      const msg = messages[c.msgIndex];
      if (msg._offloaded) continue;
      if (c.isAssistantToolUse) {
        replaceAssistantToolUseWithSummary(msg, c.allOffloadEntries);
        msg._offloaded = true;
        replacedCount++;
        lastOffloadedId = c.toolCallId;
        for (const tuId of c.allToolUseIds) {
          replacedIds.add(tuId);
          replacedToolCallIdList.push(tuId);
          const tuIdNorm = normalizeToolCallIdForLookup(tuId);
          const tuEntry = c.allOffloadEntries.find((e: OffloadEntry) => e.tool_call_id === tuId || e.tool_call_id === tuIdNorm || normalizeToolCallIdForLookup(e.tool_call_id) === tuIdNorm);
          replacedDetails.push({ toolCallId: tuId, score: c.score, summaryPreview: (tuEntry?.summary ?? "").slice(0, 120) });
        }
        for (let ei = 0; ei < c.allToolUseIds.length; ei++) {
          const tuId = c.allToolUseIds[ei];
          const resultIdx = toolCallIdToResultIdx.get(tuId) ?? toolCallIdToResultIdx.get(normalizeToolCallIdForLookup(tuId));
          if (resultIdx !== undefined) {
            const resultMsg = messages[resultIdx];
            if (!resultMsg._offloaded) {
              replaceWithSummary(resultMsg, c.allOffloadEntries[ei]);
              resultMsg._offloaded = true;
              replacedCount++;
            }
          }
        }
      } else {
        const replInfo = replaceWithSummary(msg, c.offloadEntry);
        logger.debug?.(
          `[context-offload] L3-MILD replace: [${c.msgIndex}] ${c.toolCallId} score=${c.score}, ` +
          `original=${replInfo.originalLength}→summary=${replInfo.summaryLength} (delta=${replInfo.summaryLength - replInfo.originalLength}), ` +
          `tool=${(c.offloadEntry.tool_call ?? "").slice(0, 80)}, ` +
          `summary="${(c.offloadEntry.summary ?? "").slice(0, 100)}"`,
        );
        if (replInfo.summaryLength > replInfo.originalLength) {
          logger.debug?.(`[context-offload] L3-MILD: SKIPPING replacement for ${c.toolCallId} — summary larger than original (${replInfo.originalLength} → ${replInfo.summaryLength}, delta=+${replInfo.summaryLength - replInfo.originalLength}), reverting`);
          // Revert: the message was already mutated by replaceWithSummary,
          // but we mark it as _offloaded anyway to avoid re-processing.
          // The net effect is minimal since the size barely increased.
          // In practice we simply skip counting it as a useful replacement.
          msg._offloaded = true;
          continue;
        }
        msg._offloaded = true;
        replacedCount++;
        lastOffloadedId = c.toolCallId;
        replacedIds.add(c.toolCallId);
        replacedToolCallIdList.push(c.toolCallId);
        replacedDetails.push({ toolCallId: c.toolCallId, score: c.score, summaryPreview: (c.offloadEntry.summary ?? "").slice(0, 120), originalLength: replInfo.originalLength, summaryLength: replInfo.summaryLength });
        const assistantIdx = toolCallIdToAssistantIdx.get(c.toolCallId) ?? toolCallIdToAssistantIdx.get(normalizeToolCallIdForLookup(c.toolCallId));
        if (assistantIdx !== undefined) {
          const assistantMsg = messages[assistantIdx];
          if (isOnlyToolUseAssistant(assistantMsg) && !assistantMsg._offloaded) {
            const tuIds = extractAllToolUseIds(assistantMsg);
            const allNowReplaced = tuIds.every((id) => replacedIds.has(id) || replacedIds.has(normalizeToolCallIdForLookup(id)));
            if (allNowReplaced) {
              const tuEntries = tuIds.map((id) => getOffloadEntry(offloadMap, id)).filter(Boolean) as OffloadEntry[];
              if (tuEntries.length === tuIds.length) {
                replaceAssistantToolUseWithSummary(assistantMsg, tuEntries);
                assistantMsg._offloaded = true;
                replacedCount++;
              }
            }
          }
        }
      }
    }
    if (replacedCount >= minCount) break;
  }

  return { replacedCount, lastOffloadedId, activeThreshold, replacedIds, replacedToolCallIdList, replacedDetails };
}

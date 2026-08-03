/**
 * fastpath.ts — Defensive fast-path re-apply + latest-turn extraction.
 * Extracted from llm-input-l3.ts (Group D decomposition).
 */
import { readOffloadEntries } from "../../storage.js";
import {
  normalizeToolCallIdForLookup,
  getOffloadEntry,
  populateOffloadLookupMap,
  isToolResultMessage,
  isOnlyToolUseAssistant,
  isAssistantMessageWithToolUse,
  extractToolCallId,
  extractAllToolUseIds,
  replaceWithSummary,
  replaceAssistantToolUseWithSummary,
  compressNonCurrentToolUseBlocks,
} from "../../l3-helpers.js";
import type { OffloadEntry, PluginLogger } from "../../types.js";
import type { OffloadStateManager } from "../../state-manager.js";

export function extractLatestTurn(historyMessages: any[], currentPrompt: string | null): string | null {
  let lastAssistant: string | null = null;
  for (let i = historyMessages.length - 1; i >= 0; i--) {
    const msg = historyMessages[i];
    if (msg._mmdContextMessage || msg._mmdInjection) continue;
    const role = msg.role ?? msg.message?.role ?? msg.type;
    if (role === "assistant") {
      const text = extractMsgText(msg);
      if (text && text.length > 10) { lastAssistant = text.slice(0, 600); break; }
    }
  }
  const parts: string[] = [];
  if (currentPrompt) parts.push(`[Current User Message]: ${currentPrompt.slice(0, 500)}`);
  if (lastAssistant) parts.push(`[Assistant]: ${lastAssistant}`);
  return parts.length > 0 ? parts.join("\n") : null;
}

export function extractMsgText(msg: any): string {
  const content = msg.content ?? msg.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((c: any) => c.type === "text" && typeof c.text === "string").map((c: any) => c.text).join(" ");
  return "";
}

export async function fastPathReApply(messages: any[], stateManager: OffloadStateManager, logger: PluginLogger): Promise<{ applied: number; deleted: number }> {
  const hasConfirmed = stateManager.confirmedOffloadIds?.size > 0;
  const hasDeleted = stateManager.deletedOffloadIds?.size > 0;
  if (!hasConfirmed && !hasDeleted) return { applied: 0, deleted: 0 };

  let needsWork = false;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg._offloaded) continue;
    const tid = extractToolCallId(msg);
    if (!tid) continue;
    const tidNorm = normalizeToolCallIdForLookup(tid);
    if (hasDeleted && (stateManager.deletedOffloadIds.has(tid) || stateManager.deletedOffloadIds.has(tidNorm))) { needsWork = true; break; }
    if (hasConfirmed && (stateManager.confirmedOffloadIds.has(tid) || stateManager.confirmedOffloadIds.has(tidNorm))) {
      if (isToolResultMessage(msg)) { needsWork = true; break; }
    }
  }
  if (!needsWork) return { applied: 0, deleted: 0 };

  let offloadMap = stateManager.getCachedOffloadMap();
  if (!offloadMap) {
    const offloadEntries = await readOffloadEntries(stateManager.ctx);
    offloadMap = new Map();
    populateOffloadLookupMap(offloadMap, offloadEntries);
    stateManager.setCachedOffloadMap(offloadMap);
  }

  let applied = 0;
  const indicesToDelete: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const tid = extractToolCallId(msg);
    const tidNorm = tid ? normalizeToolCallIdForLookup(tid) : null;
    if (tid && hasDeleted && (stateManager.deletedOffloadIds.has(tid) || (tidNorm && stateManager.deletedOffloadIds.has(tidNorm)))) {
      indicesToDelete.push(i); continue;
    }
    if (hasDeleted && isOnlyToolUseAssistant(msg)) {
      const tuIds = extractAllToolUseIds(msg);
      if (tuIds.length > 0 && tuIds.every((id) => stateManager.deletedOffloadIds.has(id) || stateManager.deletedOffloadIds.has(normalizeToolCallIdForLookup(id)))) {
        indicesToDelete.push(i); continue;
      }
    }
    if (hasDeleted && isAssistantMessageWithToolUse(msg) && !isOnlyToolUseAssistant(msg)) {
      const content = msg.type === "message" ? msg.message?.content : msg.content;
      if (Array.isArray(content)) {
        for (let j = content.length - 1; j >= 0; j--) {
          const block = content[j] as any;
          if ((block.type === "tool_use" || block.type === "toolCall") && block.id) {
            const blockIdNorm = normalizeToolCallIdForLookup(block.id);
            if (stateManager.deletedOffloadIds.has(block.id) || stateManager.deletedOffloadIds.has(blockIdNorm)) {
              content.splice(j, 1);
            }
          }
        }
      }
    }
    if (msg._offloaded) continue;
    if (tid && hasConfirmed && (stateManager.confirmedOffloadIds.has(tid) || (tidNorm && stateManager.confirmedOffloadIds.has(tidNorm)))) {
      const entry = getOffloadEntry(offloadMap, tid);
      if (entry && isToolResultMessage(msg)) {
        replaceWithSummary(msg, entry);
        msg._offloaded = true;
        applied++;
      }
    }
    if (isOnlyToolUseAssistant(msg)) {
      const tuIds = extractAllToolUseIds(msg);
      const allConfirmed = tuIds.length > 0 && tuIds.every((id) =>
        stateManager.confirmedOffloadIds.has(id) || stateManager.confirmedOffloadIds.has(normalizeToolCallIdForLookup(id)));
      if (allConfirmed) {
        const tuEntries = tuIds.map((id) => getOffloadEntry(offloadMap, id)).filter(Boolean) as OffloadEntry[];
        if (tuEntries.length === tuIds.length) {
          replaceAssistantToolUseWithSummary(msg, tuEntries);
          msg._offloaded = true;
          applied++;
        }
      }
    } else if (isAssistantMessageWithToolUse(msg)) {
      compressNonCurrentToolUseBlocks(msg, offloadMap, new Set(), stateManager.confirmedOffloadIds);
    }
  }
  if (indicesToDelete.length > 0) {
    for (let k = indicesToDelete.length - 1; k >= 0; k--) messages.splice(indicesToDelete[k], 1);
  }
  return { applied, deleted: indicesToDelete.length };
}

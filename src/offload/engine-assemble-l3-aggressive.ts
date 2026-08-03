/**
 * engine-assemble-l3-aggressive.ts — L3 aggressive compression stage.
 * Extracted from engine-assemble-l3.ts (Group D decomposition).
 */
import { buildTiktokenContextSnapshot, tiktokenCount, jsonReplacer } from "./context-token-tracker.js";
import { findHistoryMmdInsertionPoint } from "./mmd-injector.js";
import { extractToolCallId, isToolResultMessage } from "./l3-helpers.js";
import { markOffloadStatus } from "./storage.js";
import { PLUGIN_DEFAULTS, type OffloadEntry, type PluginLogger } from "./types.js";
import type { OffloadStateManager } from "./state-manager.js";
import { aggressiveCompressUntilBelowThreshold, buildHistoryMmdInjection, removeExistingMmdInjections } from "./hooks/llm-input-l3.js";
import { _msgFingerprint } from "./engine-helpers.js";

export interface AggressiveArgs {
  workMessages: any[];
  stateManager: OffloadStateManager;
  prompt: string | null;
  aggressiveThreshold: number;
  systemTokensEstimate: number;
  offloadMap: Map<string, OffloadEntry>;
  offloadEntryArr: OffloadEntry[];
  currentTaskNodeIds: Set<string>;
  pCfg: any;
  logger: PluginLogger;
  workingTokens: number;
  contextWindow: number;
}

export interface AggressiveResult {
  workingTokens: number;
  deletedCount: number;
  rounds: number;
  tokensBefore: number;
  tokensAfter: number;
  durationMs: number;
  deletedIds: string[];
  mmdInjected: number;
  mmdTokens: number;
}

export async function runL3Aggressive(args: AggressiveArgs): Promise<AggressiveResult> {
  const { workMessages, stateManager, prompt, aggressiveThreshold, systemTokensEstimate, offloadMap, offloadEntryArr, currentTaskNodeIds, pCfg, logger, workingTokens: _w, contextWindow } = args;
  const empty: AggressiveResult = { workingTokens: _w, deletedCount: 0, rounds: 0, tokensBefore: _w, tokensAfter: _w, durationMs: 0, deletedIds: [], mmdInjected: 0, mmdTokens: 0 };
  if (_w < aggressiveThreshold) return empty;

  // TAIL-ACCUMULATE (first run, no boundary)
  if (!stateManager._lastAggressiveBoundary && workMessages.length > 0 && prompt && prompt.length > 0) {
    const TAIL_ACCUM_TARGET_RATIO = 0.60;
    const tailAccumTarget = Math.floor(contextWindow * TAIL_ACCUM_TARGET_RATIO) - systemTokensEstimate;
    const _tailStart = Date.now();
    let accum = 0;
    let keepFrom = 0;
    for (let i = workMessages.length - 1; i >= 0; i--) {
      const msgTokens = tiktokenCount(JSON.stringify(workMessages[i], jsonReplacer));
      if (accum + msgTokens > tailAccumTarget) { keepFrom = i + 1; break; }
      accum += msgTokens;
    }
    while (keepFrom < workMessages.length && isToolResultMessage(workMessages[keepFrom])) { accum += tiktokenCount(JSON.stringify(workMessages[keepFrom], jsonReplacer)); keepFrom++; }
    if (workMessages.length - keepFrom < 10) keepFrom = Math.max(0, workMessages.length - 10);
    if (keepFrom <= 0 || keepFrom >= workMessages.length) {
      return { workingTokens: _w, deletedCount: 0, rounds: 1, tokensBefore: _w, tokensAfter: _w, durationMs: Date.now() - _tailStart, deletedIds: [], mmdInjected: 0, mmdTokens: 0 };
    }
    const tailDeletedIds: string[] = [];
    for (let d = 0; d < keepFrom; d++) { const tid = extractToolCallId(workMessages[d]); if (tid) tailDeletedIds.push(tid); }
    workMessages.splice(0, keepFrom);
    const workingTokens = accum + systemTokensEstimate;
    const deletedCount = keepFrom;
    const tokensAfter = workingTokens;
    const durationMs = Date.now() - _tailStart;
    if (tailDeletedIds.length > 0) {
      const statusUpdates = new Map<string, string | boolean>();
      for (const id of tailDeletedIds) { statusUpdates.set(id, "deleted"); stateManager.confirmedOffloadIds.add(id); stateManager.deletedOffloadIds.add(id); }
      markOffloadStatus(stateManager.ctx, statusUpdates).catch(() => {});
    }
    const boundaryFp = _msgFingerprint(workMessages[0]);
    stateManager._lastAggressiveBoundary = { originalIndex: 0, fingerprint: boundaryFp, keptMsgCount: workMessages.length, remainingTokens: workingTokens };
    return { workingTokens, deletedCount, rounds: 1, tokensBefore: _w, tokensAfter, durationMs, deletedIds: tailDeletedIds, mmdInjected: 0, mmdTokens: 0 };
  }

  // Standard aggressive path
  const aggressiveDeleteRatio = pCfg.aggressiveDeleteRatio ?? PLUGIN_DEFAULTS.aggressiveDeleteRatio;
  const AGGRESSIVE_TARGET_RATIO = 0.85;
  const aggressiveTargetForMsgs = Math.max(0, Math.floor(aggressiveThreshold * AGGRESSIVE_TARGET_RATIO) - systemTokensEstimate);
  const { createL3TokenCounter } = await import("./l3-token-counter.js");
  const countTokens = createL3TokenCounter(pCfg, logger);
  const _aggStart = Date.now();
  const result = await aggressiveCompressUntilBelowThreshold(workMessages, offloadMap, currentTaskNodeIds, aggressiveDeleteRatio, stateManager, logger, aggressiveTargetForMsgs, countTokens, null, prompt ?? null);
  let workingTokens = result.remainingTokens + systemTokensEstimate;
  const durationMs = Date.now() - _aggStart;
  const deletedIds = result.allDeletedToolCallIds;
  if (deletedIds.length > 0) {
    const statusUpdates = new Map<string, string | boolean>();
    for (const id of deletedIds) { statusUpdates.set(id, "deleted"); stateManager.confirmedOffloadIds.add(id); stateManager.deletedOffloadIds.add(id); }
    markOffloadStatus(stateManager.ctx, statusUpdates).catch(() => {});
    const mmdInj = await buildHistoryMmdInjection(deletedIds, offloadMap, offloadEntryArr, stateManager, logger, countTokens, contextWindow, pCfg);
    let mmdInjected = 0, mmdTokens = 0;
    if (mmdInj.injectedMessages.length > 0) {
      removeExistingMmdInjections(workMessages);
      const histInsertIdx = findHistoryMmdInsertionPoint(workMessages);
      workMessages.splice(histInsertIdx, 0, ...mmdInj.injectedMessages);
      mmdInjected = mmdInj.injectedMessages.length;
      mmdTokens = mmdInj.totalMmdTokens;
      workingTokens += mmdInj.totalMmdTokens;
    }
    if (result.deletedCount > 0 && workMessages.length > 0 && prompt && prompt.length > 0) {
      const boundaryFp = _msgFingerprint(workMessages[0]);
      stateManager._lastAggressiveBoundary = { originalIndex: 0, fingerprint: boundaryFp, keptMsgCount: workMessages.length, remainingTokens: workingTokens };
    }
    return { workingTokens, deletedCount: result.deletedCount, rounds: result.rounds, tokensBefore: _w, tokensAfter: workingTokens, durationMs, deletedIds, mmdInjected, mmdTokens };
  }
  return { workingTokens, deletedCount: result.deletedCount, rounds: result.rounds, tokensBefore: _w, tokensAfter: workingTokens, durationMs, deletedIds, mmdInjected: 0, mmdTokens: 0 };
}

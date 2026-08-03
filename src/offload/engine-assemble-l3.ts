/**
 * engine-assemble-l3.ts — L3 (mild / aggressive / emergency) pipeline for
 * the assemble() method. Extracted from engine-assemble.ts (Group D
 * decomposition) to keep engine-assemble.ts ≤150 lines.
 */
import { buildTiktokenContextSnapshot } from "./context-token-tracker.js";
import { fastEstimateMessages } from "./fast-token-estimate.js";
import { readOffloadEntries } from "./storage.js";
import { populateOffloadLookupMap, getCurrentTaskNodeIds } from "./l3-helpers.js";
import { PLUGIN_DEFAULTS } from "./types.js";
import { runL3Aggressive } from "./engine-assemble-l3-aggressive.js";
import { runL3Mild } from "./engine-assemble-l3-mild.js";
import { runL3Emergency } from "./engine-assemble-l3-emergency.js";
import type { OffloadStateManager } from "./state-manager.js";
import type { OffloadContextEngine } from "./engine.js";

export interface L3Context {
  usedFastPath: boolean;
  snapTotal?: number;
  systemTokensEstimate: number;
  rawTokensBefore: number;
  rawMsgTokens: number;
  effectiveBudget: number;
  contextWindow: number;
  mildThreshold: number;
  aggressiveThreshold: number;
  emergencyThreshold: number;
  fpReplaced: number;
  fpCompressed: number;
  fpDeleted: number;
  aggDeleted: number;
  aggRounds: number;
  aggTokensBefore: number;
  aggTokensAfter: number;
  aggDurationMs: number;
  aggDeletedIds: string[];
  aggMmdInjected: number;
  aggMmdTokens: number;
  mildReplaced: number;
  mildFinalThreshold: number;
  mildDurationMs: number;
  mildTokensBefore: number;
  mildReplacedIds: string[];
  emTriggered: boolean;
  emDeleted: number;
  emTokensBefore: number;
  forceEmergency: boolean;
  workingTokens: number;
}

export async function runL3CompressionPipeline(
  engine: OffloadContextEngine,
  workMessages: any[],
  stateManager: OffloadStateManager,
  prompt: string | null,
  tokenBudget: number | undefined,
  pCfg: any,
  fpResult: { fpBoundaryDeleted: number; fastEstTotal: number },
  logger: any,
): Promise<L3Context> {
  const _rawMsgTokens = fastEstimateMessages(workMessages);
  const contextWindow = (engine as any)._getContextWindow();
  const effectiveBudget = tokenBudget ? Math.min(tokenBudget, contextWindow) : contextWindow;
  const mildRatio = pCfg.mildOffloadRatio ?? PLUGIN_DEFAULTS.mildOffloadRatio;
  const aggressiveRatio = pCfg.aggressiveCompressRatio ?? PLUGIN_DEFAULTS.aggressiveCompressRatio;
  const mildThreshold = Math.floor(effectiveBudget * mildRatio);
  const aggressiveThreshold = Math.floor(effectiveBudget * aggressiveRatio);
  const emergencyThreshold = Math.floor(effectiveBudget * (pCfg.emergencyCompressRatio ?? PLUGIN_DEFAULTS.emergencyCompressRatio));
  const systemTokensEstimate = stateManager.cachedSystemPromptTokens ?? stateManager.getEstimatedSystemOverhead() ?? Math.floor(effectiveBudget * (pCfg.defaultSystemOverheadRatio ?? PLUGIN_DEFAULTS.defaultSystemOverheadRatio));
  const rawTokensBefore = _rawMsgTokens + systemTokensEstimate;
  const fastEst = _rawMsgTokens + systemTokensEstimate + (prompt ? Math.ceil(prompt.length / 4) : 0);
  const FAST_EST_SAFETY_MARGIN = 0.85;
  let workingTokens = 0;
  let snap: any = null;
  let usedFastPath = false;
  if (fpResult.fpBoundaryDeleted > 0 && stateManager._lastAggressiveBoundary && workMessages.length <= stateManager._lastAggressiveBoundary.keptMsgCount + 20 && stateManager._lastAggressiveBoundary.remainingTokens < aggressiveThreshold) {
    const newMsgCount = Math.max(0, workMessages.length - stateManager._lastAggressiveBoundary.keptMsgCount);
    const newMsgTokens = newMsgCount > 0 ? fastEstimateMessages(workMessages.slice(workMessages.length - newMsgCount)) + (prompt ? Math.ceil(prompt.length / 4) : 0) : (prompt ? Math.ceil(prompt.length / 4) : 0);
    const incrementalEst = stateManager._lastAggressiveBoundary.remainingTokens + newMsgTokens;
    if (incrementalEst < aggressiveThreshold) { workingTokens = incrementalEst; usedFastPath = true; }
    else { snap = buildTiktokenContextSnapshot("assemble", workMessages, null, prompt ?? null, { systemTokens: systemTokensEstimate, userPromptTokens: 0 }); workingTokens = snap.totalTokens; }
  } else if (fastEst < aggressiveThreshold * FAST_EST_SAFETY_MARGIN) {
    workingTokens = fastEst; usedFastPath = true;
  } else if (!stateManager._lastAggressiveBoundary && prompt && prompt.length > 0) {
    workingTokens = fastEst;
  } else {
    snap = buildTiktokenContextSnapshot("assemble", workMessages, null, prompt ?? null, { systemTokens: systemTokensEstimate, userPromptTokens: 0 });
    workingTokens = snap.totalTokens;
  }
  const offloadEntries = await readOffloadEntries(stateManager.ctx);
  const offloadMap = new Map(); populateOffloadLookupMap(offloadMap, offloadEntries);
  const currentTaskNodeIds = await getCurrentTaskNodeIds(stateManager);
  const offloadEntryArr: any[] = offloadEntries;
  const agg = await runL3Aggressive({ workMessages, stateManager, prompt, aggressiveThreshold, systemTokensEstimate, offloadMap, offloadEntryArr, currentTaskNodeIds, pCfg, logger, workingTokens, contextWindow });
  workingTokens = agg.workingTokens;
  const mild = runL3Mild({ workMessages, stateManager, mildThreshold, offloadMap, currentTaskNodeIds, pCfg, logger, workingTokens });
  workingTokens = mild.workingTokens;
  const em = await runL3Emergency({ workMessages, stateManager, prompt, emergencyThreshold, systemTokensEstimate, logger, pCfg, workingTokens });
  workingTokens = em.workingTokens;
  return {
    usedFastPath, snapTotal: snap?.totalTokens, systemTokensEstimate, rawTokensBefore, rawMsgTokens: _rawMsgTokens, effectiveBudget, contextWindow, mildThreshold, aggressiveThreshold, emergencyThreshold,
    fpReplaced: 0, fpCompressed: 0, fpDeleted: fpResult.fpBoundaryDeleted,
    aggDeleted: agg.deletedCount, aggRounds: agg.rounds, aggTokensBefore: agg.tokensBefore, aggTokensAfter: agg.tokensAfter, aggDurationMs: agg.durationMs, aggDeletedIds: agg.deletedIds, aggMmdInjected: agg.mmdInjected, aggMmdTokens: agg.mmdTokens,
    mildReplaced: mild.replacedCount, mildFinalThreshold: mild.finalThreshold, mildDurationMs: mild.durationMs, mildTokensBefore: mild.tokensBefore, mildReplacedIds: mild.replacedIds,
    emTriggered: em.triggered, emDeleted: em.deletedCount, emTokensBefore: em.tokensBefore, forceEmergency: em.forceEmergency,
    workingTokens,
  };
}

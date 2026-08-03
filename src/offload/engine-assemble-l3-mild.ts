/**
 * engine-assemble-l3-mild.ts — L3 mild (score cascade) compression stage.
 * Extracted from engine-assemble-l3.ts (Group D decomposition).
 */
import { markOffloadStatus } from "./storage.js";
import { compressByScoreCascade } from "./hooks/llm-input-l3.js";
import { PLUGIN_DEFAULTS, type OffloadEntry, type PluginLogger } from "./types.js";
import type { OffloadStateManager } from "./state-manager.js";

export interface MildArgs {
  workMessages: any[];
  stateManager: OffloadStateManager;
  mildThreshold: number;
  offloadMap: Map<string, OffloadEntry>;
  currentTaskNodeIds: Set<string>;
  pCfg: any;
  logger: PluginLogger;
  workingTokens: number;
}

export interface MildResult {
  workingTokens: number;
  replacedCount: number;
  finalThreshold: number;
  durationMs: number;
  tokensBefore: number;
  replacedIds: string[];
}

export function runL3Mild(args: MildArgs): MildResult {
  const { workMessages, stateManager, mildThreshold, offloadMap, currentTaskNodeIds, pCfg, logger, workingTokens } = args;
  const tokensBefore = workingTokens;
  if (workingTokens < mildThreshold) {
    return { workingTokens, replacedCount: 0, finalThreshold: 0, durationMs: 0, tokensBefore, replacedIds: [] };
  }
  const mildScanRatio = pCfg.mildOffloadScanRatio ?? PLUGIN_DEFAULTS.mildOffloadScanRatio;
  const _mildStart = Date.now();
  const cascadeResult = compressByScoreCascade(workMessages, offloadMap, currentTaskNodeIds, mildScanRatio, logger);
  const durationMs = Date.now() - _mildStart;
  if (cascadeResult.replacedCount > 0) {
    for (const id of cascadeResult.replacedToolCallIds) stateManager.confirmedOffloadIds.add(id);
    const mildUpdates = new Map<string, string | boolean>();
    for (const id of cascadeResult.replacedToolCallIds) mildUpdates.set(id, true);
    markOffloadStatus(stateManager.ctx, mildUpdates).catch(() => {});
  }
  return { workingTokens, replacedCount: cascadeResult.replacedCount, finalThreshold: cascadeResult.finalThreshold, durationMs, tokensBefore, replacedIds: cascadeResult.replacedToolCallIds };
}

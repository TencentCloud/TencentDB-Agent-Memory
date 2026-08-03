/**
 * engine-assemble-l3-emergency.ts — L3 emergency compression stage.
 * Extracted from engine-assemble-l3.ts (Group D decomposition).
 */
import { buildTiktokenContextSnapshot } from "./context-token-tracker.js";
import { createL3TokenCounter } from "./l3-token-counter.js";
import { emergencyCompress, EMERGENCY_MIN_MESSAGES_TO_KEEP } from "./hooks/llm-input-l3.js";
import { markOffloadStatus } from "./storage.js";
import { PLUGIN_DEFAULTS, type PluginLogger } from "./types.js";
import type { OffloadStateManager } from "./state-manager.js";

export interface EmergencyArgs {
  workMessages: any[];
  stateManager: OffloadStateManager;
  prompt: string | null;
  emergencyThreshold: number;
  systemTokensEstimate: number;
  logger: PluginLogger;
  pCfg: any;
  workingTokens: number;
}

export interface EmergencyResult {
  workingTokens: number;
  triggered: boolean;
  deletedCount: number;
  tokensBefore: number;
  forceEmergency: boolean;
}

export async function runL3Emergency(args: EmergencyArgs): Promise<EmergencyResult> {
  const { workMessages, stateManager, prompt, emergencyThreshold, systemTokensEstimate, logger, pCfg, workingTokens: _w } = args;
  const tokensBefore = _w;
  const forceEmergency = stateManager._forceEmergencyNext === true;
  if (forceEmergency) stateManager._forceEmergencyNext = false;
  if ((_w < emergencyThreshold && !forceEmergency) || workMessages.length <= EMERGENCY_MIN_MESSAGES_TO_KEEP) {
    return { workingTokens: _w, triggered: false, deletedCount: 0, tokensBefore, forceEmergency };
  }
  const emergencyTargetRatio = pCfg.emergencyTargetRatio ?? PLUGIN_DEFAULTS.emergencyTargetRatio;
  const emergencyTarget = Math.floor(((pCfg.contextWindow ?? 0) || _w * 2) * emergencyTargetRatio);
  const countTokens = createL3TokenCounter(pCfg, logger);
  const result = emergencyCompress(workMessages, emergencyTarget - systemTokensEstimate, countTokens, null, prompt ?? null, logger);
  const workingTokens = result.remainingTokens + systemTokensEstimate;
  if (result.deletedToolCallIds.length > 0) {
    const statusUpdates = new Map<string, string | boolean>();
    for (const id of result.deletedToolCallIds) { statusUpdates.set(id, "deleted"); stateManager.confirmedOffloadIds.add(id); stateManager.deletedOffloadIds.add(id); }
    markOffloadStatus(stateManager.ctx, statusUpdates).catch(() => {});
  }
  return { workingTokens, triggered: true, deletedCount: result.deletedCount, tokensBefore, forceEmergency };
}

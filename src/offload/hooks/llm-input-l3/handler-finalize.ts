/**
 * handler-finalize.ts — Mild + emergency + trace + report stage of the
 * llm_input L3 handler. Behavior extracted exactly from llm-input-l3.ts.
 */
import { buildTiktokenContextSnapshot } from "../../context-token-tracker.js";
import { markOffloadStatus } from "../../storage.js";
import { PLUGIN_DEFAULTS, type OffloadEntry, type PluginConfig, type PluginLogger } from "../../types.js";
import type { OffloadStateManager } from "../../state-manager.js";
import type { BackendClient } from "../../backend-client.js";
import { compressByScoreCascade } from "./score-cascade.js";
import { emergencyCompress } from "./emergency-compress.js";
import { buildL3TriggerReport, reportL3Trigger } from "../../state-reporter.js";
import { traceOffloadDecision } from "../../opik-tracer.js";
import { dumpMessagesSnapshot } from "./overflow-detect.js";
import { EMERGENCY_MIN_MESSAGES_TO_KEEP } from "./score-cascade-constants.js";

export interface HandlerFinalizeArgs {
  historyMessages: any[];
  sysPrompt: string | null;
  promptText: string | null;
  stateManager: OffloadStateManager;
  logger: PluginLogger;
  pluginConfig: Partial<PluginConfig> | undefined;
  backendClient?: BackendClient | null;
  event: any;
  snap: any;
  contextWindow: number;
  mildThreshold: number;
  aggressiveThreshold: number;
  offloadMap: Map<string, OffloadEntry>;
  offloadEntries: OffloadEntry[];
  currentTaskNodeIds: Set<string>;
  countTokens: (t: string) => number;
  mildScanRatio: number;
  workingTokensIn: number;
  l3Start: number;
  aggDeleted: number;
  mildReplaced: number;
  emergencyTriggered: boolean;
  emergencyDeleted: number;
}

export async function runHandlerFinalize(args: HandlerFinalizeArgs): Promise<void> {
  const { historyMessages, sysPrompt, promptText, stateManager, logger, pluginConfig, backendClient, event, snap, contextWindow, mildThreshold, aggressiveThreshold, offloadMap, offloadEntries, currentTaskNodeIds, countTokens, mildScanRatio, workingTokensIn, l3Start, aggDeleted: _aggDeleted } = args;
  let _mildReplaced = args.mildReplaced;
  let _emergencyTriggered = args.emergencyTriggered;
  let _emergencyDeleted = args.emergencyDeleted;
  let workingTokens = workingTokensIn;

  if (workingTokens >= mildThreshold) {
    logger.debug?.(`[context-offload] L3(llm_input) MILD: tokens≈${workingTokens} >= ${mildThreshold}, starting cascade`);
    const cascadeResult = compressByScoreCascade(historyMessages, offloadMap, currentTaskNodeIds, mildScanRatio, logger);
    _mildReplaced = cascadeResult.replacedCount;
    logger.debug?.(`[context-offload] L3(llm_input) MILD done: replaced=${cascadeResult.replacedCount}, finalThreshold=${cascadeResult.finalThreshold}, ids=[${cascadeResult.replacedToolCallIds.slice(0,5).join(",")}${cascadeResult.replacedToolCallIds.length > 5 ? "..." : ""}]`);
    if (cascadeResult.replacedCount > 0) {
      for (const id of cascadeResult.replacedToolCallIds) {
        stateManager.confirmedOffloadIds.add(id);
      }
      const mildStatusUpdates = new Map<string, string | boolean>();
      for (const id of cascadeResult.replacedToolCallIds) {
        mildStatusUpdates.set(id, true);
      }
      markOffloadStatus(stateManager.ctx, mildStatusUpdates).catch(() => {});
    }
    dumpMessagesSnapshot("after-mild", historyMessages, logger);
  }
  // Emergency fallback
  const emergencyRatio = pluginConfig?.emergencyCompressRatio ?? PLUGIN_DEFAULTS.emergencyCompressRatio;
  const emergencyTargetRatio = pluginConfig?.emergencyTargetRatio ?? PLUGIN_DEFAULTS.emergencyTargetRatio;
  const emergencyThreshold = Math.floor(contextWindow * emergencyRatio);
  const emergencyTarget = Math.floor(contextWindow * emergencyTargetRatio);
  const preEmergencySnap = buildTiktokenContextSnapshot("llm_input_pre_emergency", historyMessages, sysPrompt, promptText);
  workingTokens = preEmergencySnap.totalTokens;
  const forceEmergency = stateManager._forceEmergencyNext === true;
  if (forceEmergency) stateManager._forceEmergencyNext = false;

  if ((workingTokens >= emergencyThreshold || forceEmergency) && historyMessages.length > EMERGENCY_MIN_MESSAGES_TO_KEEP) {
    _emergencyTriggered = true;
    logger.warn?.(`[context-offload] L3(llm_input) EMERGENCY: tokens≈${workingTokens} >= ${emergencyThreshold} (force=${forceEmergency}), target=${emergencyTarget}`);
    const emergencyResult = emergencyCompress(historyMessages, emergencyTarget, countTokens, sysPrompt, promptText, logger);
    _emergencyDeleted = emergencyResult.deletedCount;
    logger.warn?.(`[context-offload] L3(llm_input) EMERGENCY done: deleted=${emergencyResult.deletedCount}, remaining≈${emergencyResult.remainingTokens}, deletedIds=${emergencyResult.deletedToolCallIds.length}`);
    if (emergencyResult.deletedToolCallIds.length > 0) {
      const statusUpdates = new Map<string, string | boolean>();
      for (const id of emergencyResult.deletedToolCallIds) {
        statusUpdates.set(id, "deleted");
        stateManager.confirmedOffloadIds.add(id);
        stateManager.deletedOffloadIds.add(id);
      }
      markOffloadStatus(stateManager.ctx, statusUpdates).catch(() => {});
    }
    dumpMessagesSnapshot("after-emergency", historyMessages, logger);
  }

  if (stateManager.isLoaded()) await stateManager.save();
  const finalSnap = buildTiktokenContextSnapshot("llm_input_l3_final", historyMessages, sysPrompt, promptText);
  const totalSaved = snap.totalTokens - finalSnap.totalTokens;
  if (totalSaved > 0) {
    logger.debug?.(`[context-offload] L3(llm_input) SUMMARY: ${snap.totalTokens}→${finalSnap.totalTokens} (saved≈${totalSaved} tokens), msgs=${historyMessages.length}`);
  }
  // trace + backend report
  traceOffloadDecision({
    sessionKey: stateManager.getLastSessionKey(),
    stage: "L3.llm_input.completed",
    input: {
      contextWindow,
      mildThreshold,
      aggressiveThreshold,
      tokensBefore: snap.totalTokens,
      messagesBefore: event.historyMessages?.length ?? 0,
    },
    output: {
      tokensAfter: finalSnap.totalTokens,
      tokensSaved: totalSaved,
      messagesAfter: historyMessages.length,
      compressionApplied: totalSaved > 0,
      utilisation: `${((snap.totalTokens / contextWindow) * 100).toFixed(1)}%`,
      aboveMild: snap.totalTokens >= mildThreshold,
      aboveAggressive: snap.totalTokens >= aggressiveThreshold,
    },
    logger,
  });
  try {
    const triggerReason = snap.totalTokens >= aggressiveThreshold
      ? "above_aggressive"
      : "above_mild";
    const report = buildL3TriggerReport({
      stage: "llm_input",
      triggerReason,
      stateManager,
      event,
      contextWindow,
      mildThreshold,
      aggressiveThreshold,
      tokensBefore: snap.totalTokens,
      tokensAfter: finalSnap.totalTokens,
      messagesBefore: event.historyMessages?.length ?? 0,
      messagesAfter: historyMessages.length,
      durationMs: Date.now() - l3Start,
      aboveMild: snap.totalTokens >= mildThreshold,
      aboveAggressive: snap.totalTokens >= aggressiveThreshold,
      mildReplacedCount: _mildReplaced,
      aggressiveDeletedCount: _aggDeleted,
      emergencyTriggered: _emergencyTriggered,
      emergencyDeletedCount: _emergencyDeleted,
    });
    reportL3Trigger(backendClient ?? null, report, logger);
  } catch (reportErr) { logger.warn?.(`[context-offload] L3(llm_input) build report failed: ${reportErr}`); }
}

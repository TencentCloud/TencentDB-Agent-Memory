/**
 * handler-aggressive.ts — Aggressive L3 compression stage for the llm_input
 * handler. Extracted from handler.ts (Group D decomposition).
 */
import { buildTiktokenContextSnapshot } from "../../context-token-tracker.js";
import { findHistoryMmdInsertionPoint } from "../../mmd-injector.js";
import { markOffloadStatus } from "../../storage.js";
import { PLUGIN_DEFAULTS, type OffloadEntry, type PluginConfig, type PluginLogger } from "../../types.js";
import type { OffloadStateManager } from "../../state-manager.js";
import { aggressiveCompressUntilBelowThreshold } from "./aggressive-compress.js";
import { buildHistoryMmdInjection, removeExistingMmdInjections } from "./mmd-injection.js";
import { dumpMessagesSnapshot } from "./overflow-detect.js";

export interface HandlerAggressiveArgs {
  historyMessages: any[];
  sysPrompt: string | null;
  promptText: string | null;
  stateManager: OffloadStateManager;
  logger: PluginLogger;
  contextWindow: number;
  aggressiveThreshold: number;
  aggressiveDeleteRatio: number;
  offloadMap: Map<string, OffloadEntry>;
  offloadEntries: OffloadEntry[];
  currentTaskNodeIds: Set<string>;
  countTokens: (t: string) => number;
  pluginConfig: Partial<PluginConfig> | undefined;
}

export interface HandlerAggressiveResult {
  workingTokens: number;
  aggDeleted: number;
}

export async function runHandlerAggressive(args: HandlerAggressiveArgs): Promise<HandlerAggressiveResult> {
  const { historyMessages, sysPrompt, promptText, stateManager, logger, aggressiveThreshold, aggressiveDeleteRatio, offloadMap, offloadEntries, currentTaskNodeIds, countTokens, contextWindow, pluginConfig } = args;
  logger.debug?.(`[context-offload] L3(llm_input) AGGRESSIVE: tokens≈${buildTiktokenContextSnapshot("llm_input_pre_agg", historyMessages, sysPrompt, promptText).totalTokens} >= ${aggressiveThreshold}, starting deletion`);
  const _llmAggStart = Date.now();
  const result = await aggressiveCompressUntilBelowThreshold(
    historyMessages, offloadMap, currentTaskNodeIds, aggressiveDeleteRatio,
    stateManager, logger, aggressiveThreshold, countTokens, sysPrompt, promptText,
  );
  let workingTokens = result.remainingTokens;
  const _aggDeleted = result.deletedCount ?? result.allDeletedToolCallIds.length;
  const _llmAggDuration = Date.now() - _llmAggStart;
  logger.debug?.(`[context-offload] L3(llm_input) AGGRESSIVE done: rounds=${result.rounds}, deleted=${result.deletedCount}, remaining≈${workingTokens}, deletedIds=${result.allDeletedToolCallIds.length}, stalledByUserMsg=${result.stalledByUserMsg ?? false}, duration=${_llmAggDuration}ms`);
  if (_llmAggDuration > 10_000) {
    logger.warn?.(`[context-offload] L3(llm_input) AGGRESSIVE SLOW: ${_llmAggDuration}ms (rounds=${result.rounds}, deleted=${result.deletedCount}, remaining≈${workingTokens})`);
  }
  dumpMessagesSnapshot("after-aggressive", historyMessages, logger);
  if (result.allDeletedToolCallIds.length > 0) {
    const statusUpdates = new Map<string, string | boolean>();
    for (const id of result.allDeletedToolCallIds) {
      statusUpdates.set(id, "deleted");
      stateManager.confirmedOffloadIds.add(id);
      stateManager.deletedOffloadIds.add(id);
    }
    markOffloadStatus(stateManager.ctx, statusUpdates).catch(() => {});
    const mmdInjection = await buildHistoryMmdInjection(
      result.allDeletedToolCallIds, offloadMap, offloadEntries,
      stateManager, logger, countTokens, contextWindow, pluginConfig,
    );
    if (mmdInjection.injectedMessages.length > 0) {
      removeExistingMmdInjections(historyMessages);
      const histInsertIdx = findHistoryMmdInsertionPoint(historyMessages);
      historyMessages.splice(histInsertIdx, 0, ...mmdInjection.injectedMessages);
      workingTokens += mmdInjection.totalMmdTokens;
      logger.debug?.(`[context-offload] L3(llm_input) AGGRESSIVE: injected ${mmdInjection.injectedMessages.length} history MMD msgs at [${histInsertIdx}] (${mmdInjection.totalMmdTokens} tokens, files=${mmdInjection.mmdFiles.join(",")})`);
      dumpMessagesSnapshot("after-aggressive-mmd-injection", historyMessages, logger);
    }
  }
  if (result.stalledByUserMsg && workingTokens >= aggressiveThreshold) {
    logger.warn?.(`[context-offload] L3(llm_input) AGGRESSIVE stalled, forcing emergency fallback`);
    stateManager._forceEmergencyNext = true;
  }
  return { workingTokens, aggDeleted: _aggDeleted };
}

/**
 * handler.ts — L3 (mild / aggressive / emergency) compression pipeline for
 * the llm_input hook.
 *
 * The function body is split across this file (setup + aggressive dispatch)
 * and handler-finalize.ts (mild + emergency + trace + report). Behavior is
 * preserved exactly.
 *
 * Extracted from llm-input-l3.ts (Group D decomposition).
 */
import { buildTiktokenContextSnapshot } from "../../context-token-tracker.js";
import { injectMmdIntoMessages } from "../../mmd-injector.js";
import { readOffloadEntries } from "../../storage.js";
import { populateOffloadLookupMap, getCurrentTaskNodeIds } from "../../l3-helpers.js";
import { createL3TokenCounter } from "../../l3-token-counter.js";
import { PLUGIN_DEFAULTS, type OffloadEntry, type PluginConfig, type PluginLogger } from "../../types.js";
import type { OffloadStateManager } from "../../state-manager.js";
import type { BackendClient } from "../../backend-client.js";
import { filterHeartbeatMessages } from "./filter-heartbeat.js";
import { extractLatestTurn, fastPathReApply } from "./fastpath.js";
import { isTokenOverflowError } from "./overflow-detect.js";
import { runHandlerAggressive } from "./handler-aggressive.js";
import { runHandlerFinalize } from "./handler-finalize.js";

export function createLlmInputL3Handler(
  stateManager: OffloadStateManager,
  logger: PluginLogger,
  getContextWindow: () => number,
  pluginConfig: Partial<PluginConfig> | undefined,
  callbacks?: { notifyL2NewNullEntries?: (count: number) => void },
  backendClient?: BackendClient | null,
) {
  return async (event: any) => {
    const _l3Start = Date.now();
    const _sk = stateManager.getLastSessionKey();
    if (typeof _sk === "string" && /memory-.*-session-\d+/.test(_sk)) return;

    logger.debug?.(`[context-offload] llm_input_l3 CALLED, historyMsgs=${event?.historyMessages?.length ?? "?"}, prompt=${typeof event?.prompt === "string" ? event.prompt.slice(0, 50) : "?"}`);
    let _aggDeleted = 0;
    let _mildReplaced = 0;
    let _emergencyTriggered = false;
    let _emergencyDeleted = 0;
    try {
      const historyMessages = Array.isArray(event.historyMessages) ? event.historyMessages : [];
      if (historyMessages.length > 0) filterHeartbeatMessages(historyMessages, logger);
      const sysPrompt = typeof event.systemPrompt === "string" ? event.systemPrompt : null;
      const promptText = typeof event.prompt === "string" ? event.prompt : null;
      stateManager.cachedSystemPrompt = sysPrompt;
      stateManager.cachedUserPrompt = promptText;

      if (historyMessages.length > 0) {
        const latestTurn = extractLatestTurn(historyMessages, promptText);
        stateManager.cachedLatestTurnMessages = latestTurn;
      }

      if (historyMessages.length > 0) await fastPathReApply(historyMessages, stateManager, logger);

      if (historyMessages.length > 0) {
        try {
          await injectMmdIntoMessages(historyMessages, stateManager, logger, getContextWindow, pluginConfig);
        } catch { /* ignore */ }
      }

      const snap = buildTiktokenContextSnapshot("llm_input_l3", historyMessages, sysPrompt, promptText);
      stateManager.cachedSystemPromptTokens = snap.systemTokens;
      stateManager.cachedUserPromptTokens = snap.userPromptTokens;

      if (snap.systemTokens > 0) {
        stateManager.setEstimatedSystemOverhead(snap.systemTokens);
        if (stateManager.isLoaded()) stateManager.save().catch(() => {});
      }

      const contextWindow = getContextWindow();
      const mildRatio = pluginConfig?.mildOffloadRatio ?? PLUGIN_DEFAULTS.mildOffloadRatio;
      const aggressiveRatio = pluginConfig?.aggressiveCompressRatio ?? PLUGIN_DEFAULTS.aggressiveCompressRatio;
      const mildThreshold = Math.floor(contextWindow * mildRatio);
      const aggressiveThreshold = Math.floor(contextWindow * aggressiveRatio);

      const utilisation = snap.totalTokens / contextWindow;
      logger.debug?.(
        `[context-offload] L3(llm_input) token snapshot: total=${snap.totalTokens} ` +
        `(system=${snap.systemTokens}, messages=${snap.messagesTokens}, user=${snap.userPromptTokens}) ` +
        `msgCount=${historyMessages.length} utilisation=${(utilisation * 100).toFixed(1)}% ` +
        `contextWindow=${contextWindow} mild@${mildThreshold} aggressive@${aggressiveThreshold}`,
      );

      if (historyMessages.length === 0) return;
      if (snap.totalTokens < mildThreshold) {
        logger.debug?.(`[context-offload] L3(llm_input): ${snap.totalTokens} < mild@${mildThreshold} → no compression needed`);
        return;
      }

      const offloadEntries = await readOffloadEntries(stateManager.ctx);
      const offloadMap = new Map<string, OffloadEntry>();
      populateOffloadLookupMap(offloadMap, offloadEntries);
      const currentTaskNodeIds = await getCurrentTaskNodeIds(stateManager);
      const countTokens = createL3TokenCounter(pluginConfig, logger);
      const aggressiveDeleteRatio = (pluginConfig as any)?.aggressiveDeleteRatio ?? PLUGIN_DEFAULTS.aggressiveDeleteRatio;
      const mildScanRatio = (pluginConfig as any)?.mildOffloadScanRatio ?? PLUGIN_DEFAULTS.mildOffloadScanRatio;
      let workingTokens = snap.totalTokens;

      if (workingTokens >= aggressiveThreshold) {
        const aggResult = await runHandlerAggressive({
          historyMessages, sysPrompt, promptText, stateManager, logger,
          contextWindow, aggressiveThreshold, aggressiveDeleteRatio,
          offloadMap, offloadEntries, currentTaskNodeIds, countTokens, pluginConfig,
        });
        workingTokens = aggResult.workingTokens;
        _aggDeleted = aggResult.aggDeleted;
      }

      await runHandlerFinalize({
        historyMessages, sysPrompt, promptText, stateManager, logger, pluginConfig,
        backendClient, event, snap, contextWindow, mildThreshold, aggressiveThreshold,
        offloadMap, offloadEntries, currentTaskNodeIds, countTokens, mildScanRatio,
        workingTokensIn: workingTokens, l3Start: _l3Start,
        aggDeleted: _aggDeleted, mildReplaced: _mildReplaced,
        emergencyTriggered: _emergencyTriggered, emergencyDeleted: _emergencyDeleted,
      });
    } catch (err) {
      logger.error(`[context-offload] llm_input L3 error: ${err}`);
      if (isTokenOverflowError(err)) stateManager._forceEmergencyNext = true;
    }
  };
}

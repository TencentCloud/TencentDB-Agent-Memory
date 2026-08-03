/**
 * engine-assemble.ts — assemble() orchestrator for the context engine.
 *
 * The L3 compression pipeline (aggressive/mild/emergency) lives in
 * engine-assemble-l3.ts to keep this file ≤150 lines.
 *
 * Extracted from index.ts (Group D decomposition).
 */
import { buildTiktokenContextSnapshot } from "./context-token-tracker.js";
import { fastEstimateMessages } from "./fast-token-estimate.js";
import { readOffloadEntries } from "./storage.js";
import {
  normalizeToolCallIdForLookup, getOffloadEntry, populateOffloadLookupMap,
  isToolResultMessage, isOnlyToolUseAssistant, isAssistantMessageWithToolUse,
  extractToolCallId, replaceWithSummary,
} from "./l3-helpers.js";
import { _extractLatestTurn, simpleHash, _msgFingerprint } from "./engine-helpers.js";
import { _extractRecentHistory } from "./engine-history-helpers.js";
import { buildL3TriggerReport, reportL3Trigger } from "./state-reporter.js";
import { traceOffloadDecision, traceMessagesSnapshot } from "./opik-tracer.js";
import { runL3CompressionPipeline } from "./engine-assemble-l3.js";
import type { OffloadStateManager } from "./state-manager.js";
import type { OffloadContextEngine } from "./engine.js";

export async function runAssemblePipeline(engine: OffloadContextEngine, params: any): Promise<{ messages: any[]; estimatedTokens: number; systemPromptAddition?: string }> {
  const { messages, tokenBudget, prompt } = params;
  const logger = (engine as any)._logger;
  const pCfg = (engine as any)._pCfg;
  logger.debug?.(`[context-offload] assemble CALLED: msgs=${messages?.length ?? 0}, budget=${tokenBudget ?? "N/A"}, prompt=${typeof prompt === "string" ? prompt.length + " chars" : "none"}, sessionKey=${params.sessionKey ?? "?"}`);

  let stateManager: OffloadStateManager | undefined = params._offloadManager;
  if (!stateManager && params.sessionKey) {
    try {
      const entry = await (engine as any)._sessions.resolveIfAllowed(params.sessionKey, params.sessionId);
      if (entry) { stateManager = entry.manager; params._offloadManager = entry.manager; }
    } catch (err) { logger.warn?.(`[context-offload] assemble: failed to resolve session ${params.sessionKey}: ${err}`); }
  }
  if (!stateManager) { logger.debug?.(`[context-offload] assemble SKIP: no stateManager`); return { messages: messages ? [...messages] : [], estimatedTokens: 0 }; }

  const workMessages = messages ? [...messages] : [];
  const _asmStart = Date.now();
  if (typeof prompt === "string" && prompt.length > 0) stateManager.cachedUserPrompt = prompt;
  if (workMessages.length > 0) {
    stateManager.cachedLatestTurnMessages = _extractLatestTurn(workMessages, prompt);
    stateManager.cachedRecentHistory = _extractRecentHistory(workMessages, prompt);
  }

  try {
    if (prompt && typeof prompt === "string" && prompt.length > 0 && (engine as any)._backendClient) {
      const promptHash = simpleHash(prompt);
      if (promptHash !== stateManager.lastL15PromptHash) {
        stateManager.lastL15PromptHash = promptHash; stateManager.l15Settled = false;
        (engine as any)._judgeL15(stateManager, { prompt, messages: workMessages }, { sessionKey: stateManager.getLastSessionKey() })
          .catch((err: any) => { logger.warn?.(`[context-offload] assemble L1.5 judge failed: ${err}`); });
      }
    }

    const fpResult = await runFastPathReApply(workMessages, stateManager, prompt, logger);
    const l3Ctx = await runL3CompressionPipeline(engine, workMessages, stateManager, prompt, tokenBudget, pCfg, fpResult, logger);
    let systemPromptAddition: string | undefined;
    if ((engine as any)._l4State.pendingResult?.appendSystemContext) {
      systemPromptAddition = (engine as any)._l4State.pendingResult.appendSystemContext;
      (engine as any)._l4State.pendingResult = null;
    }

    const finalSnap = l3Ctx.usedFastPath
      ? { totalTokens: l3Ctx.workingTokens, messagesTokens: l3Ctx.workingTokens - l3Ctx.systemTokensEstimate, systemTokens: l3Ctx.systemTokensEstimate, userPromptTokens: 0 }
      : buildTiktokenContextSnapshot("assemble_final", workMessages, null, prompt ?? null, { systemTokens: l3Ctx.systemTokensEstimate, userPromptTokens: 0 });
    const tokensBefore = l3Ctx.snapTotal ?? fpResult.fastEstTotal;
    const tokensSaved = tokensBefore - finalSnap.totalTokens;
    const _asmDuration = Date.now() - _asmStart;
    logger.debug?.(`[context-offload] assemble END: ${messages?.length ?? 0}→${workMessages.length} msgs, rawTokens≈${l3Ctx.rawTokensBefore}, tokensBefore≈${tokensBefore}, tokensAfter≈${finalSnap.totalTokens} (sys≈${l3Ctx.systemTokensEstimate}), tokensSaved≈${tokensSaved}, hasL4=${!!systemPromptAddition}, duration=${_asmDuration}ms`);

    // Async trace
    try { traceOffloadDecision({
        sessionKey: stateManager.getLastSessionKey(),
        stage: "L3.assemble.completed",
        input: { messagesBefore: messages?.length ?? 0, rawTokensBefore: l3Ctx.rawTokensBefore, rawMsgTokens: l3Ctx.rawMsgTokens, tokensBefore, budget: l3Ctx.effectiveBudget, contextWindow: l3Ctx.contextWindow, systemTokensEstimate: l3Ctx.systemTokensEstimate, mildThreshold: l3Ctx.mildThreshold, aggressiveThreshold: l3Ctx.aggressiveThreshold, emergencyThreshold: l3Ctx.emergencyThreshold, durationMs: _asmDuration },
        output: { messagesAfter: workMessages.length, messagesRemoved: (messages?.length ?? 0) - workMessages.length, tokensAfter: finalSnap.totalTokens, tokensSaved, totalTokensSaved: l3Ctx.rawTokensBefore - finalSnap.totalTokens, utilisation: `${((finalSnap.totalTokens / l3Ctx.effectiveBudget) * 100).toFixed(1)}%`, utilisationBefore: `${((l3Ctx.rawTokensBefore / l3Ctx.effectiveBudget) * 100).toFixed(1)}%`, hasL4: !!systemPromptAddition, fastPath: { rawTokens: l3Ctx.rawTokensBefore, tokensAfterFP: tokensBefore, tokensSavedByFP: l3Ctx.rawTokensBefore - tokensBefore, replacedToolResults: l3Ctx.fpReplaced, compressedAssistants: l3Ctx.fpCompressed, deletedMsgs: l3Ctx.fpDeleted, confirmedIds: stateManager.confirmedOffloadIds?.size ?? 0, deletedIds: stateManager.deletedOffloadIds?.size ?? 0 }, aggressive: { triggered: l3Ctx.aggDeleted > 0, tokensBefore: l3Ctx.aggTokensBefore, tokensAfter: l3Ctx.aggTokensAfter, deletedMsgs: l3Ctx.aggDeleted, deletedIds: l3Ctx.aggDeletedIds.slice(0, 20), rounds: l3Ctx.aggRounds, durationMs: l3Ctx.aggDurationMs, historyMmdInjected: l3Ctx.aggMmdInjected, historyMmdTokens: l3Ctx.aggMmdTokens }, mild: { triggered: l3Ctx.mildReplaced > 0, tokensBefore: l3Ctx.mildTokensBefore, replacedCount: l3Ctx.mildReplaced, finalThreshold: l3Ctx.mildFinalThreshold, replacedIds: l3Ctx.mildReplacedIds.slice(0, 20), durationMs: l3Ctx.mildDurationMs }, emergency: { triggered: l3Ctx.emTriggered, tokensBefore: l3Ctx.emTokensBefore, deletedMsgs: l3Ctx.emDeleted, forceEmergency: l3Ctx.forceEmergency } },
        logger,
      });
    } catch { /* ignore */ }

    try {
      traceMessagesSnapshot({ sessionKey: stateManager.getLastSessionKey(), stage: "assemble.input", messages: messages ?? [], label: "original messages (before assemble)", extra: { rawTokensBefore: l3Ctx.rawTokensBefore, budget: l3Ctx.effectiveBudget, contextWindow: l3Ctx.contextWindow }, logger });
      traceMessagesSnapshot({ sessionKey: stateManager.getLastSessionKey(), stage: "assemble.output", messages: workMessages, label: "workMessages (after assemble)", extra: { tokensAfter: finalSnap.totalTokens, tokensSaved, totalTokensSaved: l3Ctx.rawTokensBefore - finalSnap.totalTokens, budget: l3Ctx.effectiveBudget, hasL4: !!systemPromptAddition }, logger });
    } catch { /* ignore */ }

    try {
      const _triggerReason = l3Ctx.rawTokensBefore >= l3Ctx.aggressiveThreshold ? "above_aggressive" : l3Ctx.rawTokensBefore >= l3Ctx.mildThreshold ? "above_mild" : "below_mild";
      const _report = buildL3TriggerReport({
        stage: "assemble", triggerReason: _triggerReason, stateManager, event: { messages: workMessages },
        contextWindow: l3Ctx.contextWindow, mildThreshold: l3Ctx.mildThreshold, aggressiveThreshold: l3Ctx.aggressiveThreshold,
        tokensBefore: l3Ctx.rawTokensBefore, tokensAfter: finalSnap.totalTokens,
        messagesBefore: messages?.length ?? 0, messagesAfter: workMessages.length,
        durationMs: _asmDuration,
        aboveMild: l3Ctx.rawTokensBefore >= l3Ctx.mildThreshold, aboveAggressive: l3Ctx.rawTokensBefore >= l3Ctx.aggressiveThreshold,
        mildReplacedCount: l3Ctx.mildReplaced, aggressiveDeletedCount: l3Ctx.aggDeleted,
        emergencyTriggered: l3Ctx.emTriggered, emergencyDeletedCount: l3Ctx.emDeleted,
      });
      reportL3Trigger((engine as any)._backendClient ?? null, _report, logger);
    } catch (reportErr) { logger.warn?.(`[context-offload] assemble L3 state-report build failed: ${reportErr}`); }

    return { messages: workMessages, estimatedTokens: finalSnap.totalTokens, systemPromptAddition };
  } catch (err) {
    logger.error?.(`[context-offload] assemble error: ${err}`);
    if ((err as any)?.message?.toLowerCase?.().includes?.("token")) stateManager._forceEmergencyNext = true;
    return { messages: workMessages, estimatedTokens: 0 };
  }
}
async function runFastPathReApply(workMessages: any[], stateManager: OffloadStateManager, prompt: string | null, logger: any): Promise<{ fpBoundaryDeleted: number; fastEstTotal: number }> {
  const _rawMsgTokens = fastEstimateMessages(workMessages);
  const fastEst = _rawMsgTokens + (stateManager.cachedSystemPromptTokens ?? 0) + (prompt ? Math.ceil(prompt.length / 4) : 0);
  const hasConfirmed = stateManager.confirmedOffloadIds?.size > 0;
  const hasDeleted = stateManager.deletedOffloadIds?.size > 0;
  let _fpBoundaryDeleted = 0; if (hasConfirmed || hasDeleted) {
    const offloadEntries = await readOffloadEntries(stateManager.ctx);
    const offloadMap = new Map();
    populateOffloadLookupMap(offloadMap, offloadEntries);
    stateManager.setCachedOffloadMap(offloadMap);
    const _boundary = stateManager._lastAggressiveBoundary;
    if (_boundary && prompt && prompt.length > 0 && workMessages.length > _boundary.originalIndex && _boundary.originalIndex > 0) {
      const candidateMsg = workMessages[_boundary.originalIndex];
      if (_msgFingerprint(candidateMsg) === _boundary.fingerprint) {
        let headDeleteEnd = _boundary.originalIndex;
        while (headDeleteEnd < workMessages.length && isToolResultMessage(workMessages[headDeleteEnd])) headDeleteEnd++;
        if (headDeleteEnd > 0 && headDeleteEnd < workMessages.length && isAssistantMessageWithToolUse(workMessages[headDeleteEnd - 1])) {
          while (headDeleteEnd < workMessages.length && isToolResultMessage(workMessages[headDeleteEnd])) headDeleteEnd++;
        }
        if (headDeleteEnd > 0 && headDeleteEnd < workMessages.length) {
          workMessages.splice(0, headDeleteEnd);
          _fpBoundaryDeleted = headDeleteEnd;
          logger.debug?.(`[context-offload] assemble FP-BOUNDARY-DELETE: spliced ${headDeleteEnd} msgs`);
        }
      } else { stateManager._lastAggressiveBoundary = null; }
    }
    for (let i = 0; i < workMessages.length; i++) {
      const msg = workMessages[i];
      const tid = extractToolCallId(msg);
      const tidNorm = tid ? normalizeToolCallIdForLookup(tid) : null;
      if (tid && hasDeleted && (stateManager.deletedOffloadIds.has(tid) || (tidNorm && stateManager.deletedOffloadIds.has(tidNorm)))) continue;
      if (msg._offloaded) continue;
      if (tid && hasConfirmed && (stateManager.confirmedOffloadIds.has(tid) || (tidNorm && stateManager.confirmedOffloadIds.has(tidNorm)))) {
        const entry = getOffloadEntry(offloadMap, tid);
        if (entry && isToolResultMessage(msg)) { replaceWithSummary(msg, entry); msg._offloaded = true; }
      }
    }
  }
  return { fpBoundaryDeleted: _fpBoundaryDeleted, fastEstTotal: fastEst };
}

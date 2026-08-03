/**
 * engine-compact.ts — compact() pipeline for the context engine.
 * Extracted from engine.ts (Group D decomposition).
 */
import { readAllOffloadEntries } from "./storage.js";
import { normalizeToolCallIdForLookup, getCurrentTaskNodeIds } from "./l3-helpers.js";
import { PLUGIN_DEFAULTS } from "./types.js";
import { isInternalMemorySession } from "./engine-helpers.js";
import { emergencyCompress } from "./hooks/llm-input-l3.js";
import { createL3TokenCounter } from "./l3-token-counter.js";
import { markOffloadStatus } from "./storage.js";
import type { OffloadStateManager } from "./state-manager.js";
import type { OffloadContextEngine } from "./engine.js";

export async function runCompactPipeline(engine: OffloadContextEngine, params: any): Promise<{ ok: boolean; compacted: boolean; reason?: string; messages?: any[] }> {
  const _compactStart = Date.now();
  const logger = (engine as any)._logger;
  logger.debug?.(`[context-offload] >>> CE.compact CALLED: sessionKey=${params?.sessionKey ?? "?"}`);
  let stateManager: OffloadStateManager | undefined = params._offloadManager;
  if (!stateManager && params?.sessionKey) {
    try {
      const entry = await (engine as any)._sessions.resolveIfAllowed(params.sessionKey, params.sessionId);
      if (entry) stateManager = entry.manager;
    } catch { /* ignore */ }
  }
  const pCfg = (engine as any)._pCfg;
  if (!stateManager) {
    logger.warn?.(`[context-offload] <<< compact SKIP: no session manager`);
    return { ok: false, compacted: false, reason: "no_session_manager" };
  }
  try {
    // Try delegating to runtime's built-in compaction first
    let delegateFn: any;
    try {
      const { createRequire } = await import("node:module");
      const globalRequire = createRequire("/usr/local/lib/node_modules/openclaw/");
      const sdk = globalRequire("openclaw/plugin-sdk");
      delegateFn = sdk.delegateCompactionToRuntime;
    } catch (e1) {
      try {
        const paths = ["/usr/local/lib/node_modules/openclaw/dist/plugin-sdk/index.js", "/usr/lib/node_modules/openclaw/dist/plugin-sdk/index.js"];
        for (const p of paths) {
          try { const sdk = await import(p); delegateFn = sdk.delegateCompactionToRuntime; break; } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
      if (!delegateFn) {
        try { const sdk = await import("openclaw/plugin-sdk" as any); delegateFn = sdk.delegateCompactionToRuntime; } catch { /* ignore */ }
      }
    }
    if (typeof delegateFn === "function") {
      const result = await delegateFn(params);
      return result;
    }
    const messages = params.messages;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return { ok: true, compacted: false, reason: "no_messages" };
    }
    const contextWindow = (engine as any)._getContextWindow();
    const budget = params.tokenBudget ? Math.min(params.tokenBudget, contextWindow) : contextWindow;
    const mildRatio = pCfg.mildOffloadRatio ?? PLUGIN_DEFAULTS.mildOffloadRatio;
    const targetTokens = Math.floor(budget * mildRatio);
    const systemTokensEstimate = stateManager.cachedSystemPromptTokens ?? stateManager.getEstimatedSystemOverhead() ?? Math.floor(budget * (pCfg.defaultSystemOverheadRatio ?? PLUGIN_DEFAULTS.defaultSystemOverheadRatio));
    const countTokens = createL3TokenCounter(pCfg, logger);
    const emergencyResult = emergencyCompress(messages, targetTokens - systemTokensEstimate, countTokens, null, null, logger);
    if (emergencyResult.deletedToolCallIds.length > 0) {
      for (const id of emergencyResult.deletedToolCallIds) {
        stateManager.confirmedOffloadIds.add(id);
        stateManager.confirmedOffloadIds.add(normalizeToolCallIdForLookup(id));
        stateManager.deletedOffloadIds.add(id);
        stateManager.deletedOffloadIds.add(normalizeToolCallIdForLookup(id));
      }
      const statusUpdates = new Map<string, string | boolean>();
      for (const id of emergencyResult.deletedToolCallIds) statusUpdates.set(id, "deleted");
      markOffloadStatus(stateManager.ctx, statusUpdates).catch(() => {});
    }
    if (emergencyResult.deletedCount > 0) stateManager._lastAggressiveBoundary = null;
    return { ok: true, compacted: emergencyResult.deletedCount > 0, reason: "self_emergency", messages };
  } catch (err) {
    logger.error?.(`[context-offload] <<< compact ERROR: ${err}`);
    return { ok: false, compacted: false, reason: String(err) };
  }
}

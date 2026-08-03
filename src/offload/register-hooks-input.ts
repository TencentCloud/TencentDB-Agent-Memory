/**
 * register-hooks-input.ts — offload hook registration (part 2: input/boundary).
 *
 * Extracted from index.ts registerOffload() (Group D decomposition).
 * Registers llm_input / before_agent_start / before_prompt_build hooks.
 */
import type { RegisterCtx } from "./register-ctx.js";
import { trackedOn, resolveSession, type HookTracker } from "./register-hooks.js";
import { createBeforePromptBuildHandler } from "./hooks/before-prompt-build.js";
import { parseCreateSkillCommand } from "./engine-helpers.js";
import { isInternalMemorySession } from "./engine-helpers.js";
import { createSkillWithBackend } from "./register-l4.js";
import { buildTiktokenContextSnapshot } from "./context-token-tracker.js";
import { _extractRecentHistory } from "./engine-history-helpers.js";
import { simpleHash, _extractLatestTurn } from "./engine-helpers.js";

/** Register input/boundary hooks (llm_input, before_agent_start, before_prompt_build). */
export function registerInputHooks(ctx: RegisterCtx, tracker: HookTracker): void {
  const { logger, pCfg } = ctx;

  trackedOn(ctx, tracker, "llm_input", async (event: any, hctx: any) => {
    const _llmInputStart = Date.now();
    if (isInternalMemorySession(hctx?.sessionKey)) return;
    logger.debug?.(`[context-offload] >>> llm_input START`);
    const _sk = hctx?.sessionKey;
    const _mgr = _sk ? await resolveSession(ctx, _sk, hctx?.sessionId) : ctx.lastActiveMgr;
    if (!_mgr) return;
    try {
      const historyMessages = Array.isArray(event.historyMessages) ? event.historyMessages : [];
      const sysPrompt = typeof event.systemPrompt === "string" ? event.systemPrompt : null;
      const promptText = typeof event.prompt === "string" ? event.prompt : null;
      _mgr.cachedSystemPrompt = sysPrompt;
      _mgr.cachedUserPrompt = promptText;

      const snap = buildTiktokenContextSnapshot("llm_input", historyMessages, sysPrompt, promptText);
      _mgr.cachedSystemPromptTokens = snap.systemTokens;
      _mgr.cachedUserPromptTokens = snap.userPromptTokens;
      if (snap.systemTokens > 0) {
        _mgr.setEstimatedSystemOverhead(snap.systemTokens);
        if (_mgr.isLoaded()) _mgr.save().catch(() => {});
      }

      if (historyMessages.length > 0) {
        _mgr.cachedLatestTurnMessages = _extractLatestTurn(historyMessages, promptText);
        _mgr.cachedRecentHistory = _extractRecentHistory(historyMessages, promptText);
      }

      logger.debug?.(`[context-offload] <<< llm_input END: ${Date.now() - _llmInputStart}ms`);
    } catch (err) {
      logger.error(`[context-offload] <<< llm_input ERROR: ${err} (${Date.now() - _llmInputStart}ms)`);
    }
  });

  trackedOn(ctx, tracker, "before_agent_start", async (event: any, hctx: any) => {
    if (isInternalMemorySession(hctx?.sessionKey)) return;
    const sk = hctx?.sessionKey;
    const mgr = sk ? await resolveSession(ctx, sk, hctx?.sessionId) : null;
    if (!mgr) return;
    const userPrompt = event.prompt ?? "";
    const skillCommand = parseCreateSkillCommand(userPrompt);
    if (skillCommand) {
      try {
        const result = await createSkillWithBackend(ctx, mgr, skillCommand);
        if (result?.appendSystemContext) ctx.l4State.pendingResult = result;
      } catch { /* ignore */ }
    }
  });

  trackedOn(ctx, tracker, "before_prompt_build", async (event: any, hctx: any) => {
    if (isInternalMemorySession(hctx?.sessionKey)) return;
    const sk = hctx?.sessionKey;
    const mgr = sk ? await resolveSession(ctx, sk, hctx?.sessionId) : ctx.lastActiveMgr;
    if (!mgr) return;

    // L1 flush (fire-and-forget)
    if (mgr.getPendingCount() > 0) {
      ctx.flushL1(mgr, "before_prompt_build_flush", true).then(async () => {
        try {
          const { readAllOffloadEntries } = await import("./storage.js");
          const allEntries = await readAllOffloadEntries(mgr.ctx);
          const nullCount = allEntries.filter((e: any) => e.node_id === null).length;
          if (nullCount > 0) ctx.notifyL2NewNullEntries(nullCount);
        } catch { /* ignore */ }
      }).catch(() => {});
    }

    // In collect mode: trigger L1.5 (fire-and-forget) then skip L3 compression
    if (ctx.offloadConfig.mode === "collect") {
      const _prompt = typeof event?.prompt === "string" ? event.prompt : null;
      if (_prompt && _prompt.length > 0 && ctx.backendClient) {
        const promptHash = simpleHash(_prompt);
        const lastHash = mgr.lastL15PromptHash;
        if (promptHash !== lastHash) {
          mgr.lastL15PromptHash = promptHash;
          mgr.l15Settled = false;
          ctx.judgeL15(mgr, { prompt: _prompt, messages: event.messages ?? [] }, { sessionKey: hctx?.sessionKey }).catch((err: any) => {
            logger.warn(`[context-offload] collect L1.5 judge failed: ${err}`);
          });
        }
      }
      return;
    }

    // Fast-path re-apply + L3 compression + MMD injection
    const bpbHandler = createBeforePromptBuildHandler(mgr, logger, ctx.getContextWindow, pCfg);
    await bpbHandler(event, hctx);
  });
}

/**
 * register-hooks.ts — offload hook registration (part 1: tool-call + output).
 *
 * Extracted from index.ts registerOffload() (Group D decomposition).
 * Registers before_tool_call / after_tool_call / llm_output hooks. Hooks are
 * no-ops when the context-engine slot is rejected (engineState).
 */
import type { RegisterCtx } from "./register-ctx.js";
import { engineState } from "./engine.js";
import { createAfterToolCallHandler } from "./hooks/after-tool-call.js";
import { shouldForceL1 } from "./hooks/llm-output.js";
import { readAllOffloadEntries } from "./storage.js";

/** Track registered hook names (diagnostics). */
export interface HookTracker {
  names: string[];
}

/** Register a hook via api.on with the rejected-slot guard. */
export function trackedOn(
  ctx: RegisterCtx,
  tracker: HookTracker,
  hookName: string,
  handler: (...args: any[]) => any,
): void {
  tracker.names.push(hookName);
  if (typeof ctx.api.on === "function") {
    ctx.api.on(hookName, (...args: any[]) => {
      if (engineState.contextEngineRejected) return; // slot not acquired — all offload disabled
      return handler(...args);
    });
  } else {
    ctx.logger.error(`[context-offload] api.on not available for hook "${hookName}"! Hook will not fire.`);
  }
}

/** Resolve a session manager and update last-active tracking. */
export async function resolveSession(
  ctx: RegisterCtx,
  sessionKey: string,
  sessionId?: string,
): Promise<import("./state-manager.js").OffloadStateManager | null> {
  if (!sessionKey) return null;
  const entry = await ctx.sessions.resolveIfAllowed(sessionKey, sessionId);
  if (!entry) return null;
  ctx.lastActiveMgr = entry.manager;
  ctx.lastActiveSessionKey = sessionKey;
  return entry.manager;
}

/** Register tool-call + output hooks (before_tool_call, after_tool_call, llm_output). */
export function registerToolCallHooks(ctx: RegisterCtx, tracker: HookTracker): void {
  const { logger, pCfg } = ctx;

  trackedOn(ctx, tracker, "before_tool_call", async (event: any, hctx: any) => {
    const sk = hctx?.sessionKey;
    if (!sk) return;
    const mgr = await resolveSession(ctx, sk, hctx?.sessionId);
    if (!mgr) return;
    const toolCallId = event.toolCallId ?? hctx.toolCallId;
    if (toolCallId && event.params != null) {
      mgr.cacheToolParams(toolCallId, event.params);
    }
  });

  trackedOn(ctx, tracker, "after_tool_call", async (event: any, hctx: any) => {
    const _atcStart = Date.now();
    const _toolName = event.toolName ?? "unknown";
    const _toolCallId = event.toolCallId ?? "N/A";
    logger.debug?.(`[context-offload] >>> after_tool_call START: tool=${_toolName} id=${_toolCallId}`);
    try {
      const sk = hctx?.sessionKey;
      const _mgr = sk ? await resolveSession(ctx, sk, hctx?.sessionId) : ctx.lastActiveMgr;
      if (!_mgr) {
        logger.debug?.(`[context-offload] <<< after_tool_call SKIP: no session manager (${Date.now() - _atcStart}ms)`);
        return;
      }
      const afterToolCallHandler = createAfterToolCallHandler(_mgr, logger, ctx.getContextWindow, pCfg, ctx.backendClient as any);
      await afterToolCallHandler(event, hctx);
      const _handlerDone = Date.now();
      logger.debug?.(`[context-offload] after_tool_call handler done: ${_handlerDone - _atcStart}ms`);

      const pending = _mgr.getPendingCount();
      const threshold = pCfg.forceTriggerThreshold ?? 4;
      if (shouldForceL1(_mgr, pCfg)) {
        logger.debug?.(`[context-offload] L1 TRIGGERED: pending=${pending} >= threshold=${threshold}, flushing...`);
        ctx.flushL1(_mgr, "force_threshold", true).then(async () => {
          try {
            const allEntries = await readAllOffloadEntries(_mgr.ctx);
            const nullCount = allEntries.filter((e) => e.node_id === null).length;
            ctx.notifyL2NewNullEntries(nullCount);
          } catch { /* ignore */ }
        }).catch(() => {});
      } else {
        logger.debug?.(`[context-offload] L1 pending: ${pending}/${threshold} (not yet)`);
      }
      logger.debug?.(`[context-offload] <<< after_tool_call END: tool=${_toolName} total=${Date.now() - _atcStart}ms`);
    } catch (err) {
      logger.error(`[context-offload] <<< after_tool_call ERROR: tool=${_toolName} ${err} (${Date.now() - _atcStart}ms)`);
    }
  });

  trackedOn(ctx, tracker, "llm_output", async (event: any, hctx: any) => {
    const sk = hctx?.sessionKey;
    const mgr = sk ? ctx.sessions.get(sk)?.manager : ctx.lastActiveMgr;
    if (!mgr) return;
    const pendingCount = mgr.getPendingCount();
    if (pendingCount > 0) {
      logger.debug?.(
        `[context-offload] llm_output: ${pendingCount} pending tool pairs (will be flushed at next llm_input or after_tool_call batch)`,
      );
    }
  });
}

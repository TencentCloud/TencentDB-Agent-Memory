/**
 * register.ts — registerOffload() composer.
 *
 * Extracted from index.ts (Group D decomposition). Builds the register ctx,
 * wires L1/L1.5/L2/L4 helpers, registers hooks, registers the context engine
 * and starts the reclaim scheduler. Public API: registerOffload.
 */
import type { OffloadConfig } from "../config.js";
import { buildRegisterCtx, type RegisterCtx } from "./register-ctx.js";
import { flushL1 } from "./register-flush.js";
import { judgeL15 } from "./register-l15-judge.js";
import { runL2WithBackend } from "./register-l2.js";
import { registerToolCallHooks, type HookTracker } from "./register-hooks.js";
import { registerInputHooks } from "./register-hooks-input.js";
import { registerContextEngine, startReclaimScheduler } from "./register-engine.js";
import { engineState } from "./engine.js";
import {
  clearL2Poll, armL2Poll, tryTriggerL2, notifyL2NewNullEntries,
  type L2SchedulerDeps,
} from "./l2-scheduler.js";
import { readAllOffloadEntries } from "./storage.js";

/** Compose the L2 scheduler deps (wired to ctx state + backend executor). */
function makeL2Deps(ctx: RegisterCtx): L2SchedulerDeps {
  return {
    getLastActiveMgr: () => ctx.lastActiveMgr,
    logger: ctx.logger,
    pCfg: ctx.pCfg,
    l2Threshold: ctx.l2Threshold,
    l2TimeoutMs: ctx.l2TimeoutMs,
    tryTriggerL2: (source) => tryTriggerL2(source, makeL2Deps(ctx)),
    runL2WithBackend: (mgr, entriesByMmd, triggerSource) => runL2WithBackend(ctx, mgr, entriesByMmd, triggerSource),
  };
}

/** Wire all function slots on ctx (called after ctx is built). */
function wireCtx(ctx: RegisterCtx): void {
  const l2Deps = makeL2Deps(ctx);
  ctx.flushL1 = (mgr: any, source: string, fireAndForget?: boolean, maxCount?: number) => flushL1(ctx, mgr, source, fireAndForget, maxCount);
  ctx.judgeL15 = (mgr: any, event: any, hctx: any) => judgeL15(ctx, mgr, event, hctx);
  ctx.runL2WithBackend = (mgr: any, entriesByMmd: Map<string, any[]>, triggerSource: string) => runL2WithBackend(ctx, mgr, entriesByMmd, triggerSource);
  ctx.tryTriggerL2 = (source: string) => tryTriggerL2(source, l2Deps);
  ctx.armL2Poll = () => armL2Poll(l2Deps);
  ctx.clearL2Poll = () => clearL2Poll();
  ctx.notifyL2NewNullEntries = (count: number) => notifyL2NewNullEntries(count, l2Deps);
}

/**
 * Register the offload module. Mirrors index.ts registerOffload().
 * Public entry point (repo root index.ts:27 imports this).
 */
export function registerOffload(api: any, offloadConfig: OffloadConfig): void {
  const ctx = buildRegisterCtx(api, offloadConfig);
  const { logger } = ctx;

  logger.debug?.("[context-offload] Registering offload module...");
  wireCtx(ctx);

  // Reset L2 scheduler state on re-registration (previous call may have polled).
  clearL2Poll();
  ctx.lastActiveMgr = null;
  ctx.lastActiveSessionKey = null;

  const tracker: HookTracker = { names: [] };
  registerToolCallHooks(ctx, tracker);
  registerInputHooks(ctx, tracker);
  logger.debug?.(`[context-offload] [DIAG] Hooks registered via api.on: [${tracker.names.join(", ")}] (${tracker.names.length} total)`);

  registerContextEngine(ctx);
  if (engineState.contextEngineRejected) return; // slot not acquired — hooks are no-ops
  startReclaimScheduler(ctx);

  logger.debug?.("[context-offload] Offload module registration complete.");
}

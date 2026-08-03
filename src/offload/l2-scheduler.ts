/**
 * l2-scheduler.ts — L2 background scheduler (poll + trigger).
 *
 * The module-level singletons live in engine.ts (engineState). This file
 * provides the scheduler functions that read/write that state.
 *
 * Extracted from index.ts (Group D decomposition).
 */
import { readAllOffloadEntries } from "./storage.js";
import { checkL2Trigger } from "./pipelines/l2-mermaid.js";
import { engineState } from "./engine.js";
import type { OffloadStateManager } from "./state-manager.js";
import type { PluginConfig, PluginLogger } from "./types.js";

export interface L2SchedulerDeps {
  getLastActiveMgr: () => OffloadStateManager | null;
  logger: PluginLogger;
  pCfg: Partial<PluginConfig>;
  l2Threshold: number;
  l2TimeoutMs: number;
  tryTriggerL2: (source: string) => Promise<void>;
  /** Backend-aware L2 executor (captures backendClient per call — stays in register-*). */
  runL2WithBackend: (
    stateManager: OffloadStateManager,
    entriesByMmd: Map<string, any[]>,
    triggerSource: string,
  ) => Promise<void>;
}

export function clearL2Poll(): void {
  if (engineState.l2PollHandle !== null) { clearTimeout(engineState.l2PollHandle); engineState.l2PollHandle = null; }
  engineState.l2FirstNotifyAt = null;
}

export function resetL2SchedulerState(): void {
  if (engineState.l2PollHandle !== null) { clearTimeout(engineState.l2PollHandle); engineState.l2PollHandle = null; }
  engineState.l2FirstNotifyAt = null;
  engineState.l2Running = false;
}

export function armL2Poll(deps: L2SchedulerDeps): void {
  if (engineState.l2PollHandle !== null) return;
  if (engineState.l2FirstNotifyAt === null) engineState.l2FirstNotifyAt = Date.now();
  const tick = async () => {
    engineState.l2PollHandle = null;
    const mgr = deps.getLastActiveMgr();
    if (!mgr) return;
    if (!mgr.l15Settled) {
      const l15WaitAge = engineState.l2FirstNotifyAt ? Date.now() - engineState.l2FirstNotifyAt : 0;
      if (l15WaitAge > 60_000) {
        mgr.l15Settled = true;
        deps.logger.warn?.("[context-offload] L2 poll: L1.5 settle timeout (60s), force-settling to unblock L2");
      } else {
        deps.logger.debug?.("[context-offload] L2 poll: waiting for L1.5 to settle, deferring...");
        scheduleNextTick();
        return;
      }
    }
    try {
      const allEntries = await readAllOffloadEntries(mgr.ctx);
      const nullCount = allEntries.filter((e) => e.node_id === null).length;
      if (nullCount === 0) { engineState.l2FirstNotifyAt = null; return; }
      if (engineState.l2Running) { scheduleNextTick(); return; }
      const age = Date.now() - (engineState.l2FirstNotifyAt ?? Date.now());
      if (nullCount >= deps.l2Threshold) {
        engineState.l2FirstNotifyAt = null;
        deps.tryTriggerL2("null_threshold").catch(() => {});
      } else if (age >= deps.l2TimeoutMs) {
        engineState.l2FirstNotifyAt = null;
        deps.tryTriggerL2("timer").catch(() => {});
      } else {
        scheduleNextTick();
      }
    } catch { scheduleNextTick(); }
  };
  const scheduleNextTick = () => {
    if (engineState.l2PollHandle !== null) return;
    engineState.l2PollHandle = setTimeout(tick, 5000);
    if (engineState.l2PollHandle && typeof engineState.l2PollHandle === "object" && "unref" in engineState.l2PollHandle) {
      (engineState.l2PollHandle as any).unref();
    }
  };
  engineState.l2PollHandle = setTimeout(tick, 0);
  if (engineState.l2PollHandle && typeof engineState.l2PollHandle === "object" && "unref" in engineState.l2PollHandle) {
    (engineState.l2PollHandle as any).unref();
  }
}

export function notifyL2NewNullEntries(newNullCount: number, deps: L2SchedulerDeps): void {
  if (!deps.getLastActiveMgr() || newNullCount <= 0) return;
  armL2Poll(deps);
}

export async function tryTriggerL2(triggerSource: string, deps: L2SchedulerDeps): Promise<void> {
  if (engineState.l2Running) return;
  const mgr = deps.getLastActiveMgr();
  if (!mgr) return;
  engineState.l2Running = true;
  try {
    const { shouldTrigger, reason, entriesByMmd } = await checkL2Trigger(mgr, deps.pCfg, deps.logger);
    if (!shouldTrigger) return;
    const totalEntries = Array.from(entriesByMmd.values()).reduce((s, a) => s + a.length, 0);
    deps.logger.debug?.(`[context-offload] L2 triggered (${triggerSource}): ${reason}, ${totalEntries} entries across ${entriesByMmd.size} mmd(s)`);
    await deps.runL2WithBackend(mgr, entriesByMmd, triggerSource);
  } catch (err) {
    deps.logger.error?.(`[context-offload] L2 trigger error: ${err}`);
  } finally {
    engineState.l2Running = false;
    try {
      const postEntries = await readAllOffloadEntries(mgr.ctx);
      const postNullCount = postEntries.filter((e) => e.node_id === null).length;
      if (postNullCount >= deps.l2Threshold) {
        clearL2Poll();
        deps.tryTriggerL2("post_completion").catch(() => {});
      } else if (postNullCount > 0) {
        clearL2Poll();
        armL2Poll(deps);
      } else { clearL2Poll(); }
    } catch { armL2Poll(deps); }
  }
}

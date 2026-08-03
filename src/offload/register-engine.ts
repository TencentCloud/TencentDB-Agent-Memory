/**
 * register-engine.ts — context-engine registration + reclaim scheduler.
 *
 * Extracted from index.ts registerOffload() (Group D decomposition).
 * Registers the OffloadContextEngine singleton with the framework, verifies
 * the contextEngine slot, and starts the offload-data reclaim scheduler.
 */
import type { RegisterCtx } from "./register-ctx.js";
import { engineState } from "./engine.js";
import { OffloadContextEngine } from "./engine.js";
import { reclaimOffloadData } from "./reclaimer.js";

const CE_PLUGIN_ID = "memory-tencentdb";

/** Register context engine (singleton hot-update + slot check). */
export function registerContextEngine(ctx: RegisterCtx): void {
  const { api, logger } = ctx;

  if (ctx.offloadConfig.mode === "collect") {
    const _configSlotCE = (api.config as any)?.plugins?.slots?.contextEngine;
    if (_configSlotCE === "memory-tencentdb") {
      logger.warn(`[context-offload] Mode "collect" but slots.contextEngine="${_configSlotCE}". Context Engine will NOT be registered in collect mode - consider removing the slot or switching to mode "backend".`);
    }
    logger.info(`[context-offload] Mode "collect": L3 disabled, context engine NOT registered (using legacy compaction). L1/L1.5/L2 active.`);
    if (ctx.lastActiveMgr) (ctx.lastActiveMgr as any).l15Settled = true;
    engineState.contextEngineRegistered = true;
    return;
  }

  const engineOpts = {
    sessions: ctx.sessions,
    logger,
    pCfg: ctx.pCfg,
    getContextWindow: ctx.getContextWindow,
    dataRoot: ctx.dataRoot,
    notifyL2NewNullEntries: ctx.notifyL2NewNullEntries,
    clearL2Timeout: ctx.clearL2Poll,
    l4State: ctx.l4State,
    flushL1: ctx.flushL1,
    backendClient: ctx.backendClient,
    judgeL15: ctx.judgeL15,
    disposeL15: () => { engineState.l15Disposed = true; },
  };

  if (!engineState.sharedEngine) {
    engineState.sharedEngine = new OffloadContextEngine(engineOpts);
  } else {
    engineState.sharedEngine.update(engineOpts);
    logger.debug?.("[context-offload] Context engine singleton updated with latest closures");
  }

  if (engineState.contextEngineRegistered) {
    logger.debug?.("[context-offload] Context engine already registered, singleton updated (hot-refresh)");
    return;
  }

  const configSlotCE = (api.config as any)?.plugins?.slots?.contextEngine;
  if (configSlotCE !== CE_PLUGIN_ID) {
    logger.warn(`[context-offload] Config plugins.slots.contextEngine="${configSlotCE ?? "(not set)"}" (expected "${CE_PLUGIN_ID}"). Context engine slot not assigned to this plugin - ALL offload functions disabled.`);
    engineState.contextEngineRejected = true;
    return;
  }

  let ceSlotOccupied = false;
  try {
    const result = api.registerContextEngine(CE_PLUGIN_ID, () => engineState.sharedEngine) as any;
    if (result && result.ok === false) {
      logger.error(`[context-offload] registerContextEngine returned { ok: false, existingOwner: ${result.existingOwner ?? "?"} }. Context engine slot occupied — ALL offload functions disabled!`);
      ceSlotOccupied = true;
    } else {
      engineState.contextEngineRegistered = true;
      logger.debug?.("[context-offload] Context engine registered successfully (first call)");
    }
  } catch (ceErr) {
    logger.warn(`[context-offload] registerContextEngine factory failed: ${ceErr}, trying direct object`);
    try {
      const result2 = api.registerContextEngine(CE_PLUGIN_ID, engineState.sharedEngine) as any;
      if (result2 && result2.ok === false) {
        logger.error(`[context-offload] registerContextEngine direct returned { ok: false }. Context engine slot occupied — ALL offload functions disabled!`);
        ceSlotOccupied = true;
      } else {
        engineState.contextEngineRegistered = true;
        logger.debug?.("[context-offload] Context engine registered successfully (direct mode)");
      }
    } catch (ceErr2) {
      logger.error(`[context-offload] registerContextEngine direct also failed: ${ceErr2}. ALL offload functions disabled!`);
      ceSlotOccupied = true;
    }
  }
  if (ceSlotOccupied) {
    engineState.contextEngineRejected = true;
    logger.error("[context-offload] Offload module DISABLED: context engine slot occupied by another plugin. All hooks will be no-ops.");
  }
}

/** Start the offload-data reclaim scheduler (24h interval, 5-min initial delay). */
export function startReclaimScheduler(ctx: RegisterCtx): void {
  const { logger, dataRoot } = ctx;
  if (engineState.reclaimTimer !== null) { clearTimeout(engineState.reclaimTimer); engineState.reclaimTimer = null; }

  const _retentionDays = ctx.offloadConfig.offloadRetentionDays;
  const _logMaxSizeMb = ctx.offloadConfig.logMaxSizeMb;
  if (_retentionDays >= 3) {
    const INITIAL_DELAY_MS = 5 * 60 * 1000;
    const RECLAIM_INTERVAL_MS = 24 * 60 * 60 * 1000;

    const scheduleReclaim = (delayMs: number) => {
      engineState.reclaimTimer = setTimeout(async () => {
        try {
          const stats = await reclaimOffloadData(dataRoot, {
            retentionDays: _retentionDays,
            logMaxSizeMb: _logMaxSizeMb,
          }, logger);
          logger.debug?.(
            `[context-offload] Reclaim done: jsonl=${stats.deletedJsonl}, refs=${stats.deletedRefs}, ` +
            `mmds=${stats.deletedMmds}, logs=${stats.truncatedLogs}, registry=${stats.prunedRegistryEntries}`,
          );
        } catch (err) {
          logger.warn(`[context-offload] Reclaim failed: ${err}`);
        }
        scheduleReclaim(RECLAIM_INTERVAL_MS);
      }, delayMs);
      if (engineState.reclaimTimer && typeof engineState.reclaimTimer === "object" && "unref" in engineState.reclaimTimer) {
        (engineState.reclaimTimer as any).unref();
      }
    };
    scheduleReclaim(INITIAL_DELAY_MS);
    logger.debug?.(`[context-offload] Reclaim scheduler started: retentionDays=${_retentionDays}, logMaxSizeMb=${_logMaxSizeMb}`);
  }
}

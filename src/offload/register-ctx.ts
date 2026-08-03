/**
 * register-ctx.ts — shared registration context for offload.
 *
 * Extracted from index.ts registerOffload() (Group D decomposition).
 * Builds the plugin config (pCfg), session registry singleton and backend
 * client (backend/local/collect modes). Consumers read/write through ctx.
 */
import { BackendClient } from "./backend-client.js";
import type { LocalLlmClient } from "./local-llm/index.js";
import { SessionRegistry } from "./session-registry.js";
import { DEFAULT_DATA_ROOT, type StorageContext } from "./storage.js";
import { PLUGIN_DEFAULTS, type PluginConfig, type PluginLogger } from "./types.js";
import type { OffloadConfig } from "../config.js";
import { resolveUserId, getUserIdSource } from "./user-id.js";
import { configureTokenTracker } from "./context-token-tracker.js";
import { initOffloadOpikTracer } from "./opik-tracer.js";
import { engineState } from "./engine.js";
import { buildLocalClient, resolveContextWindow } from "./register-client.js";

/** Shared registration context (DI container for register-* modules). */
export interface RegisterCtx {
  api: any;
  offloadConfig: OffloadConfig;
  logger: PluginLogger;
  pCfg: Partial<PluginConfig>;
  sessions: SessionRegistry;
  backendClient: BackendClient | LocalLlmClient | null;
  dataRoot: string;
  l2Threshold: number;
  l2TimeoutMs: number;
  /** Last active session key + manager (L2 scheduler global state). */
  lastActiveSessionKey: string | null;
  lastActiveMgr: import("./state-manager.js").OffloadStateManager | null;
  /** L4 pending skill result (before_agent_start → before_prompt_build). */
  l4State: { pendingResult: any };
  /** Function slots filled by register-* modules before hooks fire. */
  flushL1: any;
  judgeL15: any;
  runL2WithBackend: any;
  tryTriggerL2: any;
  armL2Poll: any;
  clearL2Poll: any;
  notifyL2NewNullEntries: any;
  getContextWindow: () => number;
}

/**
 * Build the shared registration context: pCfg, session registry singleton,
 * backend/local client. Mirrors index.ts registerOffload() setup section.
 */
export function buildRegisterCtx(
  api: any,
  offloadConfig: OffloadConfig,
): RegisterCtx {
  const logger: PluginLogger = api.logger;
  initOffloadOpikTracer(api.config, logger);

  const pCfg: Partial<PluginConfig> = {
    model: offloadConfig.model,
    temperature: offloadConfig.temperature,
    forceTriggerThreshold: offloadConfig.forceTriggerThreshold,
    dataDir: offloadConfig.dataDir,
    defaultContextWindow: offloadConfig.defaultContextWindow,
    maxPairsPerBatch: offloadConfig.maxPairsPerBatch,
    l2NullThreshold: offloadConfig.l2NullThreshold,
    l2TimeoutSeconds: offloadConfig.l2TimeoutSeconds,
    mildOffloadRatio: offloadConfig.mildOffloadRatio,
    aggressiveCompressRatio: offloadConfig.aggressiveCompressRatio,
    mmdMaxTokenRatio: offloadConfig.mmdMaxTokenRatio,
  };
  // Fix 4: Configure token tracker encoding to match plugin config (default: o200k_base)
  const _encoding = pCfg.l3TiktokenEncoding ?? PLUGIN_DEFAULTS.l3TiktokenEncoding;
  configureTokenTracker(pCfg.l3TiktokenEncoding);
  logger.debug?.(`[context-offload] Token tracker encoding: ${_encoding} (configured from ${pCfg.l3TiktokenEncoding ? "pluginConfig" : "default"})`);

  const dataRoot = offloadConfig.dataDir ?? DEFAULT_DATA_ROOT;
  // Session Registry — module-level singleton (engineState) so engine + hooks always share the same instance.
  if (!engineState.sharedSessions) {
    engineState.sharedSessions = new SessionRegistry(dataRoot);
  }
  const sessions = engineState.sharedSessions;

  const resolvedUserId = resolveUserId(offloadConfig.userId ?? null);
  logger.debug?.(
    `[context-offload] user-id resolved: "${resolvedUserId}" (source=${getUserIdSource() ?? "?"})`,
  );

  let backendClient: BackendClient | LocalLlmClient | null = null;
  if (offloadConfig.mode === "backend" || offloadConfig.mode === "collect") {
    if (!offloadConfig.backendUrl) {
      logger.error(`[context-offload] mode=${offloadConfig.mode} but backendUrl not configured. L1/L1.5/L2/L4 disabled.`);
    } else {
      backendClient = new BackendClient(
        offloadConfig.backendUrl,
        logger,
        offloadConfig.backendApiKey,
        offloadConfig.backendTimeoutMs,
        () => ctx?.lastActiveSessionKey ?? null,
        () => resolvedUserId,
        () => {
          try { return ctx?.lastActiveMgr?.getLastSessionKey?.() ?? ctx?.lastActiveSessionKey ?? null; } catch { return ctx?.lastActiveSessionKey ?? null; }
        },
      );
    }
  } else {
    backendClient = buildLocalClient(api, offloadConfig, logger);
  }

  const ctx: RegisterCtx = {
    api,
    offloadConfig,
    logger,
    pCfg,
    sessions,
    backendClient,
    dataRoot,
    l2Threshold: pCfg.l2NullThreshold ?? PLUGIN_DEFAULTS.l2NullThreshold,
    l2TimeoutMs: (pCfg.l2TimeoutSeconds ?? PLUGIN_DEFAULTS.l2TimeoutSeconds) * 1000,
    lastActiveSessionKey: null,
    lastActiveMgr: null,
    l4State: { pendingResult: null },
    flushL1: null,
    judgeL15: null,
    runL2WithBackend: null,
    tryTriggerL2: null,
    armL2Poll: null,
    clearL2Poll: null,
    notifyL2NewNullEntries: null,
    getContextWindow: () => resolveContextWindow(api, pCfg),
  };
  return ctx;
}

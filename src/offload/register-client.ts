/**
 * register-client.ts — backend/local LLM client + context-window resolution.
 *
 * Extracted from index.ts registerOffload() (Group D decomposition).
 */
import { LocalLlmClient } from "./local-llm/index.js";
import { PLUGIN_DEFAULTS, type PluginConfig, type PluginLogger } from "./types.js";
import type { OffloadConfig } from "../config.js";
import { resolveApiKeyFromAuthProfile } from "./auth-profile-key.js";

/** Local LLM client resolution (models.providers + auth-profile fallback). */
export function buildLocalClient(
  api: any,
  offloadConfig: OffloadConfig,
  logger: PluginLogger,
): LocalLlmClient | null {
  let resolvedModelRef = offloadConfig.model;
  if (!resolvedModelRef) {
    const mainConfig = api.config as Record<string, unknown> | undefined;
    const agents = mainConfig?.agents as Record<string, unknown> | undefined;
    const defaults = agents?.defaults as Record<string, unknown> | undefined;
    const modelCfg = defaults?.model;
    if (typeof modelCfg === "string" && modelCfg.includes("/")) {
      resolvedModelRef = modelCfg;
    } else if (modelCfg && typeof modelCfg === "object") {
      const primary = (modelCfg as Record<string, unknown>).primary;
      if (typeof primary === "string" && primary.includes("/")) {
        resolvedModelRef = primary;
      }
    }
  }
  if (!resolvedModelRef) {
    logger.warn("[context-offload] No model resolved (offload.model not set, agents.defaults.model not found). L1/L1.5/L2 disabled.");
    return null;
  }
  const modelParts = resolvedModelRef.split("/", 2);
  const providerKey = modelParts[0];
  const modelId = modelParts[1] ?? resolvedModelRef;
  const models = (api.config as any)?.models;
  const providerCfg = models?.providers?.[providerKey];
  const baseUrl = providerCfg?.baseUrl ?? providerCfg?.baseURL;
  const apiKey = providerCfg?.apiKey ?? resolveApiKeyFromAuthProfile(api, providerKey, logger);
  if (!baseUrl || !apiKey) {
    logger.error(
      `[context-offload] Local LLM mode failed: provider "${providerKey}" not found or missing baseUrl/apiKey in models.providers (or auth profiles). L1/L1.5/L2 disabled.`,
    );
    return null;
  }
  return new LocalLlmClient(
    { baseUrl, apiKey, model: modelId, temperature: offloadConfig.temperature, timeoutMs: offloadConfig.backendTimeoutMs, disableThinking: offloadConfig.disableThinking },
    logger,
  );
}

/** Context window resolution (model contextWindow → config → plugin default). */
export function resolveContextWindow(
  api: any,
  pCfg: Partial<PluginConfig>,
): number {
  try {
    const config = api.config;
    const agents = config?.agents;
    const defaults = agents?.defaults;
    const defaultModel = typeof defaults?.model === "string"
      ? defaults.model
      : (typeof defaults?.model === "object" && typeof (defaults?.model as any)?.primary === "string")
        ? (defaults.model as any).primary
        : null;
    const models = config?.models;
    if (defaultModel && models) {
      const [providerKey, modelId] = defaultModel.split("/", 2);
      const provider = models.providers?.[providerKey];
      if (provider?.models) {
        const modelList = Array.isArray(provider.models) ? provider.models : [];
        for (const m of modelList) {
          if (m.id === modelId && typeof m.contextWindow === "number") return m.contextWindow;
        }
      }
    }
    if (models?.contextWindow && typeof models.contextWindow === "number") return models.contextWindow;
  } catch { /* ignore */ }
  if (typeof pCfg.defaultContextWindow === "number" && pCfg.defaultContextWindow > 0) {
    return pCfg.defaultContextWindow;
  }
  return PLUGIN_DEFAULTS.defaultContextWindow;
}

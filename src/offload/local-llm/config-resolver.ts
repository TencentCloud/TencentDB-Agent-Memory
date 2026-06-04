/**
 * Resolve LLM provider configuration for local-llm mode.
 *
 * Supports both direct config (models.providers) and OpenClaw auth-profiles.
 * When auth-profiles is used, the apiKey is not injected into models.providers
 * at runtime; we must call api.getAuthProviderCredential(providerKey) to retrieve it.
 */
import type { PluginLogger } from "../types.js";

export interface LocalLlmResolvedConfig {
  providerKey: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
}

/**
 * Parse a model reference string into provider key and model ID.
 *
 * Expected formats:
 *   - "provider/model-id"  → { providerKey: "provider", modelId: "model-id" }
 *   - "model-id"           → { providerKey: "model-id", modelId: "model-id" }
 */
export function parseModelRef(resolvedModelRef: string): {
  providerKey: string;
  modelId: string;
} {
  const modelParts = resolvedModelRef.split("/", 2);
  const providerKey = modelParts[0];
  const modelId = modelParts[1] ?? resolvedModelRef;
  return { providerKey, modelId };
}

/**
 * Resolve the full local-LLM configuration from the OpenClaw api object.
 *
 * Resolution order:
 *   1. baseUrl from models.providers[providerKey].baseUrl (or .baseURL alias)
 *   2. apiKey from models.providers[providerKey].apiKey (direct config)
 *   3. If apiKey missing, fallback to api.getAuthProviderCredential(providerKey)
 *
 * Returns null if baseUrl or apiKey cannot be resolved.
 */
export function resolveLocalLlmConfig(
  api: any,
  resolvedModelRef: string,
  logger?: PluginLogger,
): LocalLlmResolvedConfig | null {
  const { providerKey, modelId } = parseModelRef(resolvedModelRef);

  const models = (api.config as any)?.models;
  const providerCfg = models?.providers?.[providerKey];

  const baseUrl = providerCfg?.baseUrl ?? providerCfg?.baseURL;

  // 1. Try direct config first (backward compatible)
  let apiKey: string | undefined = providerCfg?.apiKey;

  // 2. Fallback to OpenClaw auth-profiles
  if (!apiKey && typeof api.getAuthProviderCredential === "function") {
    try {
      const authCreds = api.getAuthProviderCredential(providerKey);
      apiKey = authCreds?.apiKey ?? authCreds?.key;
      if (apiKey) {
        logger?.debug?.(
          `[context-offload] Resolved apiKey for provider "${providerKey}" via auth-profiles`,
        );
      }
    } catch (e) {
      logger?.debug?.(
        `[context-offload] getAuthProviderCredential failed for "${providerKey}": ${e}`,
      );
    }
  }

  if (!baseUrl || !apiKey) {
    return null;
  }

  return { providerKey, modelId, baseUrl, apiKey };
}

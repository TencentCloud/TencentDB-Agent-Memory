import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { buildSingleProviderApiKeyCatalog } from "openclaw/plugin-sdk/provider-catalog-shared";
import { wrapMemoryProxyStream } from "./src/bridge.js";
import { normalizeConfig, providerBaseUrl, registryScope, resolveStateFile } from "./src/config.js";
import { registerMemoryProxyCommand } from "./src/commands.js";
import { IdentityRegistry } from "./src/registry.js";
import type { BridgePluginConfig } from "./src/types.js";

const PROVIDER_ID = "memory-proxy";
const ENV_VAR = "MEMORY_PROXY_API_KEY";
function buildProvider(config: BridgePluginConfig) {
  return { api: config.api ?? "openai-completions", baseUrl: providerBaseUrl(config), models: (config.models ?? []).map((model) => ({ id: model.id, name: model.name ?? model.id, reasoning: model.reasoning ?? false, input: model.input ?? ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: model.contextWindow ?? 128_000, maxTokens: model.maxTokens ?? 8_192 })) };
}

export default definePluginEntry({
  id: "memory-proxy-bridge", name: "TencentDB Memory Proxy Bridge",
  description: "OpenClaw Agent/Session identity bridge for Memory Proxy.",
  register(api) {
    const config = normalizeConfig(api.pluginConfig as Record<string, unknown> | undefined);
    const defaultModelId = config.models?.[0]?.id ?? "default";
    const registry = new IdentityRegistry({ filePath: resolveStateFile(config), scope: registryScope(config), configuredAgents: config.agentMappings, maxSessions: config.maxSessions ?? 5_000 });
    api.registerProvider({
      id: PROVIDER_ID, label: "TencentDB Memory Proxy", envVars: [ENV_VAR],
      auth: [createProviderApiKeyAuthMethod({ providerId: PROVIDER_ID, methodId: "api-key", label: "Memory Proxy user key", hint: "User key verified by Memory Proxy/Core", optionKey: "memoryProxyApiKey", flagName: "--memory-proxy-api-key", envVar: ENV_VAR, promptMessage: "Enter the Memory Proxy user key", defaultModel: `${PROVIDER_ID}/${defaultModelId}`, expectedProviders: [PROVIDER_ID], noteTitle: "TencentDB Memory Proxy", noteMessage: `Requests are routed to ${providerBaseUrl(config)} with per-agent/session identity headers.` })],
      catalog: { order: "simple", run: (ctx) => buildSingleProviderApiKeyCatalog({ ctx, providerId: PROVIDER_ID, buildProvider: () => buildProvider(config), allowExplicitBaseUrl: false }) },
      staticCatalog: { order: "simple", run: async () => ({ provider: buildProvider(config) }) },
      wrapStreamFn: (context) => wrapMemoryProxyStream(context, registry),
      wrapSimpleCompletionStreamFn: (context) => wrapMemoryProxyStream(context, registry),
    });
    registerMemoryProxyCommand(api, registry);
    api.logger.info?.(`[memory-proxy] provider registered: baseUrl=${providerBaseUrl(config)}, agents=${Object.keys(config.agentMappings).length}, state=${resolveStateFile(config)}`);
  },
});

export { wrapMemoryProxyStream } from "./src/bridge.js";
export { normalizeConfig, providerBaseUrl, registryScope, resolveStateFile } from "./src/config.js";
export { IdentityRegistry } from "./src/registry.js";
export type * from "./src/types.js";

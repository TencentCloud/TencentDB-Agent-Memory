import { V3MemoryClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";
import type { PluginConfig } from "./config.js";
import { createKnowledgeTools, type KnowledgeTools } from "./knowledge.js";

export function createMemoryClient(config: PluginConfig, timeoutMs: number): V3MemoryClient {
  return new V3MemoryClient({
    endpoint: config.gatewayUrl,
    apiKey: config.gatewayApiKey,
    serviceId: config.serviceId,
    teamId: config.teamId,
    agentId: config.agentId,
    userId: config.userId,
    timeout: timeoutMs,
  });
}

/** Wiki tools exist only when a Knowledge Service URL is configured. */
export function createKnowledge(config: PluginConfig, timeoutMs = 15_000): KnowledgeTools | undefined {
  if (!config.knowledgeUrl) return undefined;
  return createKnowledgeTools({
    baseUrl: config.knowledgeUrl,
    apiKey: config.knowledgeApiKey,
    serviceId: config.serviceId,
    teamId: config.teamId,
    userId: config.userId,
    agentId: config.agentId,
    timeoutMs,
  });
}

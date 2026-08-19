import { MemoryClient, MetadataClient, SkillClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";
import type { LoadedConfig } from "./types.js";

export interface AdapterClients {
  memory: MemoryClient;
  metadata: MetadataClient;
  skill: SkillClient;
}

export function createSessionMemoryClient(config: LoadedConfig, sessionId: string): MemoryClient {
  return createClients(config).memory.withIsolation({ sessionId });
}

export function createClients(config: LoadedConfig): AdapterClients {
  const common = {
    endpoint: config.endpoint,
    apiKey: config.gatewayApiKey,
    serviceId: config.serviceId,
    timeout: config.timeoutMs,
    rejectUnauthorized: config.rejectUnauthorized,
  };
  return {
    memory: new MemoryClient({
      ...common,
      teamId: config.teamId,
      agentId: config.agentId,
      userId: config.userId,
    }),
    metadata: new MetadataClient({
      ...common,
      userKey: config.userKey,
    }),
    skill: new SkillClient({
      ...common,
      teamId: config.teamId,
      agentId: config.agentId,
      userId: config.userId,
    }),
  };
}

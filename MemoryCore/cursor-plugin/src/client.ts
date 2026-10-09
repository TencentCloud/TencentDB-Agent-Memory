import { MemoryClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";
import type { CursorConfig } from "./config.js";

type RequiredClientField =
  | "gatewayUrl"
  | "gatewayApiKey"
  | "serviceId"
  | "teamId"
  | "agentId"
  | "userId";

function required(config: CursorConfig, field: RequiredClientField): string {
  const value = config[field]?.trim();
  if (!value) throw new Error(`${field} is required`);
  return value;
}

export function createMemoryClient(
  config: CursorConfig,
  timeoutMs?: number,
): MemoryClient {
  return new MemoryClient({
    endpoint: required(config, "gatewayUrl"),
    apiKey: required(config, "gatewayApiKey"),
    serviceId: required(config, "serviceId"),
    teamId: required(config, "teamId"),
    agentId: required(config, "agentId"),
    userId: required(config, "userId"),
    taskId: config.taskId?.trim() || undefined,
    timeout: timeoutMs,
    rejectUnauthorized: true,
  });
}

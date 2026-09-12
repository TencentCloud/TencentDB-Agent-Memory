import os from "node:os";
import type { PiAgentAdapterConfig } from "./types.js";

function envFlag(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function envNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadPiAgentAdapterConfig(env: NodeJS.ProcessEnv = process.env): PiAgentAdapterConfig {
  return {
    gatewayUrl: env.MEMORY_TENCENTDB_PI_GATEWAY_URL || env.MEMORY_TENCENTDB_GATEWAY_URL || "http://127.0.0.1:8420",
    gatewayApiKey: env.MEMORY_TENCENTDB_PI_GATEWAY_API_KEY || env.MEMORY_TENCENTDB_GATEWAY_API_KEY || env.TDAI_GATEWAY_API_KEY,
    autoRecall: envFlag(env.MEMORY_TENCENTDB_PI_AUTO_RECALL, true),
    autoCapture: envFlag(env.MEMORY_TENCENTDB_PI_AUTO_CAPTURE, true),
    recallMaxChars: envNumber(env.MEMORY_TENCENTDB_PI_RECALL_MAX_CHARS, 4000),
    defaultUserId: env.MEMORY_TENCENTDB_PI_USER_ID || env.TDAI_USER_ID || os.userInfo().username || "default_user",
  };
}
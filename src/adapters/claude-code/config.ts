import os from "node:os";
import path from "node:path";
import type { ClaudeCodeAdapterConfig } from "./types.js";

function envFlag(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === "") return fallback;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function envInt(value: string | undefined, fallback: number): number {
  if (value == null || value.trim() === "") return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeGatewayUrl(value: string | undefined): string {
  const raw = value?.trim() || "http://127.0.0.1:8420";
  return raw.replace(/\/+$/, "");
}

function defaultStorageDir(): string {
  return path.join(os.homedir(), ".memory-tencentdb", "claude-code-offload");
}

export function loadClaudeCodeAdapterConfig(
  env: NodeJS.ProcessEnv = process.env,
): ClaudeCodeAdapterConfig {
  return {
    gatewayUrl: normalizeGatewayUrl(env.MEMORY_TENCENTDB_GATEWAY_URL),
    gatewayApiKey: env.MEMORY_TENCENTDB_GATEWAY_API_KEY || env.TDAI_GATEWAY_API_KEY || undefined,
    autoRecall: envFlag(env.MEMORY_TENCENTDB_AUTO_RECALL, true),
    recallMaxChars: envInt(env.MEMORY_TENCENTDB_RECALL_MAX_CHARS, 4000),
    canvasMaxChars: envInt(env.MEMORY_TENCENTDB_CANVAS_MAX_CHARS, 3000),
    shortTermEnabled: envFlag(env.MEMORY_TENCENTDB_SHORT_TERM, true),
    storageDir: env.MEMORY_TENCENTDB_CLAUDE_STORAGE_DIR || defaultStorageDir(),
  };
}


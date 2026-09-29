import { homedir } from "node:os";
import { join } from "node:path";
import type { AdapterLogger, CaptureMode, CodexAdapterConfig } from "./types.js";

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8420";

function optional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function positiveInteger(value: string | undefined, fallback: number, name: string, logger: AdapterLogger): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  logger.warn(`${name} must be a positive integer; using ${fallback}.`);
  return fallback;
}

function booleanValue(value: string | undefined, fallback: boolean, name: string, logger: AdapterLogger): boolean {
  if (!value?.trim()) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  logger.warn(`${name} must be true or false; using ${String(fallback)}.`);
  return fallback;
}

function captureMode(value: string | undefined, logger: AdapterLogger): CaptureMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "summary";
  if (normalized === "summary" || normalized === "turn" || normalized === "raw") return normalized;
  logger.warn("MEMORY_TENCENTDB_CODEX_CAPTURE_MODE must be summary, turn, or raw; using summary.");
  return "summary";
}

function gatewayUrl(value: string | undefined, logger: AdapterLogger): string {
  const normalized = optional(value) ?? DEFAULT_GATEWAY_URL;
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return normalized;
  } catch {
    // Fall through to the documented local default.
  }
  logger.warn(`MEMORY_TENCENTDB_CODEX_GATEWAY_URL is invalid; using ${DEFAULT_GATEWAY_URL}.`);
  return DEFAULT_GATEWAY_URL;
}

export function loadCodexAdapterConfig(
  env: NodeJS.ProcessEnv = process.env,
  logger: AdapterLogger,
): CodexAdapterConfig {
  return {
    gatewayUrl: gatewayUrl(env.MEMORY_TENCENTDB_CODEX_GATEWAY_URL, logger),
    gatewayCommand: optional(env.MEMORY_TENCENTDB_CODEX_GATEWAY_CMD),
    gatewayApiKey:
      optional(env.MEMORY_TENCENTDB_CODEX_GATEWAY_API_KEY) ?? optional(env.TDAI_GATEWAY_API_KEY),
    requestTimeoutMs: positiveInteger(
      env.MEMORY_TENCENTDB_CODEX_REQUEST_TIMEOUT_MS,
      10_000,
      "MEMORY_TENCENTDB_CODEX_REQUEST_TIMEOUT_MS",
      logger,
    ),
    enableSupervisor: booleanValue(
      env.MEMORY_TENCENTDB_CODEX_ENABLE_SUPERVISOR,
      true,
      "MEMORY_TENCENTDB_CODEX_ENABLE_SUPERVISOR",
      logger,
    ),
    explicitSessionKey: optional(env.MEMORY_TENCENTDB_CODEX_SESSION_KEY),
    userId: optional(env.MEMORY_TENCENTDB_CODEX_USER_ID) ?? "default_user",
    logDir:
      optional(env.MEMORY_TENCENTDB_CODEX_LOG_DIR) ?? join(homedir(), ".codex", "logs", "memory_tencentdb"),
    captureMode: captureMode(env.MEMORY_TENCENTDB_CODEX_CAPTURE_MODE, logger),
    resultMaxChars: positiveInteger(
      env.MEMORY_TENCENTDB_CODEX_RESULT_MAX_CHARS,
      12_000,
      "MEMORY_TENCENTDB_CODEX_RESULT_MAX_CHARS",
      logger,
    ),
  };
}

import { homedir } from "node:os";
import { join } from "node:path";
import type { AdapterLogger, OpenCodeAdapterConfig } from "./types.js";

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8420";

function optional(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  logger: AdapterLogger,
): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  logger.warn(`${name} must be a positive integer; using ${fallback}.`);
  return fallback;
}

function booleanValue(
  value: string | undefined,
  fallback: boolean,
  name: string,
  logger: AdapterLogger,
): boolean {
  if (!value?.trim()) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  logger.warn(`${name} must be true or false; using ${String(fallback)}.`);
  return fallback;
}

function gatewayUrl(value: string | undefined, logger: AdapterLogger): string {
  const normalized = optional(value) ?? DEFAULT_GATEWAY_URL;
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return normalized.replace(/\/+$/, "");
    }
  } catch {
    // The warning below is more useful than the URL parser error.
  }
  logger.warn(
    `MEMORY_TENCENTDB_OPENCODE_GATEWAY_URL is invalid; using ${DEFAULT_GATEWAY_URL}.`,
  );
  return DEFAULT_GATEWAY_URL;
}

export function loadOpenCodeAdapterConfig(
  env: NodeJS.ProcessEnv = process.env,
  logger: AdapterLogger,
  options: Record<string, unknown> = {},
): OpenCodeAdapterConfig {
  const option = (
    key: string,
    envValue: string | undefined,
  ): string | undefined => {
    const value = options[key];
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean")
      return String(value);
    return envValue;
  };
  return {
    gatewayUrl: gatewayUrl(
      option("gatewayUrl", env.MEMORY_TENCENTDB_OPENCODE_GATEWAY_URL),
      logger,
    ),
    gatewayCommand: optional(
      option("gatewayCommand", env.MEMORY_TENCENTDB_OPENCODE_GATEWAY_CMD),
    ),
    gatewayApiKey:
      optional(
        option("gatewayApiKey", env.MEMORY_TENCENTDB_OPENCODE_GATEWAY_API_KEY),
      ) ?? optional(env.TDAI_GATEWAY_API_KEY),
    requestTimeoutMs: positiveInteger(
      option(
        "requestTimeoutMs",
        env.MEMORY_TENCENTDB_OPENCODE_REQUEST_TIMEOUT_MS,
      ),
      10_000,
      "MEMORY_TENCENTDB_OPENCODE_REQUEST_TIMEOUT_MS",
      logger,
    ),
    startupTimeoutMs: positiveInteger(
      option(
        "startupTimeoutMs",
        env.MEMORY_TENCENTDB_OPENCODE_STARTUP_TIMEOUT_MS,
      ),
      30_000,
      "MEMORY_TENCENTDB_OPENCODE_STARTUP_TIMEOUT_MS",
      logger,
    ),
    enableSupervisor: booleanValue(
      option(
        "enableSupervisor",
        env.MEMORY_TENCENTDB_OPENCODE_ENABLE_SUPERVISOR,
      ),
      false,
      "MEMORY_TENCENTDB_OPENCODE_ENABLE_SUPERVISOR",
      logger,
    ),
    explicitSessionKey: optional(
      option("sessionKey", env.MEMORY_TENCENTDB_OPENCODE_SESSION_KEY),
    ),
    userId:
      optional(option("userId", env.MEMORY_TENCENTDB_OPENCODE_USER_ID)) ??
      "default_user",
    logDir:
      optional(option("logDir", env.MEMORY_TENCENTDB_OPENCODE_LOG_DIR)) ??
      join(homedir(), ".config", "opencode", "logs", "memory_tencentdb"),
    resultMaxChars: positiveInteger(
      option("resultMaxChars", env.MEMORY_TENCENTDB_OPENCODE_RESULT_MAX_CHARS),
      12_000,
      "MEMORY_TENCENTDB_OPENCODE_RESULT_MAX_CHARS",
      logger,
    ),
  };
}

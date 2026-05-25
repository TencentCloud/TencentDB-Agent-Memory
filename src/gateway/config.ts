/**
 * TDAI Gateway — Configuration management.
 *
 * Reads gateway configuration from:
 * 1. `tdai-gateway.yaml` (or JSON) in CWD or data dir
 * 2. Environment variables (override individual fields)
 *
 * Minimal config: just LLM API credentials. Everything else has sensible defaults.
 */

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { getEnv } from "../utils/env.js";
import { parseConfig as parseMemoryConfig } from "../config.js";
import type { MemoryTdaiConfig } from "../config.js";
import type { StandaloneLLMConfig } from "../adapters/standalone/llm-runner.js";

// ============================
// Gateway config types
// ============================

export interface GatewayConfig {
  server: {
    port: number;
    host: string;
  };
  data: {
    /** Base directory for TDAI data storage. */
    baseDir: string;
  };
  llm: StandaloneLLMConfig;
  /** Parsed memory-tdai plugin config (recall, capture, extraction, pipeline, etc.). */
  memory: MemoryTdaiConfig;
}

// ============================
// Config loading
// ============================

/**
 * Load gateway config from file + environment variables.
 *
 * Resolution order for config file:
 * 1. `TDAI_GATEWAY_CONFIG` env var (explicit path)
 * 2. `./tdai-gateway.yaml` or `./tdai-gateway.json` in CWD
 * 3. `<dataDir>/tdai-gateway.yaml` or `<dataDir>/tdai-gateway.json`
 * 4. Pure environment-variable config (no file)
 */
export function loadGatewayConfig(overrides?: Partial<GatewayConfig>): GatewayConfig {
  let fileConfig: Record<string, unknown> = {};

  // Try to load config file
  const configPath = resolveConfigPath();
  if (configPath) {
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      if (configPath.endsWith(".json")) {
        fileConfig = JSON.parse(raw);
      } else {
      // Full YAML support (arbitrary nesting, anchors, lists, multi-line).
        // We still postprocess ${VAR} env-var interpolation on string leaves
        // below so existing configs that relied on the previous simple parser
        // keep working.
        const parsed = YAML.parse(raw);
        fileConfig = (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          ? parsed as Record<string, unknown>
          : {};
      }
      fileConfig = expandEnvVars(fileConfig) as Record<string, unknown>;
    } catch {
      // Config file is optional — malformed files fall back to env-only config.
    }
  }

  // Server config
  const serverConfig = obj(fileConfig, "server");
  const port = envInt("TDAI_GATEWAY_PORT") ?? num(serverConfig, "port") ?? 8420;
  const host = env("TDAI_GATEWAY_HOST") ?? str(serverConfig, "host") ?? "127.0.0.1";

  // Data config (expand leading ~ to $HOME so Node.js fs/path can resolve it)
  const dataConfig = obj(fileConfig, "data");
  const rawBaseDir = env("TDAI_DATA_DIR") ?? str(dataConfig, "baseDir") ?? resolveDefaultDataDir();
  const home = getEnv("HOME") ?? getEnv("USERPROFILE") ?? "/tmp";
  const baseDir = rawBaseDir.startsWith("~/") ? path.join(home, rawBaseDir.slice(2)) : rawBaseDir;

  // LLM config
  const llmConfig = obj(fileConfig, "llm");
  const llm: StandaloneLLMConfig = {
    baseUrl: env("TDAI_LLM_BASE_URL") ?? str(llmConfig, "baseUrl") ?? "https://api.openai.com/v1",
    apiKey: env("TDAI_LLM_API_KEY") ?? str(llmConfig, "apiKey") ?? "",
    model: env("TDAI_LLM_MODEL") ?? str(llmConfig, "model") ?? "gpt-4o",
    maxTokens: envInt("TDAI_LLM_MAX_TOKENS") ?? num(llmConfig, "maxTokens") ?? 4096,
    timeoutMs: envInt("TDAI_LLM_TIMEOUT_MS") ?? num(llmConfig, "timeoutMs") ?? 120_000,
  };

  // Memory config (reuse the plugin's parseConfig for full compatibility)
  const memoryRaw = obj(fileConfig, "memory");
  const memory = parseMemoryConfig(memoryRaw as Record<string, unknown> | undefined);

  const config: GatewayConfig = {
    server: { port, host },
    data: { baseDir },
    llm,
    memory,
    ...overrides,
  };

  return config;
}

// ============================
// Helpers
// ============================

function resolveConfigPath(): string | null {
  // 1. Explicit env var
  const explicit = getEnv("TDAI_GATEWAY_CONFIG")?.trim();
  if (explicit && fs.existsSync(explicit)) return explicit;

  // 2. CWD
  for (const name of ["tdai-gateway.yaml", "tdai-gateway.json"]) {
    const p = path.join(process.cwd(), name);
    if (fs.existsSync(p)) return p;
  }

  // 3. Default data dir
  const dataDir = resolveDefaultDataDir();
  for (const name of ["tdai-gateway.yaml", "tdai-gateway.json"]) {
    const p = path.join(dataDir, name);
    if (fs.existsSync(p)) return p;
  }

  return null;
}

function resolveDefaultDataDir(): string {
  const home = getEnv("HOME") ?? getEnv("USERPROFILE") ?? "/tmp";

  // New canonical location: everything related to standalone/Hermes-mode TDAI
  // is collected under ~/.memory-tencentdb/ to avoid scattering top-level dirs
  // in $HOME. The Gateway data dir lives at:
  //
  //   ~/.memory-tencentdb/memory-tdai/
  //
  // Note: this only governs the standalone/Hermes fallback. Under the openclaw
  // host the plugin data dir is decided by `resolveStateDir() + "memory-tdai"`
  // (typically ~/.openclaw/memory-tdai/) which is intentionally NOT changed.
  const root = getEnv("MEMORY_TENCENTDB_ROOT") ?? path.join(home, ".memory-tencentdb");
  const newDefault = path.join(root, "memory-tdai");

  // Backward compatibility: if the new location does not yet exist but the
  // legacy ~/memory-tdai still has data, keep using the legacy dir so existing
  // users don't silently lose their memory store. The install script
  // (install_hermes_memory_tencentdb.sh, Step 0) will migrate it on next run.
  try {
    if (!fs.existsSync(newDefault)) {
      const legacy = path.join(home, "memory-tdai");
      if (fs.existsSync(legacy)) {
        // Stderr-only deprecation hint; doesn't pollute structured logs.
        process.stderr.write(
          `[tdai-gateway] DEPRECATED: using legacy data dir ${legacy}; ` +
          `move it to ${newDefault} (or set TDAI_DATA_DIR / MEMORY_TENCENTDB_ROOT) to silence this warning.\n`,
        );
        return legacy;
      }
    }
  } catch {
    // existsSync should not throw, but guard anyway.
  }

  return newDefault;
}

function env(key: string): string | undefined {
  const v = getEnv(key)?.trim();
  return v || undefined;
}

function envInt(key: string): number | undefined {
  const v = env(key);
  if (!v) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function obj(c: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = c[key];
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

function str(src: Record<string, unknown>, key: string): string | undefined {
  const v = src[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function num(src: Record<string, unknown>, key: string): number | undefined {
  const v = src[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Recursively replace ``${VAR_NAME}`` placeholders in string leaves with
 * the corresponding ``process.env`` value. Missing variables expand to an
 * empty string, matching the behaviour of the previous simple YAML parser
 * so existing configs keep working after the switch to the full YAML lib.
 *
 * - Only whole-string matches (``"${VAR}"``) are substituted, preserving
 *   types: numbers/booleans/null pass through unchanged.
 * - Arrays and nested objects are walked in-place (new arrays/objects are
 *   returned; the input is not mutated).
 */
function expandEnvVars(value: unknown): unknown {
  if (typeof value === "string") {
    const m = value.match(/^\$\{(\w+)\}$/);
    if (m) {
      return process.env[m[1]!] ?? "";
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(expandEnvVars);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandEnvVars(v);
    }
    return out;
  }
  return value;
}

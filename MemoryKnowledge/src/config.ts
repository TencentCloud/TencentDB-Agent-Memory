/**
 * Service configuration — environment variables + config loading.
 *
 * .env is auto-loaded via dotenv on import of this module.
 * All config is loaded from env vars with sensible defaults.
 * LLM config can also be passed explicitly to createKnowledgeModule.
 */
import { homedir } from "node:os";
import 'dotenv/config';

/** Expand leading ~/ to the user's home directory. */
function expandHome(filepath: string): string {
  if (filepath.startsWith("~/")) {
    return `${homedir()}${filepath.slice(1)}`;
  }
  return filepath;
}

export interface LlmConfig {
  /**
   * Global default routing when NO per-instance llm_binding exists:
   *   - 'proxy' (default): wiki ingest must go through context_proxy via a
   *     TMC-pushed binding. No silent direct fallback — if a binding is missing,
   *     ingest fails loudly (see resolveLlmConfig / createLlmClient).
   *   - 'custom': use the global baseUrl/apiKey below to call an OpenAI-compatible
   *     endpoint directly (BYO).
   * Per-instance bindings always override this default.
   */
  mode: "proxy" | "custom";
  /** LLM 协议：openai 走 /chat/completions，anthropic 走 /messages。默认 openai（向后兼容）。 */
  protocol: "openai" | "anthropic";
  provider: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  maxTokens: number;
  /** LLM request timeout in ms. Defaults to 1200000 (20min) — reasoning 模型需要更长时间。 */
  timeoutMs: number;
}

export interface ServiceConfig {
  /** HTTP server port. */
  port: number;
  /** Data root directory for knowledge assets (git clones, wiki dirs, SQLite). */
  dataDir: string;
  /** SQLite database file path. */
  dbPath: string;
  /** LLM configuration for wiki ingest. */
  llm: LlmConfig;
  /** Log level. */
  logLevel: string;
  /** API route prefix (default: /v3). */
  apiPrefix: string;
  /** Public base URL for service_url generation (e.g. http://10.2.3.4:8421). */
  publicBaseUrl: string;
  /** TMC callback URL for status notifications (empty = no callback). */
  tmcCallbackUrl: string;
  /**
   * Bearer token required on MCP streamable-HTTP requests (/mcp).
   * Empty string (default) disables auth — suitable for local/dev use only.
   * Set KNOWLEDGE_MCP_AUTH_TOKEN to enable.
   */
  mcpAuthToken: string;
}

function env(key: string, fallback: string): string {
  const val = process.env[key];
  return val !== undefined && val !== "" ? val : fallback;
}

function envInt(key: string, fallback: number): number {
  const val = process.env[key];
  if (val === undefined || val === "") return fallback;
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? fallback : n;
}

/**
 * Load service configuration from environment variables.
 */
export function loadConfig(): ServiceConfig {
  return {
    port: envInt("PORT", 8421),
    dataDir: expandHome(env("KNOWLEDGE_DATA_DIR", "./data")),
    dbPath: expandHome(env("KNOWLEDGE_DB_PATH", "./data/knowledge.db")),
    logLevel: env("LOG_LEVEL", "debug"),
    apiPrefix: env("API_PREFIX", "/v3"),
    publicBaseUrl: env("KNOWLEDGE_PUBLIC_BASE_URL", ""),
    tmcCallbackUrl: env("TMC_CALLBACK_URL", ""),
    mcpAuthToken: env("KNOWLEDGE_MCP_AUTH_TOKEN", ""),
    llm: {
      mode: env("LLM_MODE", "proxy") === "custom" ? "custom" : "proxy",
      protocol: env("LLM_PROTOCOL", "openai") === "anthropic" ? "anthropic" : "openai",
      provider: env("LLM_PROVIDER", "custom"),
      apiKey: env("LLM_API_KEY", ""),
      model: env("LLM_MODEL", "Memory-Model"),
      baseUrl: env("LLM_BASE_URL", ""),
      maxTokens: envInt("LLM_MAX_TOKENS", 32768),
      timeoutMs: envInt("LLM_TIMEOUT_MS", 1200000),
    },
  };
}

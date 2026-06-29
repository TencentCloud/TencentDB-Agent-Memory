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
import { normalizeDisableThinking } from "../utils/no-think-fetch.js";
import type { StandaloneLLMConfig } from "../adapters/standalone/llm-runner.js";

// ============================
// Gateway config types
// ============================

export interface GatewayConfig {
  server: {
    port: number;
    host: string;
    /**
     * Optional API token for HTTP authentication.
     *
     * When set (non-empty string), every route except `GET /health` and CORS
     * preflight (`OPTIONS *`) requires an `Authorization: Bearer <apiKey>`
     * header. Requests without a valid token receive HTTP 401.
     *
     * **Default: undefined** — authentication is disabled, all routes are
     * open (preserves legacy behaviour). A WARN is emitted at startup if the
     * gateway binds to a non-loopback host without an API key set, to avoid
     * silently exposing an unauthenticated endpoint to the network.
     *
     * env: `TDAI_GATEWAY_API_KEY`
     * yaml: `server.apiKey`
     */
    apiKey?: string;
    /**
     * Optional CORS allow-list.
     *
     * When empty (default), the gateway sends **no** `Access-Control-Allow-*`
     * headers and rejects CORS preflight (`OPTIONS`) with 403 if an `Origin`
     * header is present — browsers will then block all cross-origin requests
     * via same-origin policy.
     *
     * When set, each request's `Origin` is matched against this list and
     * `Access-Control-Allow-Origin` is echoed back only on match. Use the
     * single entry `"*"` to restore the legacy permissive behaviour (only
     * appropriate for local development).
     *
     * env: `TDAI_CORS_ORIGINS` (comma-separated)
     * yaml: `server.corsOrigins` (string[])
     */
    corsOrigins: string[];
  };
  data: {
    /** Base directory for TDAI data storage. */
    baseDir: string;
    /**
     * Multi-tenant mode. When `true`, one Gateway process safely serves many
     * end-user accounts: each `session_key` is routed to its own `TdaiCore`
     * with a dedicated dataDir under `baseDir/{account}` (structural isolation
     * — see design §8.4). When `false` (default), the Gateway behaves exactly
     * as before: a single shared core rooted at `baseDir`, `session_key` only
     * isolates L0/pipeline state.
     *
     * In multi-tenant mode `session_key` becomes **required** on every routed
     * endpoint (`/recall`, `/capture`, `/search/*`, `/session/end`).
     *
     * env: `TDAI_MULTI_TENANT`
     * yaml: `data.multiTenant`
     */
    multiTenant: boolean;
    /**
     * Max concurrent background extraction runs (L1/L2/L3) across ALL per-account
     * cores. Structural multi-tenant gives each account its own pipeline, so `N`
     * active accounts otherwise fan out to up to `~3N` simultaneous LLM
     * extraction calls (design §8.4 #5). One shared limiter caps the total.
     *
     * - `> 0` — hard cap.
     * - `0`   — unbounded.
     * - unset — multi-tenant defaults to a safe internal cap; single-tenant
     *   stays unbounded (a lone core can't fan out).
     *
     * env: `TDAI_MAX_CONCURRENT_EXTRACTIONS`
     * yaml: `data.maxConcurrentExtractions`
     */
    maxConcurrentExtractions?: number;
    /**
     * Max number of per-account cores kept resident at once (multi-tenant LRU
     * eviction). When a request would exceed this, the least-recently-used idle
     * core is flushed + torn down to bound process memory. Must exceed the peak
     * number of concurrently active accounts.
     *
     * - `> 0` — keep at most this many cores warm.
     * - `0` / unset — unlimited (legacy: every account stays warm forever).
     *
     * Ignored in single-tenant mode.
     *
     * env: `TDAI_MAX_RESIDENT_CORES`
     * yaml: `data.maxResidentCores`
     */
    maxResidentCores?: number;
    /**
     * Idle time-to-live (ms) for resident per-account cores (multi-tenant). A
     * periodic sweep evicts any idle (unpinned) core whose last request was
     * longer ago than this, reclaiming long-tail accounts during quiet periods
     * instead of waiting for an LRU push. Complements `maxResidentCores` (a count
     * bound) with a time bound.
     *
     * - `> 0` — evict cores idle longer than this.
     * - `0` / unset — disabled (default). Ignored in single-tenant mode.
     *
     * env: `TDAI_CORE_IDLE_TTL_MS`
     * yaml: `data.coreIdleTtlMs`
     */
    coreIdleTtlMs?: number;
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

  // Optional auth / CORS — both default to "disabled" so existing setups keep
  // working unchanged. When unset the gateway behaves exactly like before this
  // change (open v1 routes, permissive CORS *will not* be re-introduced — see
  // resolveCorsOrigins below: empty list means "send no CORS headers").
  const apiKey = env("TDAI_GATEWAY_API_KEY") ?? str(serverConfig, "apiKey");
  const corsOrigins = resolveCorsOrigins(serverConfig);

  // Data config (expand leading ~ to $HOME so Node.js fs/path can resolve it)
  const dataConfig = obj(fileConfig, "data");
  const rawBaseDir = env("TDAI_DATA_DIR") ?? str(dataConfig, "baseDir") ?? resolveDefaultDataDir();
  const home = getEnv("HOME") ?? getEnv("USERPROFILE") ?? "/tmp";
  const baseDir = rawBaseDir.startsWith("~/") ? path.join(home, rawBaseDir.slice(2)) : rawBaseDir;
  const multiTenant = envBool("TDAI_MULTI_TENANT") ?? bool(dataConfig, "multiTenant") ?? true;
  const maxConcurrentExtractions =
    envInt("TDAI_MAX_CONCURRENT_EXTRACTIONS") ?? num(dataConfig, "maxConcurrentExtractions");
  const maxResidentCores =
    envInt("TDAI_MAX_RESIDENT_CORES") ?? num(dataConfig, "maxResidentCores");
  const coreIdleTtlMs =
    envInt("TDAI_CORE_IDLE_TTL_MS") ?? num(dataConfig, "coreIdleTtlMs");

  // LLM config
  const llmConfig = obj(fileConfig, "llm");
  const llm: StandaloneLLMConfig = {
    baseUrl: env("TDAI_LLM_BASE_URL") ?? str(llmConfig, "baseUrl") ?? "https://api.openai.com/v1",
    apiKey: env("TDAI_LLM_API_KEY") ?? str(llmConfig, "apiKey") ?? "",
    model: env("TDAI_LLM_MODEL") ?? str(llmConfig, "model") ?? "gpt-4o",
    maxTokens: envInt("TDAI_LLM_MAX_TOKENS") ?? num(llmConfig, "maxTokens") ?? 4096,
    timeoutMs: envInt("TDAI_LLM_TIMEOUT_MS") ?? num(llmConfig, "timeoutMs") ?? 120_000,
    disableThinking: normalizeDisableThinking(
      envBoolOrStr("TDAI_LLM_DISABLE_THINKING") ?? boolOrStr(llmConfig, "disableThinking")
    ),
  };

  // Memory config (reuse the plugin's parseConfig for full compatibility)
  const memoryRaw = obj(fileConfig, "memory");
  const memory = parseMemoryConfig(memoryRaw as Record<string, unknown> | undefined);

  const base: GatewayConfig = {
    server: { port, host, apiKey, corsOrigins },
    data: { baseDir, multiTenant, maxConcurrentExtractions, maxResidentCores, coreIdleTtlMs },
    llm,
    memory,
  };

  // Merge overrides one level deep so partial `server`/`data`/`llm` patches
  // (frequently used by e2e tests) don't accidentally drop sibling fields
  // such as `corsOrigins` introduced after they were written.
  const effective: GatewayConfig = overrides
    ? {
        ...base,
        ...overrides,
        server: { ...base.server, ...(overrides.server ?? {}) },
        data: { ...base.data, ...(overrides.data ?? {}) },
        llm: { ...base.llm, ...(overrides.llm ?? {}) },
      }
    : base;

  // Fail fast on the one config combo that silently breaks tenant isolation.
  //
  // Multi-tenant isolation in this fork is *structural*: each account gets its
  // own dataDir + its own SQLite file (distinct L0/L1 tables, persona.md, …).
  // The TCVDB backend ignores dataDir and routes EVERY core to one shared
  // `${database}_l1_memories` / `_l0_conversations` / `_profiles` collection
  // set (see core/store/factory.ts + tcvdb.ts), while the structural route does
  // not push `session_key` into L1/L0 search — so `/recall` and
  // `/search/memories` would return other accounts' memories. Refuse at load
  // time rather than leak across tenants. (Single-tenant + TCVDB is fine: one
  // shared core, one database, no cross-account routing.)
  if (effective.data.multiTenant && effective.memory.storeBackend === "tcvdb") {
    throw new Error(
      "Multi-tenant mode is incompatible with storeBackend=tcvdb: every per-account " +
      "core shares one TCVDB database/collection set, so L1/L0 recall and search would " +
      "leak across accounts (structural isolation only holds for the per-dataDir SQLite " +
      "backend). Use storeBackend=sqlite for multi-tenant, or run single-tenant " +
      "(TDAI_MULTI_TENANT=false) with TCVDB.",
    );
  }
  return effective;
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

/**
 * Read a strict boolean env var. Accepts true/1/yes/on and false/0/no/off
 * (case-insensitive); anything else (including unset) returns undefined so the
 * caller can fall through to the next source / default.
 */
function envBool(key: string): boolean | undefined {
  const v = env(key);
  if (v === undefined) return undefined;
  const s = v.toLowerCase();
  if (s === "true" || s === "1" || s === "yes" || s === "on") return true;
  if (s === "false" || s === "0" || s === "no" || s === "off") return false;
  return undefined;
}

/** Read a boolean field from a config object (non-boolean → undefined). */
function bool(src: Record<string, unknown>, key: string): boolean | undefined {
  const v = src[key];
  return typeof v === "boolean" ? v : undefined;
}

/**
 * Read an env var that may be a boolean ("true"/"false"/"1"/"0")
 * or a plain string (strategy name like "deepseek", "anthropic").
 * Returns the lowercase string for strategy names.
 */
function envBoolOrStr(key: string): boolean | string | undefined {
  const raw = env(key);
  if (raw === undefined) return undefined;
  const v = raw.toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return v; // lowercase strategy name
}

/** Read a field that may be boolean or string from a config object. */
function boolOrStr(src: Record<string, unknown>, key: string): boolean | string | undefined {
  const v = src[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "string" && v.trim()) return v.trim();
  return undefined;
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
 * Read `server.corsOrigins` from yaml or `TDAI_CORS_ORIGINS` from env.
 *
 * Accepted yaml shapes (yaml has precedence over env):
 *   server:
 *     corsOrigins: []                              # explicit empty → no CORS
 *     corsOrigins: ["https://app.example.com"]     # array of allowed origins
 *     corsOrigins: "https://a,https://b"           # comma-separated string
 *
 * Env: `TDAI_CORS_ORIGINS="https://a,https://b"`
 *
 * Returns `[]` when nothing is set — the server interprets that as
 * "do not emit any CORS headers" (most restrictive default).
 */
function resolveCorsOrigins(serverConfig: Record<string, unknown>): string[] {
  // 1. YAML takes precedence so an explicit `corsOrigins: []` can mean
  //    "I want CORS off" even when the env var leaks in from the shell.
  const raw = serverConfig["corsOrigins"];
  if (Array.isArray(raw)) {
    return raw.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map(s => s.trim());
  }
  if (typeof raw === "string" && raw.trim()) {
    return raw.split(",").map(s => s.trim()).filter(Boolean);
  }

  // 2. Fall back to env. Empty string from env is treated as "not set".
  const envValue = env("TDAI_CORS_ORIGINS");
  if (!envValue) return [];
  return envValue.split(",").map(s => s.trim()).filter(Boolean);
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
